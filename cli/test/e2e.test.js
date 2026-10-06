/**
 * End to end: a real registry server (PGlite + local storage + fake Discord/GitHub)
 * on a local port, driven through the beepm CLI the way a user would.
 */
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { after, before, test } from "node:test"
import { buildApp } from "@beepm/server/src/app.js"
import { loadConfig } from "@beepm/server/src/config.js"
import { createPgliteDb } from "@beepm/server/src/db/index.js"
import { migrate } from "@beepm/server/src/db/migrate.js"
import { createLocalStorage } from "@beepm/server/src/storage/local.js"
import { run } from "../src/main.js"

let dir, app, db, registry
const profiles = new Map()

async function freePort() {
    const server = net.createServer()
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
    const { port } = server.address()
    await new Promise((resolve) => server.close(resolve))
    return port
}

before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "beepm-e2e-"))
    const port = await freePort()
    registry = `http://127.0.0.1:${port}`
    const config = loadConfig({
        PUBLIC_URL: registry,
        LOCAL_STORAGE_DIR: path.join(dir, "storage"),
    })
    db = await createPgliteDb(null)
    await migrate(db)
    const provider = {
        id: "github",
        label: "GitHub",
        authorizeUrl: ({ state }) => `https://github.example/authorize?state=${state}`,
        fetchProfile: async ({ code }) => profiles.get(code),
    }
    app = await buildApp({
        config,
        db,
        storage: createLocalStorage({ dir: config.storage.dir, publicUrl: registry }),
        providers: { github: provider },
        logger: false,
    })
    await app.listen({ port, host: "127.0.0.1" })

    Object.assign(process.env, {
        BEEPM_HOME: path.join(dir, "home"),
        BEE2_CONFIG_DIR: path.join(dir, "bee2"),
        BEEPM_REGISTRY: registry,
        BEEPM_NO_BROWSER: "1",
        BEEPM_NO_CLOSE_BEE2: "1",
        NO_COLOR: "1",
    })
})

after(async () => {
    await app.close()
    await db.close()
    await rm(dir, { recursive: true, force: true })
})

/** Runs `beepm ...args` and captures what it prints. */
async function beepm(...args) {
    const out = []
    const original = { log: console.log, error: console.error }
    // eslint-disable-next-line no-control-regex
    const plain = (parts) => parts.join(" ").replace(/\x1b\[[0-9;]*m/g, "")
    console.log = (...parts) => out.push(plain(parts))
    console.error = (...parts) => out.push(plain(parts))
    try {
        const code = await run(["node", "beepm", ...args])
        return { code, out: out.join("\n") }
    } finally {
        Object.assign(console, original)
    }
}

/** Plays the browser's part of the login: open the link, "log in" on GitHub, create the account. */
async function browserLogin(url, code, handle) {
    const first = await fetch(url, { redirect: "manual" })
    const cookie = first.headers.get("set-cookie").split(";")[0]
    const start = await fetch(`${url}/start/github`, { headers: { cookie }, redirect: "manual" })
    const state = new URL(start.headers.get("location")).searchParams.get("state")
    const callback = await fetch(`${registry}/oauth/github/callback?code=${code}&state=${state}`, {
        headers: { cookie },
    })
    const page = await callback.text()
    const csrf = /name="csrf" value="([^"]+)"/.exec(page)[1]
    const res = await fetch(`${url}/claim`, {
        method: "POST",
        headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ csrf, handle }),
    })
    assert.equal(res.status, 200)
}

async function writePackage(folder, { id, manifest, extra = {} }) {
    const files = {
        "info.txt": `"ID" "${id}"\n"Name" "${manifest.display_name ?? id}"\n`,
        "bee-package.json": JSON.stringify(manifest, null, 4),
        "items/thing/editoritems.txt": '"Item" {}',
        ...extra,
    }
    for (const [name, content] of Object.entries(files)) {
        await mkdir(path.dirname(path.join(folder, name)), { recursive: true })
        await writeFile(path.join(folder, name), content)
    }
    return folder
}

test("login, publish, install, update, uninstall through the CLI", async () => {
    // Log in: the CLI prints the URL and waits while "the browser" finishes
    profiles.set("gh-maker", {
        provider: "github",
        providerId: "99",
        username: "Maker",
        displayName: "Maker",
        avatarUrl: null,
        accountCreatedAt: "2019-01-01T00:00:00Z",
    })
    const login = beepm("login")
    let url = null
    for (let i = 0; i < 100 && !url; i++) {
        await new Promise((r) => setTimeout(r, 50))
        const credentials = path.join(process.env.BEEPM_HOME, "config", "credentials.json")
        url = await readFile(credentials).then(
            () => "done",
            () => null,
        )
        if (!url) {
            const sessions = await db.query(
                "SELECT id FROM auth_sessions WHERE status = 'pending' ORDER BY created_at DESC LIMIT 1",
            )
            if (sessions.rows.length) url = `${registry}/login/${sessions.rows[0].id}`
        }
    }
    await browserLogin(url, "gh-maker", "maker")
    const loggedIn = await login
    assert.equal(loggedIn.code, 0, loggedIn.out)
    assert.match(loggedIn.out, /Logged in as @maker/)
    assert.match((await beepm("whoami")).out, /@maker/)

    // Publish a library and a package that depends on it
    const lib = await writePackage(path.join(dir, "lib"), {
        id: "MAKER_LIB",
        manifest: { name: "lib", version: "1.0.0", compatibleWith: ">=2.4.40" },
        extra: { "notes.md": "left out", ".git/HEAD": "ref" },
    })
    const dry = await beepm("publish", lib, "--dry-run")
    assert.equal(dry.code, 0, dry.out)
    assert.match(dry.out, /@maker\/lib@1\.0\.0/)
    assert.match(dry.out, /notes\.md/)

    const notAgreed = await beepm("publish", lib)
    assert.equal(notAgreed.code, 1)
    assert.match(notAgreed.out, /By publishing, you agree that/)
    assert.match(notAgreed.out, /Not published/)

    const published = await beepm("publish", lib, "--yes")
    assert.equal(published.code, 0, published.out)
    assert.match(published.out, /Published @maker\/lib@1\.0\.0 \(new package\)/)

    const app1 = await writePackage(path.join(dir, "app"), {
        id: "MAKER_APP",
        manifest: {
            name: "app",
            version: "1.0.0",
            dependencies: { "@maker/lib": "^1.0.0", "@beemod/BEE2_CLEAN_STYLE": "*" },
        },
    })
    assert.equal((await beepm("publish", app1, "--yes")).code, 0)
    assert.match((await beepm("search", "maker")).out, /@maker\/app/)
    assert.match((await beepm("info", "app")).out, /BEE2 ID: MAKER_APP/)

    // Install by bare name: the dependency comes along, checked against its SHA-256
    const installed = await beepm("install", "app")
    assert.equal(installed.code, 0, installed.out)
    assert.match(installed.out, /Installed @maker\/lib@1\.0\.0/)
    assert.match(installed.out, /Installed @maker\/app@1\.0\.0/)
    const packages = path.join(process.env.BEEPM_HOME, "packages")
    const onDisk = await readFile(path.join(packages, "maker@app.bee_pack"))
    assert.ok(onDisk.length > 0)
    assert.match((await beepm("list")).out, /@maker\/lib\s+1\.0\.0\s+dependency/)

    // A new library version shows up as outdated, then update installs it
    await writeFile(
        path.join(lib, "bee-package.json"),
        JSON.stringify({ name: "lib", version: "1.1.0" }),
    )
    assert.equal((await beepm("publish", lib, "--yes")).code, 0)
    assert.match((await beepm("outdated")).out, /@maker\/lib\s+1\.0\.0\s+1\.1\.0/)
    const updated = await beepm("update")
    assert.equal(updated.code, 0, updated.out)
    assert.match(updated.out, /Installed @maker\/lib@1\.1\.0/)

    // Yanking hides it from new installs
    assert.equal((await beepm("yank", "@maker/lib@1.1.0", "--reason", "broken")).code, 0)
    assert.match((await beepm("info", "@maker/lib")).out, /yanked: broken/)

    // Uninstalling a dependency someone needs is refused; uninstalling the app removes both
    const refused = await beepm("uninstall", "@maker/lib")
    assert.equal(refused.code, 1)
    assert.match(refused.out, /needed by @maker\/app/)
    const removed = await beepm("uninstall", "app")
    assert.equal(removed.code, 0)
    assert.match(removed.out, /Uninstalled @maker\/lib/)
    assert.match((await beepm("list")).out, /No packages are installed/)
})

test("hook, status and unhook edit BEE2's config", async () => {
    await mkdir(process.env.BEE2_CONFIG_DIR, { recursive: true })
    const cfg = path.join(process.env.BEE2_CONFIG_DIR, "config.cfg")
    await writeFile(cfg, "[Directories]\npackage = ../packages/\n")
    assert.match((await beepm("hook")).out, /Hooked BEE2 to BeePM/)
    assert.match((await beepm("status")).out, /Hooked:\s+yes/)
    assert.match((await beepm("unhook")).out, /BEE2 uses \.\.\/packages\/ again/)
    assert.equal(await readFile(cfg, "utf8"), "[Directories]\npackage = ../packages/\n")
})

test("new writes bee-package.json from info.txt", async () => {
    const folder = path.join(dir, "fresh")
    await mkdir(folder, { recursive: true })
    await writeFile(
        path.join(folder, "info.txt"),
        '"ID" "FRESH_ITEMS"\n"Name" "Fresh Items"\n"Prerequisites" { "Package" "BEE2_CLEAN_STYLE" }\n',
    )
    const res = await beepm("new", folder, "--yes")
    assert.equal(res.code, 0, res.out)
    const manifest = JSON.parse(await readFile(path.join(folder, "bee-package.json"), "utf8"))
    assert.equal(manifest.name, "@maker/fresh-items")
    assert.deepEqual(manifest.dependencies, { "@beemod/BEE2_CLEAN_STYLE": "*" })
    assert.equal((await beepm("publish", folder, "--dry-run")).code, 0)
})

test("new adds bee-package.json inside a .bee_pack", async () => {
    const { default: yazl } = await import("yazl")
    const { createWriteStream } = await import("node:fs")
    const { pipeline } = await import("node:stream/promises")
    const file = path.join(dir, "zipped.bee_pack")
    const zip = new yazl.ZipFile()
    const written = pipeline(zip.outputStream, createWriteStream(file))
    zip.addBuffer(Buffer.from('"ID" "ZIPPED_ITEMS"\n"Name" "Zipped Items"\n'), "info.txt")
    zip.addBuffer(Buffer.from('"Item" {}'), "items/zipped/editoritems.txt")
    zip.end()
    await written

    const res = await beepm("new", file, "--yes")
    assert.equal(res.code, 0, res.out)
    assert.match(res.out, /Added bee-package.json to zipped.bee_pack/)
    const dry = await beepm("publish", file, "--dry-run")
    assert.equal(dry.code, 0, dry.out)
    assert.match(dry.out, /@maker\/zipped-items@1\.0\.0/)
    assert.equal((await beepm("new", file, "--yes")).code, 1) // already there without --force
})

test("logout revokes the token", async () => {
    assert.equal((await beepm("logout")).code, 0)
    const after = await beepm("whoami")
    assert.equal(after.code, 1)
    assert.match(after.out, /not logged in/)
})

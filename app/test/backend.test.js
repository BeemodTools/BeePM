/**
 * The desktop app's main-process backend against a real local registry (PGlite + local storage
 * + the test-account login), without Electron: the browser's part of the login is played with
 * fetch, the way someone clicking through the pages would.
 */
import assert from "node:assert/strict"
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { after, before, test } from "node:test"
import { buildApp } from "@beepm/server/src/app.js"
import { createProviders } from "@beepm/server/src/auth/providers.js"
import { loadConfig } from "@beepm/server/src/config.js"
import { createPgliteDb } from "@beepm/server/src/db/index.js"
import { migrate } from "@beepm/server/src/db/migrate.js"
import { createLocalStorage } from "@beepm/server/src/storage/local.js"
import { createBackend } from "../backend/backend.js"
import { Logger } from "../backend/logger.js"
import { isLocalPath } from "../backend/util.js"

// Hooking closes BEE2; a test must never close the real one
process.env.BEEPM_NO_CLOSE_BEE2 = "1"

let dir, server, db, registry, env
// GitHub API answers by URL, for the registry (it looks GitHub up for the app)
const githubApi = new Map()

async function freePort() {
    const probe = net.createServer()
    await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve))
    const { port } = probe.address()
    await new Promise((resolve) => probe.close(resolve))
    return port
}

before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "beepm-app-test-"))
    const port = await freePort()
    registry = `http://127.0.0.1:${port}`
    const config = loadConfig({
        PUBLIC_URL: registry,
        LOCAL_STORAGE_DIR: path.join(dir, "storage"),
    })
    db = await createPgliteDb(null)
    await migrate(db)
    server = await buildApp({
        config,
        db,
        storage: createLocalStorage({ dir: config.storage.dir, publicUrl: registry }),
        providers: createProviders({}, fetch, { devLogin: true, publicUrl: registry }),
        fetch: async (url, init) => {
            const reply = githubApi.get(String(url))
            if (reply) return new Response(JSON.stringify(reply))
            if (String(url).startsWith("https://")) return new Response("{}", { status: 404 })
            return fetch(url, init)
        },
        logger: false,
    })
    await server.listen({ port, host: "127.0.0.1" })
    env = {
        BEEPM_HOME: path.join(dir, "home"),
        BEE2_CONFIG_DIR: path.join(dir, "bee2"),
        BEEPM_REGISTRY: registry,
    }
})

after(async () => {
    await server.close()
    await db.close()
    await rm(dir, { recursive: true, force: true })
})

/**
 * A backend like the one main.js creates, with Electron's parts replaced by recorders.
 * fetch: a stand-in for the network (e.g. to play GitHub); log: a Logger.
 */
async function startBackend({ fetch, log } = {}) {
    const opened = []
    const events = []
    const backend = await createBackend({
        env,
        fetch,
        log,
        appVersion: "1.0.0-test",
        openExternal: async (url) => opened.push(url),
        send: (channel, payload) => events.push({ channel, payload }),
    })
    const nextEvent = async (channel, timeoutMs = 15000) => {
        const deadline = Date.now() + timeoutMs
        while (Date.now() < deadline) {
            const index = events.findIndex((e) => e.channel === channel)
            if (index >= 0) return events.splice(index, 1)[0].payload
            await new Promise((resolve) => setTimeout(resolve, 50))
        }
        throw new Error(`No ${channel} event`)
    }
    return { backend, opened, events, nextEvent }
}

/** Plays the browser: open the login link, pick a test account, create the account. */
async function finishInBrowser(url, username, handle) {
    const first = await fetch(url, { redirect: "manual" })
    assert.equal(first.status, 200)
    const cookie = first.headers.get("set-cookie").split(";")[0]
    const start = await fetch(`${url}/start/dev`, { headers: { cookie }, redirect: "manual" })
    const state = new URL(start.headers.get("location")).searchParams.get("state")
    const page = await fetch(
        `${registry}/oauth/dev/callback?state=${encodeURIComponent(state)}&code=${encodeURIComponent(username)}`,
        { headers: { cookie } },
    ).then((res) => res.text())
    const csrf = /name="csrf" value="([^"]+)"/.exec(page)[1]
    const res = await fetch(`${url}/claim`, {
        method: "POST",
        headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ csrf, handle }),
    })
    assert.equal(res.status, 200)
}

test("logging in from the app: browser login, saved login, logout", async () => {
    const { backend, opened, nextEvent } = await startBackend()
    assert.deepEqual(await backend.invoke("auth:status"), { ok: true, loggedIn: false })

    const started = await backend.invoke("auth:login")
    assert.equal(started.ok, true, started.error)
    assert.match(started.confirmCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
    assert.deepEqual(opened, [started.url]) // the system browser was asked to open the login page

    await finishInBrowser(started.url, "AppTester", "app-tester")
    const result = await nextEvent("auth:login-result")
    assert.equal(result.ok, true, result.error)
    assert.equal(result.user.handle, "app-tester")

    const status = await backend.invoke("auth:status")
    assert.equal(status.loggedIn, true)
    assert.equal(status.user.handle, "app-tester")
    assert.equal(status.canPublish, true)
    assert.deepEqual(
        status.identities.map((i) => i.provider),
        ["dev"],
    )

    // The login survives a restart of the app
    const restarted = await startBackend()
    assert.equal((await restarted.backend.invoke("auth:status")).user.handle, "app-tester")

    // Logging out revokes the token on the registry and forgets it
    const out = await restarted.backend.invoke("auth:logout")
    assert.deepEqual(out, { ok: true, revoked: true })
    assert.deepEqual(await restarted.backend.invoke("auth:status"), { ok: true, loggedIn: false })
    await assert.rejects(access(path.join(env.BEEPM_HOME, "config", "credentials-app.json")))
})

test("cancelling a login in the browser reaches the app", async () => {
    const { backend, nextEvent } = await startBackend()
    const started = await backend.invoke("auth:login")
    const first = await fetch(started.url, { redirect: "manual" })
    const cookie = first.headers.get("set-cookie").split(";")[0]
    const page = await first.text()
    const csrf = /name="csrf" value="([^"]+)"/.exec(page)[1]
    await fetch(`${started.url}/deny`, {
        method: "POST",
        headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ csrf }),
    })
    const result = await nextEvent("auth:login-result")
    assert.equal(result.ok, false)
    assert.equal(result.reason, "denied")
    assert.equal((await backend.invoke("auth:status")).loggedIn, false)
})

test("publish from a folder, find it, install it, uninstall it", async () => {
    const log = new Logger()
    log.initialize({ dir: path.join(dir, "logs"), captureConsole: false, echo: false })
    const { backend, nextEvent, events } = await startBackend({ log })
    const started = await backend.invoke("auth:login")
    await finishInBrowser(started.url, "Maker", "maker")
    assert.equal((await nextEvent("auth:login-result")).ok, true)

    const folder = path.join(dir, "my-items")
    await mkdir(path.join(folder, "items"), { recursive: true })
    await writeFile(path.join(folder, "info.txt"), '"ID" "MAKER_ITEMS"\n"Name" "Maker Items"\n')
    await writeFile(path.join(folder, "items", "editoritems.txt"), '"Item" {}')
    await writeFile(path.join(folder, "notes.md"), "left out")
    await writeFile(
        path.join(folder, "bee-package.json"),
        JSON.stringify({ name: "maker-items", version: "1.0.0", display_name: "Maker Items" }),
    )

    const prepared = await backend.invoke("publish:prepare", folder)
    assert.equal(prepared.ok, true, prepared.error)
    assert.equal(prepared.manifest.fullName, "@maker/maker-items")
    assert.equal(prepared.beeId, "MAKER_ITEMS")

    const published = await backend.invoke("publish:upload", prepared.id)
    assert.equal(published.ok, true, published.error)
    assert.ok(events.some((e) => e.channel === "publish:progress"))

    const found = await backend.invoke("registry:search", "maker")
    assert.deepEqual(
        found.packages.map((p) => p.name),
        ["@maker/maker-items"],
    )

    const plan = await backend.invoke("packages:plan", ["@maker/maker-items"])
    assert.equal(plan.ok, true, plan.error)
    assert.deepEqual(
        plan.steps.map((s) => `${s.name}@${s.to}`),
        ["@maker/maker-items@1.0.0"],
    )
    const applied = await backend.invoke("packages:apply", plan.planId)
    assert.equal(applied.ok, true, applied.error)
    await access(path.join(env.BEEPM_HOME, "packages", "maker@maker-items.bee_pack"))
    assert.ok(Object.keys((await backend.invoke("packages:installed")).packages).length === 1)

    const removed = await backend.invoke("packages:uninstall", ["@maker/maker-items"])
    assert.equal(removed.ok, true, removed.error)
    await assert.rejects(
        access(path.join(env.BEEPM_HOME, "packages", "maker@maker-items.bee_pack")),
    )
    const again = await backend.invoke("packages:uninstall", ["@maker/maker-items"])
    assert.equal(again.ok, false)

    // Each change is a step in the log, with how it ended
    await log.close()
    const text = await readFile(log.getLogFilePath(), "utf8")
    for (const line of [
        "Login started in the browser",
        "Logged in as @maker",
        "Checking my-items",
        "├─ @maker/maker-items@1.0.0, 1 KB",
        "[✓] Publishing @maker/maker-items@1.0.0 in ",
        "Installing @maker/maker-items@1.0.0",
        "├─ @maker/maker-items@1.0.0, 1 KB",
        "Uninstalling @maker/maker-items",
        "├─ Removed @maker/maker-items",
        "[✗] Uninstalling @maker/maker-items failed after ",
    ]) {
        assert.ok(text.includes(line), `The log has no "${line}":\n${text}`)
    }
})

test("account settings: nickname and profile picture", async () => {
    const { backend, nextEvent } = await startBackend()
    const started = await backend.invoke("auth:login")
    await finishInBrowser(started.url, "Settler", "settler")
    assert.equal((await nextEvent("auth:login-result")).ok, true)

    const renamed = await backend.invoke("auth:update-profile", {
        displayName: "  Settler Supreme ",
    })
    assert.equal(renamed.ok, true, renamed.error)
    assert.equal(renamed.user.displayName, "Settler Supreme")
    assert.equal((await backend.invoke("auth:status")).user.displayName, "Settler Supreme")

    const tooLong = await backend.invoke("auth:update-profile", { displayName: "x".repeat(51) })
    assert.equal(tooLong.ok, false)

    const noPicture = await backend.invoke("auth:update-profile", { avatar: "none" })
    assert.equal(noPicture.ok, true, noPicture.error)
    assert.equal(noPicture.avatarSource, "none")
    assert.equal(noPicture.user.avatarUrl, null)
})

test("a .bee_pack without bee-package.json gets one added inside it", async () => {
    const { default: yazl } = await import("yazl")
    const { createWriteStream } = await import("node:fs")
    const { readFile } = await import("node:fs/promises")
    const { pipeline } = await import("node:stream/promises")

    const { backend, nextEvent } = await startBackend()
    const started = await backend.invoke("auth:login")
    await finishInBrowser(started.url, "Zipper", "zipper")
    assert.equal((await nextEvent("auth:login-result")).ok, true)

    const file = path.join(dir, "zipped.bee_pack")
    const zip = new yazl.ZipFile()
    const written = pipeline(zip.outputStream, createWriteStream(file))
    zip.addBuffer(Buffer.from('"ID" "ZIPPER_ITEMS"\n"Name" "Zipper Items"\n'), "info.txt")
    zip.addBuffer(Buffer.from('"Item" {}'), "items/zipped/editoritems.txt")
    zip.end()
    await written
    const before = await readFile(file)

    const missing = await backend.invoke("publish:prepare", file)
    assert.equal(missing.ok, false)
    assert.equal(missing.manifestProblem, true)
    assert.equal(missing.isFolder, false)

    const suggested = await backend.invoke("publish:suggest-manifest", file)
    assert.equal(suggested.ok, true, suggested.error)
    assert.equal(suggested.isFolder, false)
    const saved = await backend.invoke("publish:write-manifest", file, suggested.manifest)
    assert.deepEqual(saved, { ok: true, file, insidePack: true })

    // The original entries come first, untouched; then it publishes like any other package
    const after = await readFile(file)
    assert.ok(after.length > before.length)
    const prepared = await backend.invoke("publish:prepare", file)
    assert.equal(prepared.ok, true, prepared.error)
    assert.equal(prepared.manifest.fullName, "@zipper/zipper-items")
    assert.equal(prepared.beeId, "ZIPPER_ITEMS")
    await backend.invoke("publish:discard", prepared.id)
})

/** A zip in memory: { "name": "text" }. */
async function zipBytes(files) {
    const { default: yazl } = await import("yazl")
    const zip = new yazl.ZipFile()
    for (const [name, content] of Object.entries(files)) zip.addBuffer(Buffer.from(content), name)
    zip.end()
    const chunks = []
    for await (const chunk of zip.outputStream) chunks.push(chunk)
    return Buffer.concat(chunks)
}

test("a GitHub release's .bee_pack is checked like a file before it's published", async () => {
    const info = '"ID" "RELEASED_ITEMS"\n"Name" "Released Items"\n'
    const good = await zipBytes({
        "info.txt": info,
        "items/released/editoritems.txt": '"Item" {}',
        "bee-package.json": JSON.stringify({ name: "released-items", version: "2.0.0" }),
    })
    const bare = await zipBytes({ "info.txt": info, "items/released/editoritems.txt": '"Item" {}' })

    // GitHub, played by stand-ins: the registry looks the release up, the app downloads the file
    githubApi.set("https://api.github.com/repos/maker/items", { private: false })
    githubApi.set("https://api.github.com/repos/maker/items/releases/tags/v2", {
        tag_name: "v2",
        assets: [
            {
                name: "items.bee_pack",
                size: good.length,
                browser_download_url: "https://dl.example/good",
            },
            {
                name: "bare.bee_pack",
                size: bare.length,
                browser_download_url: "https://dl.example/bare",
            },
            // Just replaced: GitHub still sends the old file for a while
            {
                name: "replaced.bee_pack",
                size: good.length - 100,
                browser_download_url: "https://dl.example/good",
            },
        ],
    })
    const githubFetch = async (url, init) => {
        const href = String(url)
        if (href === "https://dl.example/good") return new Response(good)
        if (href === "https://dl.example/bare") return new Response(bare)
        if (href.startsWith("https://")) return new Response("{}", { status: 404 })
        return fetch(url, init)
    }
    const { backend, nextEvent } = await startBackend({ fetch: githubFetch })
    const started = await backend.invoke("auth:login")
    await finishInBrowser(started.url, "Releaser", "releaser")
    assert.equal((await nextEvent("auth:login-result")).ok, true)

    const release = { owner: "maker", repo: "items", tag: "v2" }
    const missing = await backend.invoke("publish:prepare-github", {
        ...release,
        asset: "bare.bee_pack",
    })
    assert.equal(missing.ok, false)
    assert.equal(missing.code, "invalid_package")
    assert.equal(missing.manifestProblem, true)
    assert.ok(missing.problems.some((p) => p.startsWith("bee-package.json is missing")))

    const checked = await backend.invoke("publish:prepare-github", {
        ...release,
        asset: "items.bee_pack",
    })
    assert.equal(checked.ok, true, checked.error)
    assert.equal(checked.manifest.fullName, "@releaser/released-items")
    assert.equal(checked.manifest.version, "2.0.0")
    assert.deepEqual(checked.github, {
        ...release,
        asset: "items.bee_pack",
        fullName: "maker/items",
    })

    const unknown = await backend.invoke("publish:prepare-github", {
        ...release,
        asset: "nope.bee_pack",
    })
    assert.equal(unknown.ok, false)
    assert.match(unknown.error, /no \.bee_pack called nope\.bee_pack/)

    const replaced = await backend.invoke("publish:prepare-github", {
        ...release,
        asset: "replaced.bee_pack",
    })
    assert.equal(replaced.ok, false)
    assert.match(
        replaced.error,
        /^GitHub sent a different replaced\.bee_pack than release v2 lists/,
    )

    assert.equal((await backend.invoke("publish:discard", checked.id)).ok, true)
})

test("a package the registry would refuse stops at the check, before review", async () => {
    const { backend, nextEvent } = await startBackend()
    const started = await backend.invoke("auth:login")
    await finishInBrowser(started.url, "Checker", "checker")
    assert.equal((await nextEvent("auth:login-result")).ok, true)

    const folder = path.join(dir, "checked-items")
    await mkdir(path.join(folder, "items"), { recursive: true })
    await writeFile(path.join(folder, "info.txt"), '"ID" "CHECKED_ITEMS"\n"Name" "Checked Items"\n')
    await writeFile(path.join(folder, "items", "editoritems.txt"), '"Item" {}')
    const manifest = (name) =>
        writeFile(path.join(folder, "bee-package.json"), JSON.stringify({ name, version: "1.0.0" }))

    // Someone else's handle
    await manifest("@somebody-else/checked-items")
    const wrongHandle = await backend.invoke("publish:prepare", folder)
    assert.equal(wrongHandle.ok, false)
    assert.equal(wrongHandle.code, "invalid_package")
    assert.equal(wrongHandle.manifestProblem, true)
    assert.match(wrongHandle.problems[0], /only create packages under @checker/)

    // Fixed, it goes through; the same version again is refused at the check
    await manifest("checked-items")
    const fixed = await backend.invoke("publish:prepare", folder)
    assert.equal(fixed.ok, true, fixed.error)
    assert.equal((await backend.invoke("publish:upload", fixed.id)).ok, true)
    const again = await backend.invoke("publish:prepare", folder)
    assert.equal(again.ok, false)
    assert.match(again.problems[0], /checked-items@1\.0\.0 already exists/)

    // Creating bee-package.json for it again suggests the next version of the same package
    const suggested = await backend.invoke("publish:suggest-manifest", folder)
    assert.equal(suggested.manifest.name, "@checker/checked-items")
    assert.equal(suggested.manifest.version, "1.0.1")
    assert.deepEqual(suggested.published, { name: "@checker/checked-items", latest: "1.0.0" })
})

// A beepm:// link from any web page can name a file: a network path would make Windows connect
// to that host and send it the user's login
test(
    "network paths are never opened",
    { skip: process.platform !== "win32" && "Windows only" },
    async () => {
        assert.equal(isLocalPath("C:\\packages\\items.bee_pack"), true)
        for (const remote of [
            "\\\\127.0.0.1\\share\\items.bee_pack",
            "//127.0.0.1/share/items.bee_pack",
            "\\\\?\\UNC\\127.0.0.1\\share\\items.bee_pack",
        ]) {
            assert.equal(isLocalPath(remote), false, remote)
        }
        const { backend } = await startBackend()
        const res = await backend.invoke("publish:prepare", "\\\\127.0.0.1\\share\\items.bee_pack")
        assert.equal(res.ok, false)
        assert.equal(res.error, "Choose a file or folder on this PC.")
    },
)

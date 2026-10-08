/**
 * The desktop app's main-process backend against a real local registry (PGlite + local storage
 * + the test-account login), without Electron: the browser's part of the login is played with
 * fetch, the way someone clicking through the pages would.
 */
import assert from "node:assert/strict"
import { access, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises"
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
 * fetch: a stand-in for the network (e.g. to play GitHub); log: a Logger; bee2Process: a
 * stand-in BEE2 process; home: another BEEPM_HOME.
 */
async function startBackend({
    fetch,
    log,
    onSettingsChanged,
    bee2Process,
    home,
    ask,
    showReview,
    showContents,
    openProgram,
    openPath,
} = {}) {
    const opened = []
    const events = []
    const backend = await createBackend({
        env: home ? { ...env, BEEPM_HOME: home } : env,
        fetch,
        log,
        onSettingsChanged,
        bee2Process,
        ask,
        showReview,
        showContents,
        openProgram,
        openPath,
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
    assert.equal(res.status, 200, res.status === 200 ? "" : await res.text())
}

/** A BEE2 folder: BEE2.exe, a log that says its version, and a packages folder. */
async function fakeBee2(folder) {
    await mkdir(path.join(folder, "packages"), { recursive: true })
    await mkdir(path.join(folder, "logs"), { recursive: true })
    await writeFile(path.join(folder, "BEE2.exe"), "")
    await writeFile(
        path.join(folder, "logs", "bee2.log"),
        '[INFO] BEE2_launch.<module>(): Running "bee2", version 2.4.46.1 64-bit:\n',
    )
    return folder
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

    // Installing needs BEE2's folder: packages go in a "beepm" folder in its packages folder
    const unset = await backend.invoke("packages:plan", ["@maker/maker-items"])
    assert.equal(unset.code, "bee2_not_set")
    const bee2 = await fakeBee2(path.join(dir, "BEE2"))
    assert.equal((await backend.invoke("bee2:set-folder", bee2)).ok, true)
    const plan = await backend.invoke("packages:plan", ["@maker/maker-items"])
    assert.equal(plan.ok, true, plan.error)
    assert.deepEqual(
        plan.steps.map((s) => `${s.name}@${s.to}`),
        ["@maker/maker-items@1.0.0"],
    )
    const applied = await backend.invoke("packages:apply", plan.planId)
    assert.equal(applied.ok, true, applied.error)
    await access(path.join(bee2, "packages", "beepm", "maker@maker-items.bee_pack"))
    assert.ok(Object.keys((await backend.invoke("packages:installed")).packages).length === 1)

    const removed = await backend.invoke("packages:uninstall", ["@maker/maker-items"])
    assert.equal(removed.ok, true, removed.error)
    await assert.rejects(access(path.join(bee2, "packages", "beepm", "maker@maker-items.bee_pack")))
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

test("the BEE2 check: duplicates and packages that are on BeePM, fixed once BEE2 is closed", async () => {
    const bee2 = { running: false }
    const reviewed = [] // the checks a window to choose in was opened for
    const { backend, nextEvent } = await startBackend({
        home: path.join(dir, "check-home"),
        bee2Process: { isRunning: async () => bee2.running, findProgram: async () => null },
        ask: async (question) => (question.kind === "duplicates" ? "choose" : "later"),
        showReview: (reviewId) => reviewed.push(reviewId),
    })
    const started = await backend.invoke("auth:login")
    await finishInBrowser(started.url, "Sorter", "sorter")
    assert.equal((await nextEvent("auth:login-result")).ok, true)
    const published = path.join(dir, "sorter-items")
    await mkdir(published, { recursive: true })
    await writeFile(
        path.join(published, "info.txt"),
        '"ID" "SORTER_ITEMS"\n"Name" "Sorter Items"\n',
    )
    await writeFile(
        path.join(published, "bee-package.json"),
        JSON.stringify({ name: "sorter-items", version: "1.0.0" }),
    )
    const prepared = await backend.invoke("publish:prepare", published)
    assert.equal((await backend.invoke("publish:upload", prepared.id)).ok, true)

    // BEE2, with a package in it twice, and the user's own copy of the one on BeePM
    const folder = await fakeBee2(path.join(dir, "check-bee2", "BEE2"))
    const packages = path.join(folder, "packages")
    const zip = (id) => zipBytes({ "info.txt": `"ID" "${id}"\n"Name" "Twice"\n` })
    const older = path.join(packages, "twice_old.bee_pack")
    await writeFile(older, await zip("TWICE"))
    await utimes(older, new Date(Date.now() - 60000), new Date(Date.now() - 60000))
    await writeFile(path.join(packages, "twice.bee_pack"), await zip("TWICE"))
    await writeFile(path.join(packages, "sorter_own.bee_pack"), await zip("SORTER_ITEMS"))

    assert.equal((await backend.invoke("bee2:check")).code, "bee2_not_set")
    const chosen = await backend.invoke("bee2:set-folder", packages) // its packages folder will do
    assert.deepEqual(chosen, { ok: true, dir: folder, version: "2.4.46.1", moved: 0 })
    const status = await backend.invoke("bee2:status")
    assert.equal(status.packagesDir, path.join(packages, "beepm"))

    // The corner window's "Choose" shows the check its question came from, not a new one
    await backend.watcher.offer()
    assert.equal(reviewed.length, 1)
    const third = path.join(packages, "twice_third.bee_pack")
    await writeFile(third, await zip("TWICE"))
    const shown = await backend.invoke("bee2:check", { reviewId: reviewed[0] })
    assert.equal(shown.reviewId, reviewed[0])
    assert.equal(shown.duplicates.packages[0].copies.length, 2)
    assert.equal((await backend.invoke("bee2:check")).duplicates.packages[0].copies.length, 3)
    await rm(third)

    const check = await backend.invoke("bee2:check")
    assert.equal(check.ok, true, check.error)
    assert.deepEqual(
        check.duplicates.packages.map((g) => [g.id, g.copies.map((c) => c.file)]),
        [["TWICE", ["twice.bee_pack", "twice_old.bee_pack"]]],
    )
    assert.deepEqual(
        check.onBeepm.map((p) => [p.id, p.package, p.file]),
        [["SORTER_ITEMS", "@sorter/sorter-items", "sorter_own.bee_pack"]],
    )

    // BEE2 has the files open: the window offers to close it
    bee2.running = true
    const request = { reviewId: check.reviewId, adopt: ["SORTER_ITEMS"] }
    assert.equal((await backend.invoke("bee2:resolve", request)).code, "bee2_running")
    bee2.running = false
    const fixed = await backend.invoke("bee2:resolve", request)
    assert.equal(fixed.ok, true, fixed.error)
    assert.deepEqual(fixed.removed, [older]) // the newest copy is kept
    assert.deepEqual(fixed.installed, ["@sorter/sorter-items@1.0.0"])
    assert.deepEqual(fixed.replaced, [
        { name: "@sorter/sorter-items", files: ["sorter_own.bee_pack"] },
    ])
    await access(path.join(packages, "beepm", "sorter@sorter-items.bee_pack"))
    await access(path.join(dir, "check-home", "replaced", "sorter_own.bee_pack")) // kept, not gone

    const after = await backend.invoke("bee2:check")
    assert.deepEqual([after.duplicates.packages, after.onBeepm], [[], []])
})

test("a package that crashed BEE2 is found in its log and removed, and BEE2 opens again", async () => {
    const folder = await fakeBee2(path.join(dir, "crash-bee2", "BEE2"))
    const program = path.join(folder, "BEE2.exe")
    const broken = path.join(folder, "packages", "ucp_temp23.bee_pack")
    await writeFile(broken, await zipBytes({ "info.txt": '"ID" "TEMP23"\n"Name" "Temp23"\n' }))
    const bee2 = { running: false }
    const asked = []
    const opened = []
    const { backend } = await startBackend({
        home: path.join(dir, "crash-home"),
        bee2Process: {
            isRunning: async () => bee2.running,
            findProgram: async () => (bee2.running ? program : null),
            programs: async () => (bee2.running ? [program] : []),
            leftovers: async () => [],
        },
        ask: async (question) => {
            asked.push(question)
            return question.kind === "broken" ? "remove" : "later"
        },
        openProgram: (file) => opened.push(file),
    })
    assert.equal((await backend.invoke("bee2:set-folder", folder)).ok, true)

    bee2.running = true
    await backend.watcher.check()
    // BEE2 crashes on it, like BEE2 4.46 logs it
    await writeFile(
        path.join(folder, "logs", "bee2.log"),
        [
            "[ERROR] core.done_callback(): Trio exited with exception",
            '                  | ValueError: Invalid Item ID "VERSION". IDs cannot be any of the following: NAME, VERSION, ID, TYPE',
            "              | The above exception was the direct cause of the following exception:",
            "              | ValueError: Error occured parsing TEMP23:VERSION item!",
        ].join("\r\n"),
    )
    bee2.running = false
    await backend.watcher.check()

    const question = asked.find((q) => q.kind === "broken")
    assert.equal(question.name, "Temp23")
    assert.match(question.message, /Invalid Item ID "VERSION"/)
    await assert.rejects(access(broken)) // gone from BEE2's packages folder (to BeePM's backups)
    await access(path.join(dir, "crash-home", "replaced", "ucp_temp23.bee_pack"))
    assert.deepEqual(opened, [program])
    // Stops watching BEE2's logs folder too: on Windows, watching a folder that's then deleted
    // keeps Node from exiting
    await backend.dispose()
})

test("BEE2 left running after it crashed: ended before what broke it is removed", async () => {
    const folder = await fakeBee2(path.join(dir, "leftover-bee2", "BEE2"))
    const program = path.join(folder, "BEE2.exe")
    const broken = path.join(folder, "packages", "ucp_temp23.bee_pack")
    await writeFile(broken, await zipBytes({ "info.txt": '"ID" "TEMP23"\n"Name" "Temp23"\n' }))
    // It crashed right away, before BeePM saw it open, and its process stays without a window
    const started = Date.now() - 3000
    let left = [{ pid: 4242, program, started, leftover: Date.now() }]
    const happened = []
    const { backend } = await startBackend({
        home: path.join(dir, "leftover-home"),
        bee2Process: {
            isRunning: async () => false,
            findProgram: async () => null,
            programs: async () => [],
            leftovers: async () => left,
            endLeftovers: async (from) => {
                assert.equal(from, folder) // only BeePM's BEE2
                happened.push(`ended ${left.length}`)
                const ended = left.length
                left = []
                return ended
            },
        },
        ask: async (question) => {
            happened.push(`asked ${question.kind}`)
            return question.kind === "broken" ? "remove" : "later"
        },
        openProgram: (file) => happened.push(`opened ${path.basename(file)}`),
    })
    assert.equal((await backend.invoke("bee2:set-folder", folder)).ok, true)
    await writeFile(
        path.join(folder, "logs", "bee2.log"),
        [
            "[ERROR] core.done_callback(): Trio exited with exception",
            '                  | ValueError: Invalid Item ID "VERSION". IDs cannot be any of the following: NAME, VERSION, ID, TYPE',
            "              | ValueError: Error occured parsing TEMP23:VERSION item!",
        ].join("\r\n"),
    )
    await backend.watcher.check()
    assert.deepEqual(happened, ["asked broken", "ended 1", "opened BEE2.exe"])
    await assert.rejects(access(broken))
    await backend.watcher.check() // nothing's left to ask about
    assert.equal(happened.length, 3)
    await backend.dispose()
})

test("any crash: the package with the item BEE2 stopped on is offered; none named, its log", async () => {
    const folder = await fakeBee2(path.join(dir, "item-crash-bee2", "BEE2"))
    const packages = path.join(folder, "packages")
    const grates = path.join(packages, "barrier_variants.bee_pack")
    await writeFile(
        grates,
        await zipBytes({
            "info.txt":
                '"ID" "BEE2_BARRIER_VARIANTS"\n"Name" "Glass/Grating Variants"\n"Item"\n{\n"ID" "ITEM_LAUTARO_HALF_GRATE"\n}\n',
        }),
    )
    // The style the error mentions is fine: its package stays
    const style = path.join(packages, "p1_style.bee_pack")
    await writeFile(
        style,
        await zipBytes({ "info.txt": '"ID" "BEE2_PORTAL_1"\n"Name" "Portal 1"\n' }),
    )
    const bee2 = { running: false }
    const asked = []
    const opened = []
    const logged = []
    const { backend } = await startBackend({
        home: path.join(dir, "item-crash-home"),
        log: {
            section: (_title, fn) => fn(),
            info: (text) => logged.push(text),
            warn: (text) => logged.push(text),
            error: () => {},
            debug() {},
            getLogsDirectory: () => null,
        },
        bee2Process: {
            isRunning: async () => bee2.running,
            findProgram: async () => (bee2.running ? path.join(folder, "BEE2.exe") : null),
            programs: async () => [],
            leftovers: async () => [],
        },
        ask: async (question) => {
            asked.push(question)
            return { broken: "remove", crashed: "log" }[question.kind] ?? "later"
        },
        openPath: async (file) => opened.push(file),
    })
    assert.equal((await backend.invoke("bee2:set-folder", folder)).ok, true)
    const crash = (error) =>
        writeFile(
            path.join(folder, "logs", "bee2.log"),
            [
                "[ERROR] core.done_callback(): Trio exited with exception",
                '        | transtoken.AppError: AppError: TemplateBrush "temp_x" in package "BEE2_PORTAL_1" no longer needs to be defined in info.txt.',
                "          | Traceback (most recent call last):",
                `          | ${error}`,
            ].join("\r\n"),
        )

    bee2.running = true
    await backend.watcher.check()
    await crash(
        'ValueError: Item ITEM_LAUTARO_HALF_GRATE\'s AXO_HYBRID style referenced invalid style "BEE2_PORTAL_1"',
    )
    bee2.running = false
    await backend.watcher.check()
    assert.deepEqual(
        asked.map((q) => [q.kind, q.name]),
        [["broken", "Glass/Grating Variants"]],
    )
    await assert.rejects(access(grates)) // removed
    await access(style) // not the style's package
    // The log says what BEE2's log said, and which package that is
    assert.ok(
        logged.includes(
            'bee2.log: Item ITEM_LAUTARO_HALF_GRATE\'s AXO_HYBRID style referenced invalid style "BEE2_PORTAL_1" -> Glass/Grating Variants (barrier_variants.bee_pack)',
        ),
        logged.join("\n"),
    )

    // Something that names no package: BEE2 crashed, and its log opens
    bee2.running = true
    await backend.watcher.check()
    await crash("KeyError: 'palette'")
    bee2.running = false
    await backend.watcher.check()
    assert.deepEqual(
        asked.slice(1).map((q) => [q.kind, q.message]),
        [["crashed", "KeyError: 'palette'"]],
    )
    assert.deepEqual(opened, [path.join(folder, "logs", "bee2.log")])
    await backend.dispose()
})

test("while BEE2 is open nothing is installed or removed; the window opens and closes it", async () => {
    const folder = await fakeBee2(path.join(dir, "open-bee2", "BEE2"))
    // busy: a window of its own is open in BEE2, so it can't be asked to close
    const bee2 = { running: false, busy: false, asked: 0 }
    const opened = []
    const { backend } = await startBackend({
        home: path.join(dir, "open-home"),
        bee2Process: {
            isRunning: async () => bee2.running,
            findProgram: async () => null,
            programs: async () => [],
            leftovers: async () => [],
            askToClose: async () => {
                if (bee2.busy) return false
                bee2.asked++
                bee2.running = false // it closes when asked
                return true
            },
        },
        openProgram: (file) => {
            opened.push(file)
            bee2.running = true
        },
    })
    assert.equal((await backend.invoke("bee2:set-folder", folder)).ok, true)
    assert.deepEqual(await backend.invoke("bee2:running"), { ok: true, running: false })

    // Opened from the window
    assert.deepEqual(await backend.invoke("bee2:open"), { ok: true, opened: true })
    assert.deepEqual(opened, [path.join(folder, "BEE2.exe")])
    assert.deepEqual(await backend.invoke("bee2:running"), { ok: true, running: true })
    assert.deepEqual(await backend.invoke("bee2:open"), { ok: true, opened: false }) // open already

    // It has the package files open: removing (or installing) is refused, not an EBUSY
    const removing = await backend.invoke("packages:uninstall", ["@someone/thing"])
    assert.equal(removing.code, "bee2_running")
    assert.match(removing.error, /Close it to install or remove packages/)

    // Closed from the window: asked the way its close button does, never forced
    bee2.busy = true
    assert.equal((await backend.invoke("bee2:close")).code, "bee2_busy")
    assert.equal(bee2.running, true)
    bee2.busy = false
    assert.deepEqual(await backend.invoke("bee2:close"), { ok: true, closed: true })
    assert.equal(bee2.asked, 1)
    assert.deepEqual(await backend.invoke("bee2:running"), { ok: true, running: false })
    await backend.dispose()
})

test('"View contents" opens a window for a real package version only', async () => {
    const shown = []
    const { backend } = await startBackend({
        showContents: (...args) => shown.push(args),
    })
    assert.equal((await backend.invoke("app:open-contents", "@A/Items", "1.2.0", "Items")).ok, true)
    assert.deepEqual(shown, [["@a/items", "1.2.0", "Items"]])
    for (const [name, version] of [
        ["not a name", "1.0.0"],
        ["@a/items", "../../etc"],
        ["@a/items", null],
    ]) {
        assert.equal((await backend.invoke("app:open-contents", name, version)).ok, false)
    }
    assert.equal(shown.length, 1)
})

test("settings: running in the background, and updates not to ask about again", async () => {
    const applied = []
    const { backend } = await startBackend({ onSettingsChanged: (s) => applied.push(s.background) })
    // Off unless it's the installed app (main.js passes backgroundDefault)
    assert.equal((await backend.invoke("app:settings")).settings.background, false)

    const on = await backend.invoke("app:update-settings", {
        background: true,
        ignoredUpdates: ["@a/b"],
    })
    assert.equal(on.settings.background, true)
    assert.deepEqual(applied, [true])
    const file = path.join(env.BEEPM_HOME, "config", "app-settings.json")
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")).ignoredUpdates, ["@a/b"])

    // A restarted app reads them back
    const again = await startBackend()
    assert.equal((await again.backend.invoke("app:settings")).settings.background, true)
    await again.backend.invoke("app:update-settings", { background: false, ignoredUpdates: [] })
    again.backend.watcher.stop()
    backend.watcher.stop()
})

import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { access, mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { after, before, test } from "node:test"
import {
    adoptLegacyInstalls,
    applyPlan,
    bee2Paths,
    bee2Status,
    beepmPaths,
    findPackages,
    getGithubJson,
    getIniValue,
    hookBee2,
    importLocal,
    installBasePackages,
    InstallError,
    listGithubReleases,
    listGithubRepos,
    loadInstalled,
    packageFileName,
    planImport,
    suggestManifest,
    planInstall,
    removeIniKey,
    saveConfig,
    saveInstalled,
    setIniValue,
    unhookBee2,
} from "../src/client/index.js"
import { readPack } from "../src/pack.js"
import { infoTxt, makeZip, tempDir } from "./helpers.js"

// Never close the real BEE2 while testing
process.env.BEEPM_NO_CLOSE_BEE2 = "1"

let tmp
before(async () => {
    tmp = await tempDir()
})
after(() => tmp.cleanup())

test("config.cfg edits change one line and keep everything else", () => {
    const original =
        "[General]\r\nlaunch = 1\r\n\r\n[Directories]\r\n; where packages are\r\nPackage = ../packages/\r\nmusic = x\r\n\r\n[Last_Selected]\r\nstyle = BEE2_CLEAN\r\n"
    assert.equal(getIniValue(original, "directories", "package"), "../packages/")
    const changed = setIniValue(
        original,
        "Directories",
        "package",
        "C:\\Users\\me\\beepm\\packages",
    )
    assert.equal(
        changed,
        original.replace("Package = ../packages/", "package = C:\\Users\\me\\beepm\\packages"),
    )
    assert.equal(
        removeIniKey(changed, "Directories", "package"),
        original.replace("Package = ../packages/\r\n", ""),
    )

    // Missing key or section get added
    const added = setIniValue(
        "[Directories]\nmusic = x\n\n[Other]\na = 1\n",
        "Directories",
        "package",
        "p",
    )
    assert.equal(added, "[Directories]\nmusic = x\npackage = p\n\n[Other]\na = 1\n")
    assert.equal(setIniValue("", "Directories", "package", "p"), "[Directories]\npackage = p\n")
    assert.equal(getIniValue("[Other]\npackage = no\n", "Directories", "package"), null)
})

test("hook remembers the old folder and unhook puts it back", async () => {
    const env = {
        BEEPM_HOME: path.join(tmp.dir, "home1"),
        BEE2_CONFIG_DIR: path.join(tmp.dir, "bee2-1"),
    }
    const paths = beepmPaths(env)
    const bee2 = bee2Paths(env)
    const config = {}

    await assert.rejects(hookBee2(paths, bee2, config), /Install BEE2 and open it once/)

    await mkdir(bee2.configDir, { recursive: true })
    const original = "[Directories]\npackage = ../packages/\nmusic = y\n"
    await writeFile(bee2.configFile, original)

    assert.equal((await hookBee2(paths, bee2, config)).changed, true)
    assert.equal(config.hook.originalPackageDir, "../packages/")
    assert.equal((await bee2Status(paths, bee2)).hooked, true)
    assert.equal((await hookBee2(paths, bee2, config)).changed, false) // already hooked

    const result = await unhookBee2(paths, bee2, config)
    assert.equal(result.restored, "../packages/")
    assert.equal(await readFile(bee2.configFile, "utf8"), original)
    assert.equal(config.hook, undefined)
})

test("unhook without a saved value removes the key, or uses the old CLI's backup", async () => {
    const env = {
        BEEPM_HOME: path.join(tmp.dir, "home2"),
        BEE2_CONFIG_DIR: path.join(tmp.dir, "bee2-2"),
    }
    const paths = beepmPaths(env)
    const bee2 = bee2Paths(env)
    await mkdir(bee2.configDir, { recursive: true })
    await writeFile(bee2.configFile, `[Directories]\npackage = ${paths.packages}\n`)

    await writeFile(`${bee2.configFile}.backup`, "[Directories]\npackage = D:\\BEE2\\packages\n")
    assert.equal((await unhookBee2(paths, bee2, {})).restored, "D:\\BEE2\\packages")

    await writeFile(bee2.configFile, `[Directories]\npackage = ${paths.packages}\n`)
    await writeFile(`${bee2.configFile}.backup`, "[General]\n")
    await unhookBee2(paths, bee2, {})
    assert.equal(await readFile(bee2.configFile, "utf8"), "[Directories]\n")
})

// ---------- planner ----------

const v = (version, extra = {}) => ({
    version,
    compatibleWith: null,
    dependencies: {},
    sha256: "x",
    size: 1,
    yanked: false,
    ...extra,
})
const docOf = (name, beeId, versions) => ({
    name,
    beeId,
    displayName: name,
    latest: versions.at(-1).version,
    versions: Object.fromEntries(versions.map((x) => [x.version, x])),
})

function fakeContext(name, docs) {
    const env = { BEEPM_HOME: path.join(tmp.dir, name) }
    return {
        paths: beepmPaths(env),
        api: {
            async packument(n) {
                if (!docs[n]) throw Object.assign(new Error("nope"), { status: 404 })
                return docs[n]
            },
            async lookup({ name: bare }) {
                return { packages: Object.keys(docs).filter((n) => n.endsWith(`/${bare}`)) }
            },
        },
    }
}

const docs = {
    "@a/app": docOf("@a/app", "APP", [
        v("1.0.0", { dependencies: { "@b/lib": "^1.0.0", "@beemod/BEE2_CLEAN_STYLE": "*" } }),
        v("2.0.0", { dependencies: { "@b/lib": "^2.0.0" }, compatibleWith: ">=2.4.46" }),
    ]),
    "@b/lib": docOf("@b/lib", "LIB", [
        v("1.0.0"),
        v("1.5.0"),
        v("1.6.0", { yanked: true }),
        v("2.0.0"),
    ]),
    "@c/old": docOf("@c/old", "OLD", [v("1.0.0", { dependencies: { "@b/lib": "~1.0.0" } })]),
}

test("planInstall resolves dependencies, skips yanked and BEE2-incompatible versions", async () => {
    const ctx = fakeContext("plan1", docs)
    await saveConfig(ctx.paths, {
        bee2: { version: "2.4.45.2", basePackages: ["BEE2_CLEAN_STYLE"] },
    })
    const plan = await planInstall(ctx, ["app"])
    assert.deepEqual(
        plan.steps.map((s) => `${s.name}@${s.to}`),
        ["@b/lib@1.5.0", "@a/app@1.0.0"],
    )
    assert.equal(plan.steps[1].explicit, true)
    assert.equal(plan.steps[0].explicit, false)
    assert.deepEqual(plan.warnings, [])

    // On BEE2 2.4.46 the newer app (and lib 2) is chosen
    await saveConfig(ctx.paths, { bee2: { version: "2.4.46.1" } })
    const newer = await planInstall(ctx, ["@a/app"])
    assert.deepEqual(
        newer.steps.map((s) => `${s.name}@${s.to}`),
        ["@b/lib@2.0.0", "@a/app@2.0.0"],
    )

    // A yanked version still installs when pinned exactly
    const pinned = await planInstall(ctx, ["@b/lib@1.6.0"])
    assert.deepEqual(
        pinned.steps.map((s) => s.to),
        ["1.6.0"],
    )
})

test("planInstall reports version conflicts and missing packages clearly", async () => {
    const ctx = fakeContext("plan2", docs)
    await saveConfig(ctx.paths, { bee2: { version: "2.4.46.1" } })
    await saveInstalled(ctx.paths, {
        packages: {
            "@c/old": {
                version: "1.0.0",
                explicit: true,
                range: "*",
                file: "c@old.bee_pack",
                dependencies: { "@b/lib": "~1.0.0" },
            },
            "@b/lib": {
                version: "1.0.0",
                explicit: false,
                range: "*",
                file: "b@lib.bee_pack",
                dependencies: {},
            },
        },
    })
    // app@2 needs lib ^2 but old needs ~1.0.0: app@1 needs BEE2 <2.4.46? no, app@1 is compatible: picks app@1 with lib ^1
    const plan = await planInstall(ctx, ["@a/app@2"])
        .then(() => null)
        .catch((err) => err)
    assert.ok(plan instanceof InstallError)
    assert.match(
        plan.message,
        /@b\/lib can't satisfy everything that needs it: ~1\.0\.0 \(@c\/old@1\.0\.0\) and \^2\.0\.0 \(@a\/app@2\.0\.0\)/,
    )

    await assert.rejects(planInstall(ctx, ["@z/missing"]), /isn't in the registry/)
    await assert.rejects(planInstall(ctx, ["nothing"]), /No package is called "nothing"/)

    const again = await planInstall(ctx, ["@c/old"])
    assert.equal(again.steps.length, 0)
    assert.match(again.warnings[0], /already installed/)
})

test("update moves packages to the newest version their ranges allow", async () => {
    const ctx = fakeContext("plan3", docs)
    await saveConfig(ctx.paths, { bee2: { version: "2.4.45.0" } })
    await saveInstalled(ctx.paths, {
        packages: {
            "@b/lib": {
                version: "1.0.0",
                explicit: true,
                range: "^1.0.0",
                file: "b@lib.bee_pack",
                dependencies: {},
            },
        },
    })
    const plan = await planInstall(ctx, [], { update: true })
    assert.deepEqual(
        plan.steps.map((s) => `${s.from}->${s.to}`),
        ["1.0.0->1.5.0"],
    )
})

test("hook and unhook close BEE2 only when they change something", async () => {
    const env = {
        BEEPM_HOME: path.join(tmp.dir, "home4"),
        BEE2_CONFIG_DIR: path.join(tmp.dir, "bee2-4"),
    }
    const paths = beepmPaths(env)
    const bee2 = bee2Paths(env)
    await mkdir(bee2.configDir, { recursive: true })
    await writeFile(bee2.configFile, "[Directories]\npackage = ../packages/\n")
    let closes = 0
    const close = async () => {
        closes++
        return true
    }
    const config = {}
    assert.deepEqual(await hookBee2(paths, bee2, config, { close }), {
        changed: true,
        previous: "../packages/",
        closedBee2: true,
    })
    assert.equal((await hookBee2(paths, bee2, config, { close })).closedBee2, false) // already hooked
    assert.equal(closes, 1)
    assert.equal((await unhookBee2(paths, bee2, config, { close })).closedBee2, true)
    assert.equal((await unhookBee2(paths, bee2, config, { close })).changed, false)
    assert.equal(closes, 2)
})

test("setup downloads the packages before the music and announces every download first", async () => {
    const env = { BEEPM_HOME: path.join(tmp.dir, "home5") }
    const paths = beepmPaths(env)
    // A BEE2-items release whose zips each hold one .bee_pack
    const inner = path.join(tmp.dir, "inner.bee_pack")
    await makeZip(inner, { "info.txt": '"ID" "BEE2_CLEAN_STYLE"' })
    const packagesZip = await makeZip(path.join(tmp.dir, "packages.zip"), {
        "clean_style.bee_pack": await readFile(inner),
    })
    const musicZip = await makeZip(path.join(tmp.dir, "music.zip"), {
        "music.bee_pack": await readFile(inner),
    })
    const files = { "https://dl/music.zip": musicZip, "https://dl/packages.zip": packagesZip }
    const sizes = {}
    for (const [url, file] of Object.entries(files)) sizes[url] = (await readFile(file)).length
    const fakeFetch = async (url) => {
        if (String(url).includes("BEE2-items/releases")) {
            return Response.json([
                {
                    tag_name: "v4.46.0",
                    assets: [
                        {
                            name: "BEE2_v4.46.0_music.zip",
                            size: sizes["https://dl/music.zip"],
                            browser_download_url: "https://dl/music.zip",
                        },
                        {
                            name: "BEE2_v4.46.1_packages.zip",
                            size: sizes["https://dl/packages.zip"],
                            browser_download_url: "https://dl/packages.zip",
                        },
                    ],
                },
            ])
        }
        return new Response(await readFile(files[url]))
    }
    const events = []
    const config = {}
    await installBasePackages(paths, config, {
        version: "2.4.46.1",
        fetch: fakeFetch,
        close: async () => true,
        onProgress: (p) => events.push(p),
    })
    assert.deepEqual(
        events[0].assets.map((a) => a.name),
        ["BEE2_v4.46.1_packages.zip", "BEE2_v4.46.0_music.zip"],
    )
    assert.equal(events[1].step, "closed-bee2")
    const downloads = [...new Set(events.filter((e) => e.step === "download").map((e) => e.asset))]
    assert.deepEqual(downloads, ["BEE2_v4.46.1_packages.zip", "BEE2_v4.46.0_music.zip"])
    assert.deepEqual(config.bee2.basePackages, ["BEE2_CLEAN_STYLE"])
})

test("GitHub: repos the account can publish from, and releases with a .bee_pack", async () => {
    const replies = {
        "/users/maker/repos?type=owner&sort=pushed&per_page=100": [
            {
                owner: { login: "maker" },
                name: "old",
                full_name: "maker/old",
                pushed_at: "2025-01-01T00:00:00Z",
            },
            {
                owner: { login: "maker" },
                name: "secret",
                full_name: "maker/secret",
                private: true,
                pushed_at: "2026-09-01T00:00:00Z",
            },
        ],
        "/users/maker/orgs?per_page=100": [{ login: "team" }, { login: "gone" }],
        "/orgs/team/repos?type=public&sort=pushed&per_page=100": [
            {
                owner: { login: "team" },
                name: "items",
                full_name: "team/items",
                pushed_at: "2026-10-01T00:00:00Z",
            },
        ],
        "/repos/team/items/releases?per_page=30": [
            { tag_name: "v2", name: "", draft: true, assets: [{ name: "a.bee_pack" }] },
            {
                tag_name: "v1.1",
                name: "Big update",
                assets: [{ name: "items.bee_pack" }, { name: "notes.txt" }],
            },
            { tag_name: "v1.0", name: "First", assets: [{ name: "source.zip" }] },
        ],
    }
    const fetch = async (url) => {
        const reply = replies[url.replace("https://api.github.com", "")]
        return reply
            ? new Response(JSON.stringify(reply), { status: 200 })
            : new Response("{}", { status: 404 })
    }

    // Private repos are left out; an org whose repos can't be read is skipped
    const repos = await listGithubRepos({ fetch }, "maker")
    assert.deepEqual(
        repos.map((r) => r.fullName),
        ["team/items", "maker/old"],
    )

    // Drafts and releases without a .bee_pack are left out
    const releases = await listGithubReleases({ fetch }, "team", "items")
    assert.deepEqual(releases, [
        {
            tag: "v1.1",
            name: "Big update",
            publishedAt: null,
            prerelease: false,
            assets: ["items.bee_pack"],
        },
    ])
    await assert.rejects(listGithubReleases({ fetch }, "team", "nope"), /doesn't know/)
})

test("GitHub answers are reused for a while, and stand in when the hourly limit is used up", async () => {
    let calls = 0
    let reply = () => new Response(JSON.stringify([{ tag_name: "v1", assets: [] }]))
    const fetch = async () => {
        calls++
        return reply()
    }
    const url = "https://api.github.com/repos/team/items/releases?per_page=30"
    await listGithubReleases({ fetch }, "team", "items")
    await listGithubReleases({ fetch }, "team", "items")
    assert.equal(calls, 1) // the second came from the cache

    // Used up: the last answer stands in, and with none the error says when to try again
    const reset = Math.floor(Date.now() / 1000) + 17 * 60
    reply = () =>
        new Response("{}", {
            status: 403,
            headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) },
        })
    assert.deepEqual(await getGithubJson(fetch, url), [{ tag_name: "v1", assets: [] }])
    await assert.rejects(
        getGithubJson(fetch, "https://api.github.com/repos/team/other/releases"),
        /hourly limit for this network is used up\. Try again in 17 minutes\./,
    )

    // Other refusals aren't the limit
    reply = () => new Response("{}", { status: 403 })
    await assert.rejects(
        getGithubJson(fetch, "https://api.github.com/repos/team/private"),
        /GitHub returned HTTP 403\./,
    )
})

test("taking over old installs only accepts real package names from the registry", async () => {
    const paths = beepmPaths({ BEEPM_HOME: path.join(tmp.dir, "adopt", "home") })
    await mkdir(paths.configDir, { recursive: true })
    await mkdir(paths.packages, { recursive: true })
    await writeFile(path.join(paths.packages, "areng_GOOD_ITEMS.bee_pack"), "good")
    await writeFile(path.join(paths.packages, "evil_EVIL_ITEMS.bee_pack"), "evil")
    await writeFile(
        paths.legacyInstalled,
        JSON.stringify({
            packages: {
                GOOD_ITEMS: { author: "areng", version: "1.0.0" },
                EVIL_ITEMS: { author: "evil", version: "1.0.0" },
            },
        }),
    )
    // A hostile registry answers with a name that would climb out of the packages folder
    const api = {
        lookup: async ({ beeId }) => ({
            packages: [beeId === "GOOD_ITEMS" ? "@areng/good-items" : "x/../../../PWNED"],
        }),
        packument: async () => {
            throw new Error("not in this test")
        },
    }
    const { adopted, unknown } = await adoptLegacyInstalls({ api, paths })
    assert.deepEqual(adopted, ["@areng/good-items"])
    assert.deepEqual(unknown, ["EVIL_ITEMS"])
    await access(path.join(paths.packages, "areng@good-items.bee_pack"))
    await access(path.join(paths.packages, "evil_EVIL_ITEMS.bee_pack")) // left where it was
    assert.throws(() => packageFileName("x/../../PWNED"), /isn't a package name/)
})

test("importing packages from this PC: BeePM's own first, and they replace local copies later", async () => {
    const dir = path.join(tmp.dir, "import-from")
    await mkdir(path.join(dir, "folder-pack"), { recursive: true })
    await writeFile(path.join(dir, "folder-pack", "info.txt"), infoTxt("FOLDER_PACK"))
    await writeFile(path.join(dir, "folder-pack", "notes.md"), "local packages keep every file")
    await makeZip(path.join(dir, "mine.bee_pack"), { "info.txt": infoTxt("MY_PACK") })
    await makeZip(path.join(dir, "published.zip"), { "info.txt": infoTxt("APP") })
    await makeZip(path.join(dir, "clean.bee_pack"), { "info.txt": infoTxt("BEE2_CLEAN_STYLE") })
    await writeFile(path.join(dir, "broken.bee_pack"), "not a zip")
    await writeFile(path.join(dir, "readme.txt"), "not a package")
    // In a folder that isn't a package itself (BEE2 looks in those too)
    await mkdir(path.join(dir, "Signage"))
    await makeZip(path.join(dir, "Signage", "signs.bee_pack"), { "info.txt": infoTxt("SIGNS") })

    // On BeePM: @a/app has the ID APP, and @me/mine (below) has MY_PACK
    const bytes = Buffer.from("the published copy")
    const sha256 = createHash("sha256").update(bytes).digest("hex")
    const all = {
        ...docs,
        "@me/mine": docOf("@me/mine", "MY_PACK", [v("1.0.0", { sha256, size: bytes.length })]),
    }
    const ctx = fakeContext("import", all)
    ctx.api.lookup = async ({ beeId }) => ({
        packages: beeId === "APP" ? ["@a/app"] : [],
    })
    ctx.api.downloadUrl = () => "https://dl.test/mine"
    ctx.fetch = async () => new Response(bytes)
    await saveConfig(ctx.paths, {
        bee2: { version: "2.4.46.0", basePackages: ["BEE2_CLEAN_STYLE"] },
    })

    const reads = []
    const lookups = []
    const found = await findPackages(dir, { onProgress: (p) => reads.push(p) })
    const { items, offline } = await planImport(ctx, found, { onProgress: (p) => lookups.push(p) })
    assert.equal(offline, false)
    assert.deepEqual(
        Object.fromEntries(items.map((item) => [path.basename(item.path), item.action])),
        {
            "broken.bee_pack": "skip",
            "clean.bee_pack": "skip",
            "folder-pack": "local",
            "mine.bee_pack": "local",
            "published.zip": "beepm",
            "signs.bee_pack": "local",
        },
    )
    assert.equal(items.find((item) => item.action === "beepm").package, "@a/app")
    // Every package read, then the registry asked about the ones not skipped
    assert.deepEqual(reads.at(-1), { done: 6, total: 6 })
    assert.deepEqual(lookups.at(-1), { done: 4, total: 4 })

    // Copied in; a folder is zipped with all its files
    for (const item of items.filter((i) => i.action === "local")) {
        await importLocal(ctx.paths, item)
    }
    let installed = await loadInstalled(ctx.paths)
    assert.deepEqual(Object.keys(installed.local).sort(), ["FOLDER_PACK", "MY_PACK", "SIGNS"])
    const zipped = await readPack(path.join(ctx.paths.packages, "folder_pack.local.bee_pack"))
    assert.ok(zipped.files.includes("notes.md"))

    // Installing @me/mine from BeePM replaces the local copy with the same ID
    const plan = await planInstall(ctx, ["@me/mine"])
    assert.ok(plan.warnings.some((w) => w.includes("replaces your local copy")))
    const result = await applyPlan(ctx, plan)
    assert.deepEqual(result.replacedLocal, ["Test package"])
    installed = await loadInstalled(ctx.paths)
    assert.deepEqual(Object.keys(installed.local).sort(), ["FOLDER_PACK", "SIGNS"])
    await assert.rejects(access(path.join(ctx.paths.packages, "my_pack.local.bee_pack")))
    await access(path.join(ctx.paths.packages, "me@mine.bee_pack"))
})

test("suggestManifest continues a published package: its name, the next version", async () => {
    const folder = path.join(tmp.dir, "suggest")
    await mkdir(folder, { recursive: true })
    await writeFile(path.join(folder, "info.txt"), '"ID" "SAME_ITEMS"\n"Name" "Renamed Items"\n')
    const api = (packages) => ({
        lookup: async ({ beeId }) => ({ packages: beeId === "SAME_ITEMS" ? packages : [] }),
        packument: async () => ({ versions: { "1.0.0": {}, "1.2.0": {}, "1.10.0": {} } }),
    })

    const next = await suggestManifest({ api: api(["@me/same-items"]) }, folder, { handle: "me" })
    assert.equal(next.manifest.name, "@me/same-items") // not "@me/renamed-items" from info.txt
    assert.equal(next.manifest.version, "1.10.1")
    assert.deepEqual(next.published, { name: "@me/same-items", latest: "1.10.0" })

    const fresh = await suggestManifest({ api: api([]) }, folder, { handle: "me" })
    assert.equal(fresh.manifest.name, "@me/renamed-items")
    assert.equal(fresh.manifest.version, "1.0.0")
    assert.equal(fresh.published, null)
})

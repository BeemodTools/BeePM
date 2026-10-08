import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { access, copyFile, mkdir, readFile, utimes, writeFile } from "node:fs/promises"
import path from "node:path"
import { after, before, test } from "node:test"
import {
    adoptLegacyInstalls,
    applyPlan,
    bee2Info,
    bee2Paths,
    beepmPaths,
    checkBee2Packages,
    createClientContext,
    findBee2Folder,
    getGithubJson,
    getIniValue,
    InstallError,
    leaveHook,
    listGithubReleases,
    listGithubRepos,
    loadInstalled,
    packageFileName,
    planInstall,
    readBee2Version,
    removeIniKey,
    removePackageFiles,
    saveConfig,
    saveInstalled,
    setBee2Folder,
    setIniValue,
    suggestManifest,
    useBee2Folder,
} from "../src/client/index.js"
import { duplicateRemovals, hasDuplicates } from "../src/duplicates.js"
import { hashFile } from "../src/pack.js"
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
        paths: useBee2Folder(beepmPaths(env), path.join(tmp.dir, name, "BEE2")),
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
        bee2: { version: "2.4.45.2" },
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
    const paths = useBee2Folder(
        beepmPaths({ BEEPM_HOME: path.join(tmp.dir, "adopt", "home") }),
        path.join(tmp.dir, "adopt", "BEE2"),
    )
    await mkdir(paths.configDir, { recursive: true })
    await mkdir(paths.hookedPackages, { recursive: true })
    await writeFile(path.join(paths.hookedPackages, "areng_GOOD_ITEMS.bee_pack"), "good")
    await writeFile(path.join(paths.hookedPackages, "evil_EVIL_ITEMS.bee_pack"), "evil")
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
    await access(path.join(paths.hookedPackages, "evil_EVIL_ITEMS.bee_pack")) // left where it was
    assert.throws(() => packageFileName("x/../../PWNED"), /isn't a package name/)
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

// ---------- BEE2's folder ----------

/** A BEE2 folder: BEE2.exe, a log saying `version` (none: BEE2 hasn't run), packages/. */
async function fakeBee2(dir, { version = "2.4.46.1" } = {}) {
    await mkdir(path.join(dir, "packages"), { recursive: true })
    await writeFile(path.join(dir, "BEE2.exe"), "")
    if (version) {
        await mkdir(path.join(dir, "logs"), { recursive: true })
        await writeFile(
            path.join(dir, "logs", "bee2.log"),
            `[INFO] BEE2_launch.<module>(): Arguments: ['BEE2.exe']\n[INFO] BEE2_launch.<module>(): Running "bee2", version ${version} 64-bit:\n`,
        )
    }
    return dir
}

/** A package file in a folder, with some items, last changed `ago` seconds ago. */
async function fakePack(file, id, { items = [], ago = 0 } = {}) {
    await mkdir(path.dirname(file), { recursive: true })
    const blocks = items.map((item) => `"Item"\n{\n"ID" "${item}"\n}\n`).join("")
    await makeZip(file, { "info.txt": infoTxt(id, blocks) })
    const time = new Date(Date.now() - ago * 1000)
    await utimes(file, time, time)
    return file
}

test("BEE2's folder: found from what was picked, its version read from its log", async () => {
    const bee2 = await fakeBee2(path.join(tmp.dir, "folder", "BEE2_4.46.0_win"))
    assert.equal(await findBee2Folder(bee2), bee2)
    assert.equal(await findBee2Folder(path.join(bee2, "packages")), bee2) // its packages folder
    assert.equal(await findBee2Folder(path.join(bee2, "packages", "beepm")), bee2)
    await assert.rejects(
        findBee2Folder(path.join(tmp.dir, "folder")),
        /Choose the folder BEE2.exe is in/,
    )

    assert.equal(await readBee2Version(bee2), "2.4.46.1")
    const fresh = await fakeBee2(path.join(tmp.dir, "folder", "never-run"), { version: null })
    assert.equal(await readBee2Version(fresh), null)

    // Remembered in config.json: a new context installs into BeePM's folder in there
    const env = { BEEPM_HOME: path.join(tmp.dir, "folder", "home") }
    const ctx = await createClientContext({ env })
    assert.equal(ctx.paths.packages, null)
    assert.deepEqual(await setBee2Folder(ctx, path.join(bee2, "packages")), {
        dir: bee2,
        version: "2.4.46.1",
        moved: 0,
    })
    const again = await createClientContext({ env })
    assert.equal(again.paths.packages, path.join(bee2, "packages", "beepm"))
    assert.deepEqual(await bee2Info(again), { dir: bee2, version: "2.4.46.1", found: true })

    // Another BEE2: BeePM's packages come along, its version is that BEE2's (unknown here)
    await fakePack(path.join(again.paths.packages, "a@items.bee_pack"), "ITEMS")
    await saveInstalled(again.paths, {
        packages: { "@a/items": { version: "1.0.0", file: "a@items.bee_pack", beeId: "ITEMS" } },
    })
    assert.deepEqual(await setBee2Folder(again, fresh), { dir: fresh, version: null, moved: 1 })
    await access(path.join(fresh, "packages", "beepm", "a@items.bee_pack"))
    await assert.rejects(access(path.join(bee2, "packages", "beepm"))) // emptied and gone
})

test("installing needs BEE2's folder, and replaces the user's own copy of a package", async () => {
    const bytes = Buffer.from("the BeePM copy")
    const sha256 = createHash("sha256").update(bytes).digest("hex")
    const all = {
        ...docs,
        "@me/mine": docOf("@me/mine", "MY_PACK", [v("1.0.0", { sha256, size: bytes.length })]),
    }
    const unset = fakeContext("own0", all)
    useBee2Folder(unset.paths, null)
    await assert.rejects(planInstall(unset, ["@me/mine"]), { code: "bee2_not_set" })

    const ctx = fakeContext("own1", all)
    ctx.api.downloadUrl = () => "https://dl.test/mine"
    ctx.fetch = async () => new Response(bytes)
    const mine = await fakePack(
        path.join(ctx.paths.bee2Dir, "packages", "Mine", "mine.bee_pack"),
        "MY_PACK",
    )

    const plan = await planInstall(ctx, ["@me/mine"])
    assert.deepEqual(plan.steps[0].replaces, [mine])
    assert.match(plan.warnings[0], /replaces mine\.bee_pack in BEE2's packages folder/)
    const result = await applyPlan(ctx, plan)
    assert.deepEqual(result.replaced, [{ name: "@me/mine", files: ["mine.bee_pack"] }])
    assert.equal(
        await readFile(path.join(ctx.paths.packages, "me@mine.bee_pack"), "utf8"),
        "the BeePM copy",
    )
    await assert.rejects(access(mine))
    await access(path.join(ctx.paths.replaced, "mine.bee_pack")) // kept, not deleted
})

test("the BEE2 check finds duplicates and the user's packages that are on BeePM", async () => {
    const ctx = fakeContext("check", docs)
    const folder = path.join(ctx.paths.bee2Dir, "packages")
    const oldA = await fakePack(path.join(folder, "a_old.bee_pack"), "A", {
        items: ["ITEM_X"],
        ago: 300,
    })
    const newA = await fakePack(path.join(folder, "New", "a.bee_pack"), "A", {
        items: ["ITEM_X"],
        ago: 10,
    })
    const b = await fakePack(path.join(folder, "b.bee_pack"), "B", {
        items: ["item_x", "ITEM_Y"],
        ago: 100,
    })
    await fakePack(path.join(folder, "c.bee_pack"), "C")
    // Installed from BeePM, and the user's own copy of it too
    const managed = await fakePack(path.join(ctx.paths.packages, "e@e.bee_pack"), "E", { ago: 50 })
    const ownE = await fakePack(path.join(folder, "e.bee_pack"), "E", { ago: 20 })
    await saveInstalled(ctx.paths, {
        packages: {
            "@e/e": { version: "1.0.0", explicit: true, file: "e@e.bee_pack", beeId: "E" },
        },
    })
    ctx.api.lookup = async ({ beeId }) => ({ packages: beeId === "C" ? ["@c/c"] : [] })

    const check = await checkBee2Packages(ctx)
    assert.deepEqual(
        check.duplicates.packages.map((g) => [g.id, g.copies.map((c) => c.path)]),
        [
            ["A", [newA, oldA]],
            ["E", [ownE, managed]],
        ],
    )
    assert.equal(check.duplicates.packages[1].copies[1].managed, true)
    assert.equal(check.duplicates.packages[0].copies[0].file, path.join("New", "a.bee_pack"))
    // ITEM_X is in A and B (item IDs ignore case); A's copies count once
    assert.deepEqual(
        check.duplicates.items.map((g) => [g.items, g.packages.map((p) => p.id)]),
        [[["ITEM_X"], ["A", "B"]]],
    )
    assert.deepEqual(check.onBeepm, [
        { id: "C", name: "Test package", file: "c.bee_pack", package: "@c/c" },
    ])
    assert.deepEqual((await checkBee2Packages(ctx, { keepOwn: ["C"] })).onBeepm, [])

    // "Delete duplicates" keeps the newest; choices keep others
    assert.deepEqual(duplicateRemovals(check.duplicates).sort(), [oldA, b, managed].sort())
    assert.deepEqual(
        duplicateRemovals(check.duplicates, { packages: { E: managed }, items: { 0: "B" } }).sort(),
        [newA, oldA, ownE].sort(),
    )

    // Removing BeePM's copy uninstalls it; the rest go to BeePM's backups
    const removed = await removePackageFiles(ctx, [
        managed,
        oldA,
        path.join(tmp.dir, "elsewhere.bee_pack"),
    ])
    assert.deepEqual(removed, { removed: [managed, oldA], uninstalled: ["@e/e"] })
    assert.deepEqual((await loadInstalled(ctx.paths)).packages, {})
    await access(path.join(ctx.paths.replaced, "a_old.bee_pack"))
    assert.equal(hasDuplicates((await checkBee2Packages(ctx)).duplicates), true) // B and A still clash
})

test("leaving the hook: BEE2's setting goes back, and its packages move into BEE2's folder", async () => {
    const env = {
        BEEPM_HOME: path.join(tmp.dir, "hooked", "home"),
        BEE2_CONFIG_DIR: path.join(tmp.dir, "hooked", "bee2-config"),
    }
    const paths = beepmPaths(env)
    const bee2 = await fakeBee2(path.join(tmp.dir, "hooked", "BEE2"))
    await fakePack(path.join(bee2, "packages", "clean_style.bee_pack"), "BEE2_CLEAN_STYLE")
    await fakePack(path.join(bee2, "packages", "mine.bee_pack"), "MINE")
    await mkdir(bee2Paths(env).configDir, { recursive: true })
    await writeFile(bee2Paths(env).configFile, `[Directories]\npackage = ${paths.hookedPackages}\n`)
    // What BEE2 loaded while hooked: an installed package, BEE2's own ones BeePM downloaded, and
    // imported copies
    const old = paths.hookedPackages
    await fakePack(path.join(old, "areng@items.bee_pack"), "ITEMS")
    await fakePack(path.join(old, "clean_style.bee_pack"), "BEE2_CLEAN_STYLE")
    await fakePack(path.join(old, "music.bee_pack"), "BEE2_MUSIC")
    await fakePack(path.join(old, "mine.local.bee_pack"), "MINE")
    await fakePack(path.join(old, "other.local.bee_pack"), "OTHER")
    // ...one imported from BEE2's own folder, still the same there
    const same = await fakePack(path.join(bee2, "packages", "same.bee_pack"), "SAME")
    await copyFile(same, path.join(old, "same.local.bee_pack"))
    await saveConfig(paths, {
        hook: { originalPackageDir: "packages/", hookedAt: "2026-10-07T19:37:14.426Z" },
        bee2: { version: "2.4.46.1", baseFiles: ["clean_style.bee_pack", "music.bee_pack"] },
    })
    await saveInstalled(paths, {
        packages: {
            "@areng/items": { version: "1.0.0", file: "areng@items.bee_pack", beeId: "ITEMS" },
        },
        local: {
            MINE: { file: "mine.local.bee_pack" },
            OTHER: { file: "other.local.bee_pack" },
            SAME: { file: "same.local.bee_pack", from: same, sha256: await hashFile(same) },
        },
    })

    const ctx = await createClientContext({ env })
    // "packages/" is in BEE2's folder: BeePM needs to see BEE2 run (or be told where it is)
    assert.deepEqual(await leaveHook(ctx), { done: false, waitingFor: "folder" })
    const program = path.join(bee2, "BEE2.exe")
    assert.deepEqual(await leaveHook(ctx, { program, running: true }), {
        done: false,
        waitingFor: "bee2", // it would write the hooked setting back when it closes
    })
    assert.equal(ctx.paths.bee2Dir, bee2)
    assert.deepEqual(await leaveHook(ctx), { done: true, moved: 1, restored: "packages/" })

    assert.equal(
        await readFile(bee2Paths(env).configFile, "utf8"),
        "[Directories]\npackage = packages/\n",
    )
    await access(path.join(bee2, "packages", "beepm", "areng@items.bee_pack"))
    await access(path.join(bee2, "packages", "music.bee_pack")) // BEE2 didn't have it
    await access(path.join(bee2, "packages", "other.local.bee_pack"))
    await access(path.join(paths.replaced, "mine.local.bee_pack")) // BEE2 had MINE
    await assert.rejects(access(path.join(paths.replaced, "same.local.bee_pack"))) // the very same
    await assert.rejects(access(old)) // emptied and gone
    assert.deepEqual(JSON.parse(await readFile(paths.config, "utf8")), {
        bee2: { dir: bee2, version: "2.4.46.1" },
    })
    assert.deepEqual((await loadInstalled(paths)).local, {})
    assert.equal(await leaveHook(ctx), null) // nothing left to do
})

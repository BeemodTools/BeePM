import assert from "node:assert/strict"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { after, before, test } from "node:test"
import {
    bee2Paths,
    bee2Status,
    beepmPaths,
    getIniValue,
    hookBee2,
    installBasePackages,
    InstallError,
    planInstall,
    removeIniKey,
    saveConfig,
    saveInstalled,
    setIniValue,
    unhookBee2,
} from "../src/client/index.js"
import { makeZip, tempDir } from "./helpers.js"

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

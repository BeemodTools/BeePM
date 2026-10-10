import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { after, before, test } from "node:test"
import { api, login, makePack, setup } from "./helpers.js"

const LEGACY = "https://legacy.example/registry.json"
let t
let adminToken
before(async () => {
    t = await setup({ LEGACY_REGISTRY_URL: LEGACY })
})
after(() => t.cleanup())

const json =
    (body, status = 200) =>
    () =>
        new Response(JSON.stringify(body), {
            status,
            headers: { "content-type": "application/json" },
        })
const file = (bytes) => () => new Response(bytes, { status: 200 })

test("publishing from a GitHub release the user owns (disallowed files are stripped)", async () => {
    const githubCode = t.profile({ provider: "github", username: "Areng14", id: "777" })
    const { token } = await login(t, githubCode, { handle: "areng14" })

    const pack = await readFile(
        await makePack(t.dir, {
            id: "ARENGS_PACKAGES",
            manifest: { name: "arengitems", author: "Areng14", version: "4.9.1" },
            extra: { "README.md": "# hi" },
        }),
    )
    const asset =
        "https://github.com/Areng14/ArengBeemodPackages/releases/download/v4.9.1/ArengItems.bee_pack"
    t.routes.set(
        "https://api.github.com/repos/Areng14/ArengBeemodPackages",
        json({
            full_name: "Areng14/ArengBeemodPackages",
            owner: { id: 777, login: "Areng14", type: "User" },
        }),
    )
    t.routes.set(
        "https://api.github.com/repos/Areng14/ArengBeemodPackages/releases/latest",
        json({
            tag_name: "v4.9.1",
            assets: [
                { name: "ArengItems.bee_pack", size: pack.length, browser_download_url: asset },
            ],
        }),
    )
    t.routes.set(asset, file(pack))

    const res = await api(t, token, "POST", "/v1/imports/github", {
        owner: "Areng14",
        repo: "ArengBeemodPackages",
    })
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(res.body.name, "@areng14/arengitems")
    assert.deepEqual(res.body.strippedFiles, ["README.md"])
    const docPath = "/v1/packages/@areng14/arengitems"
    const doc = await api(t, null, "GET", docPath)
    assert.equal(doc.body.versions["4.9.1"].source.repo, "Areng14/ArengBeemodPackages")
    assert.equal(doc.body.versions["4.9.1"].source.url, asset)
    // GitHub's file still has what was stripped: its checksum and size are kept, so clients can
    // download it from GitHub, check it and strip the same files
    const { source } = doc.body.versions["4.9.1"]
    assert.deepEqual(source.stripped, ["README.md"])
    assert.equal(source.sha256, createHash("sha256").update(pack).digest("hex"))
    assert.equal(source.size, pack.length)
    const downloadPath = `${docPath}/versions/4.9.1/download?from=github`
    const download = await api(t, null, "GET", downloadPath)
    assert.equal(download.status, 302)
    assert.equal(download.headers.location, asset)
    // Imports from before get the list from the audit record of their publish (migration 008);
    // without the release file's checksum they download from BeePM's copy
    await t.db.query("UPDATE versions SET source = source - 'stripped' - 'sha256' - 'size'")
    await t.db.exec(
        await readFile(
            new URL("../src/db/migrations/008_stripped_github_imports.sql", import.meta.url),
            "utf8",
        ),
    )
    const marked = await api(t, null, "GET", docPath)
    assert.deepEqual(marked.body.versions["4.9.1"].source.stripped, ["README.md"])
    const older = await api(t, null, "GET", downloadPath)
    assert.ok(!older.headers.location.startsWith("https://github.com/"))

    // Someone else's repo is refused
    const { token: other } = await login(t, t.profile({ username: "intruder" }), {
        handle: "intruder",
    })
    const refused = await api(t, other, "POST", "/v1/imports/github", {
        owner: "Areng14",
        repo: "ArengBeemodPackages",
    })
    assert.equal(refused.status, 403)

    // Discord-only accounts must link GitHub first
    const { token: discordOnly } = await login(
        t,
        t.profile({ provider: "discord", username: "dc" }),
        { provider: "discord", handle: "dc" },
    )
    const needsGithub = await api(t, discordOnly, "POST", "/v1/imports/github", {
        owner: "Areng14",
        repo: "ArengBeemodPackages",
    })
    assert.equal(needsGithub.body.error.code, "github_not_linked")
})

test("new GitHub releases are published by themselves once it's turned on", async () => {
    const { checkGithubWatches } = await import("../src/services/githubWatch.js")
    const code = t.profile({ provider: "github", username: "Watcher", id: "888" })
    const { token } = await login(t, code, { handle: "watcher" })
    const repoUrl = "https://api.github.com/repos/Watcher/Items"
    t.routes.set(
        repoUrl,
        json({ full_name: "Watcher/Items", owner: { id: 888, login: "Watcher", type: "User" } }),
    )

    /** Makes `tag` the latest release, with a .bee_pack of `version` (GitHub asset id `id`). */
    const release = async (tag, version, id, { name = "watched-items" } = {}) => {
        const bytes = await readFile(
            await makePack(t.dir, { id: "WATCHED_ITEMS", manifest: { name, version } }),
        )
        const url = `https://github.com/Watcher/Items/releases/download/${tag}/${id}.bee_pack`
        t.routes.set(
            `${repoUrl}/releases/latest`,
            json({
                tag_name: tag,
                assets: [
                    { id, name: "items.bee_pack", size: bytes.length, browser_download_url: url },
                ],
            }),
        )
        t.routes.set(url, file(bytes))
    }
    const check = () => checkGithubWatches(t.app.deps)
    const watchPath = "/v1/packages/@watcher/watched-items/github-watch"
    const watch = async () => (await api(t, token, "GET", watchPath)).body.watch
    const pkg = "@watcher/watched-items"

    // Publishing from GitHub with watch: true turns it on
    await release("v1.0.0", "1.0.0", 1)
    const first = await api(t, token, "POST", "/v1/imports/github", {
        owner: "Watcher",
        repo: "Items",
        watch: true,
    })
    assert.equal(first.status, 200, JSON.stringify(first.body))
    assert.equal(first.body.watching, true)
    assert.equal((await watch()).repo, "Watcher/Items")
    assert.deepEqual(await check(), [{ package: pkg, status: "unchanged" }])

    // A new release gets published by itself
    await release("v1.1.0", "1.1.0", 2)
    assert.deepEqual(await check(), [{ package: pkg, status: "published", version: "1.1.0" }])
    assert.equal((await api(t, null, "GET", `/v1/packages/${pkg}`)).body.latest, "1.1.0")

    // Asked for from GitHub, it downloads from the release itself, so it counts there too.
    // ?from=beepm (when GitHub's file fails) is BeePM's copy and isn't counted again; clients
    // from before (no `from`) get BeePM's copy
    const download = `/v1/packages/${pkg}/versions/1.1.0/download`
    const fromGithub = await api(t, null, "GET", `${download}?from=github`)
    assert.equal(fromGithub.status, 302)
    assert.equal(
        fromGithub.headers.location,
        "https://github.com/Watcher/Items/releases/download/v1.1.0/2.bee_pack",
    )
    for (const query of ["?from=beepm", ""]) {
        const res = await api(t, null, "GET", `${download}${query}`)
        assert.equal(res.status, 302)
        assert.ok(!res.headers.location.startsWith("https://github.com/"))
    }
    const counted = (await api(t, null, "GET", `/v1/packages/${pkg}`)).body.versions["1.1.0"]
    assert.equal(counted.downloads, 2) // from GitHub, and the client from before

    // One that forgot to raise "version" is refused once, and the owner can see why
    await release("v1.2.0", "1.1.0", 3)
    assert.equal((await check())[0].status, "failed")
    assert.match(
        (await watch()).error,
        /Release v1\.2\.0 wasn't published: .*1\.1\.0 already exists/,
    )
    assert.equal((await check())[0].status, "unchanged") // not retried every time

    // Replacing the release's .bee_pack with a fixed one is picked up
    await release("v1.2.0", "1.2.0", 4)
    assert.equal((await check())[0].status, "published")
    assert.equal((await watch()).error, null)

    // A release of a different package can't take this one over
    await release("v1.3.0", "1.3.0", 5, { name: "other-items" })
    assert.match(
        (await check())[0].error,
        /is for @watcher\/other-items, not @watcher\/watched-items/,
    )

    // Turning it off
    assert.equal((await api(t, token, "DELETE", watchPath)).status, 200)
    assert.equal(await watch(), null)
    assert.deepEqual(await check(), [])
})

test("importing the old registry creates unclaimed accounts their owners can log in to", async () => {
    const base = "https://legacy.example"
    const strip = await readFile(
        await makePack(t.dir, {
            id: "WIDE_LIGHT_STRIP",
            manifest: {
                name: "piecreepersitems",
                author: "PieCreeper12",
                version: "1.0.0",
                compatibleWith: ">=2.4.41",
            },
        }),
    )
    const hybrid = await readFile(
        await makePack(t.dir, {
            id: "AXO_HYBRID_STYLE",
            manifest: {
                name: "hybrid-style",
                author: "AxoLabs",
                version: "1.0.0",
                compatibleWith: ">=2.4.41 <2.4.46",
                dependencies: { "@beemod/BEE2_CLEAN_STYLE": "*" },
            },
        }),
    )
    t.routes.set(
        LEGACY,
        json({
            lastUpdated: "2026-01-30T08:28:40.185Z",
            packages: {
                by_name: {},
                by_id: {
                    WIDE_LIGHT_STRIP: {
                        author: "PieCreeper12",
                        name: "piecreepersitems",
                        versions: {
                            "1.0.0": {
                                path: "/packages/PieCreeper12/WIDE_LIGHT_STRIP/1.0.0/",
                                compatibleWith: ">=2.4.41",
                            },
                        },
                    },
                    AXO_HYBRID_STYLE: {
                        author: "AxoLabs",
                        name: "hybrid-style",
                        versions: {
                            "1.0.0": { path: "/packages/AxoLabs/AXO_HYBRID_STYLE/1.0.0/" },
                        },
                    },
                    BROKEN: {
                        author: "Ghost",
                        name: "broken",
                        versions: { "1.0.0": { path: "/packages/Ghost/BROKEN/1.0.0/" } },
                    },
                },
            },
        }),
    )
    t.routes.set(`${base}/github_packages.json`, json({ packages: {} }))
    t.routes.set(
        `${base}/packages/PieCreeper12/WIDE_LIGHT_STRIP/1.0.0/package.bee_pack`,
        file(strip),
    )
    t.routes.set(`${base}/packages/AxoLabs/AXO_HYBRID_STYLE/1.0.0/package.bee_pack`, file(hybrid))
    t.routes.set(
        "https://api.github.com/users/PieCreeper12",
        json({ id: 4242, login: "PieCreeper12", created_at: "2020-01-01T00:00:00Z" }),
    )
    t.routes.set(
        "https://api.github.com/users/AxoLabs",
        json({ id: 5151, login: "AxoLabs", created_at: "2021-01-01T00:00:00Z" }),
    )

    const { token: admin } = await login(t, t.profile({ username: "boss" }), { handle: "boss" })
    adminToken = admin
    const res = await api(t, admin, "POST", "/v1/admin/import-legacy")
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.equal(res.body.versions, 2)
    assert.equal(res.body.problems.length, 2) // Ghost isn't on GitHub, and its file is missing
    assert.ok(res.body.problems.some((p) => p.includes("Ghost")))

    const hybridDoc = await api(t, null, "GET", "/v1/packages/@axolabs/hybrid-style")
    assert.equal(hybridDoc.body.versions["1.0.0"].compatibleWith, ">=2.4.41 <2.4.46")
    assert.deepEqual(hybridDoc.body.versions["1.0.0"].dependencies, {
        "@beemod/BEE2_CLEAN_STYLE": "*",
    })
    assert.equal(hybridDoc.body.beeId, "AXO_HYBRID_STYLE")

    // Running it again changes nothing
    const again = await api(t, admin, "POST", "/v1/admin/import-legacy")
    assert.equal(again.body.versions, 0)
    assert.equal(again.body.skipped.length, 2)

    // PieCreeper12 logs in with the same GitHub account and lands on their packages
    const pie = await login(
        t,
        t.profile({ provider: "github", username: "PieCreeper12", id: "4242" }),
    )
    assert.equal(pie.user.handle, "piecreeper12")
    const user = await api(t, null, "GET", "/v1/users/piecreeper12")
    assert.deepEqual(
        user.body.packages.map((p) => p.name),
        ["@piecreeper12/piecreepersitems"],
    )
})

test("the old-registry import uses the owner's BeePM handle, not the old author name", async () => {
    // SomeGuy already has a BeePM account called @guy, with their GitHub account linked
    await login(t, t.profile({ provider: "github", username: "SomeGuy", id: "9090" }), {
        handle: "guy",
    })
    const pack = await readFile(
        await makePack(t.dir, {
            id: "GUY_ITEMS",
            manifest: { name: "guy-items", author: "SomeGuy", version: "1.0.0" },
        }),
    )
    const base = "https://legacy.example"
    t.routes.set(
        LEGACY,
        json({
            packages: {
                by_id: {
                    GUY_ITEMS: {
                        author: "SomeGuy",
                        name: "guy-items",
                        versions: { "1.0.0": { path: "/packages/SomeGuy/GUY_ITEMS/1.0.0/" } },
                    },
                },
            },
        }),
    )
    t.routes.set(`${base}/github_packages.json`, json({ packages: {} }))
    t.routes.set(`${base}/packages/SomeGuy/GUY_ITEMS/1.0.0/package.bee_pack`, file(pack))
    t.routes.set(
        "https://api.github.com/users/SomeGuy",
        json({ id: 9090, login: "SomeGuy", created_at: "2020-01-01T00:00:00Z" }),
    )

    const res = await api(t, adminToken, "POST", "/v1/admin/import-legacy")
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.deepEqual(res.body.imported, ["@guy/guy-items@1.0.0"])
    const doc = await api(t, null, "GET", "/v1/packages/@guy/guy-items")
    assert.deepEqual(doc.body.owners, ["guy"])
    assert.equal((await api(t, null, "GET", "/v1/packages/@someguy/guy-items")).status, 404)
})

test("where an imported version is on GitHub: its release's own URL, else pieced together", async () => {
    const { githubDownloadUrl } = await import("../src/routes/packages.js")
    // An import from before the URL was kept
    const old = {
        type: "github",
        repo: "Some-One/Their.Items",
        tag: "v1.0 beta",
        asset: "items pack.bee_pack",
    }
    assert.equal(
        githubDownloadUrl(old),
        "https://github.com/Some-One/Their.Items/releases/download/v1.0%20beta/items%20pack.bee_pack",
    )
    const url = "https://github.com/x/y/releases/download/v1/a.bee_pack"
    assert.equal(githubDownloadUrl({ ...old, url }), url)
    // Files stripped from it: only with the release file's checksum (clients check it)
    const stripped = ["README.md"]
    assert.equal(githubDownloadUrl({ ...old, url, stripped }), null)
    assert.equal(githubDownloadUrl({ ...old, url, stripped, sha256: "ab12" }), url)
    assert.equal(githubDownloadUrl({ ...old, repo: null }), null) // an old-registry entry without one
    assert.equal(githubDownloadUrl({ type: "upload" }), null)
})

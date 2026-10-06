import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { after, before, test } from "node:test"
import { api, login, makePack, setup } from "./helpers.js"

const LEGACY = "https://legacy.example/registry.json"
let t
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
    const doc = await api(t, null, "GET", "/v1/packages/@areng14/arengitems")
    assert.equal(doc.body.versions["4.9.1"].source.repo, "Areng14/ArengBeemodPackages")

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

test("importing BeePM 1's registry creates unclaimed accounts their owners can log in to", async () => {
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

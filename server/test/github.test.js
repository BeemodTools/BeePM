import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { api, login, setup } from "./helpers.js"

let t
before(async () => {
    t = await setup({ GITHUB_API_TOKEN: "registry-token" })
})
after(() => t.cleanup())

// The Authorization header of every request GitHub got
const seen = []
const json = (body) => (init) => {
    seen.push(init.headers?.Authorization)
    return new Response(JSON.stringify(body))
}

test("the registry looks GitHub up for publishing from releases, with its own token", async () => {
    const githubCode = t.profile({ provider: "github", username: "Maker", id: "4242" })
    const { token } = await login(t, githubCode, { handle: "maker" })
    const routes = {
        "/user/4242": { login: "Maker" },
        "/repos/Maker/items": { full_name: "Maker/items", private: false },
        // The registry's token might see private repositories: they're never looked up
        "/repos/Maker/secret": { full_name: "Maker/secret", private: true },
        "/repos/Maker/secret/releases?per_page=30": [],
        "/users/Maker/repos?type=owner&sort=pushed&per_page=100": [
            { owner: { login: "Maker" }, name: "items", full_name: "Maker/items" },
        ],
        "/users/Maker/orgs?per_page=100": [],
        "/repos/Maker/items/releases?per_page=30": [
            { tag_name: "v1", name: "One", assets: [{ name: "items.bee_pack" }] },
        ],
        "/repos/Maker/items/releases/tags/v1": {
            tag_name: "v1",
            assets: [
                {
                    name: "items.bee_pack",
                    size: 123,
                    browser_download_url: "https://dl.example/items",
                },
            ],
        },
    }
    for (const [path, body] of Object.entries(routes)) {
        t.routes.set(`https://api.github.com${path}`, json(body))
    }

    const repos = await api(t, token, "GET", "/v1/github/repos")
    assert.equal(repos.status, 200, JSON.stringify(repos.body))
    assert.deepEqual(
        repos.body.repos.map((r) => r.fullName),
        ["Maker/items"],
    )
    const releases = await api(t, token, "GET", "/v1/github/repos/Maker/items/releases")
    assert.deepEqual(
        releases.body.releases.map((r) => r.tag),
        ["v1"],
    )
    const asset = await api(
        t,
        token,
        "GET",
        "/v1/github/repos/Maker/items/asset?tag=v1&name=items.bee_pack",
    )
    assert.deepEqual(asset.body.asset, {
        name: "items.bee_pack",
        size: 123,
        url: "https://dl.example/items",
    })
    const missing = await api(
        t,
        token,
        "GET",
        "/v1/github/repos/Maker/items/asset?tag=v1&name=nope.bee_pack",
    )
    assert.equal(missing.status, 404)
    const secret = await api(t, token, "GET", "/v1/github/repos/Maker/secret/releases")
    assert.equal(secret.status, 404)

    // Always with the registry's token, and asking again comes from the cache
    assert.ok(seen.length && seen.every((auth) => auth === "Bearer registry-token"))
    const asked = seen.length
    await api(t, token, "GET", "/v1/github/repos")
    assert.equal(seen.length, asked)

    // Only for logged-in users with a linked GitHub account, and only real repository names
    assert.equal((await api(t, null, "GET", "/v1/github/repos")).status, 401)
    const discordOnly = await login(t, t.profile({ provider: "discord", username: "nogh" }), {
        handle: "nogh",
    })
    const unlinked = await api(t, discordOnly.token, "GET", "/v1/github/repos")
    assert.equal(unlinked.body.error.code, "github_not_linked")
    for (const path of [
        "/v1/github/repos/a.b/items/releases",
        "/v1/github/repos/Maker/a%20b/releases",
    ]) {
        assert.equal((await api(t, token, "GET", path)).status, 400, path)
    }
    // ".." never reaches GitHub (the router already turns it away)
    const askedBefore = seen.length
    assert.ok((await api(t, token, "GET", "/v1/github/repos/Maker/%2E%2E/releases")).status >= 400)
    assert.equal(seen.length, askedBefore)
})

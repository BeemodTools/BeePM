import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import {
    api,
    browser,
    browserToCallback,
    csrfOf,
    login,
    poll,
    postForm,
    setup,
    startLogin,
} from "./helpers.js"

let t
before(async () => {
    t = await setup()
})
after(() => t.cleanup())

test("a new user picks a handle and the app gets a token exactly once", async () => {
    const code = t.profile({ username: "Areng14" })
    const session = await startLogin(t, "BeePM Desktop on TEST-PC")
    assert.match(session.confirmCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
    assert.equal((await poll(t, session)).status, "pending")

    const { callback, browser: b } = await browserToCallback(t, session.url, code)
    assert.match(callback.body, /Create your account/)
    assert.match(callback.body, /value="areng14"/) // prefilled from the GitHub username
    assert.ok(callback.body.includes(session.confirmCode))
    assert.equal(callback.headers["x-frame-options"], "DENY")

    const res = await postForm(t, b, `/login/${session.id}/claim`, {
        csrf: csrfOf(callback.body),
        handle: "areng14",
    })
    assert.equal(res.statusCode, 200, res.body)

    const done = await poll(t, session)
    assert.equal(done.status, "done")
    assert.match(done.token, /^bpm_[A-Za-z0-9_-]{32}$/)
    assert.equal(done.user.handle, "areng14")
    assert.equal((await poll(t, session)).status, "expired") // no second token

    const me = await api(t, done.token, "GET", "/v1/me")
    assert.equal(me.status, 200)
    assert.equal(me.body.user.handle, "areng14")
    assert.deepEqual(
        me.body.identities.map((i) => i.provider),
        ["github"],
    )
    assert.equal(me.body.canPublish, true)

    // Logging in again with the same GitHub account finds the same user
    const again = await login(t, code)
    assert.equal(again.user.handle, "areng14")
})

test("handles are validated, unique and can't be reserved names", async () => {
    await login(t, t.profile({ username: "taken" }), { handle: "taken" })
    const session = await startLogin(t)
    const { callback, browser: b } = await browserToCallback(
        t,
        session.url,
        t.profile({ username: "newbie" }),
    )
    const csrf = csrfOf(callback.body)
    for (const [handle, message] of [
        ["taken", /already taken/],
        ["admin", /reserved/],
        ["beemod", /reserved/],
        ["no_underscores", /lowercase letters/],
        ["-dash", /lowercase letters/],
    ]) {
        const res = await postForm(t, b, `/login/${session.id}/claim`, { csrf, handle })
        assert.equal(res.statusCode, 400)
        assert.match(res.body, message)
    }
    const ok = await postForm(t, b, `/login/${session.id}/claim`, { csrf, handle: "NewBie" })
    assert.equal(ok.statusCode, 200)
    assert.equal((await poll(t, session)).user.handle, "newbie")
})

test("BOOTSTRAP_ADMINS handles become admins", async () => {
    const { token } = await login(t, t.profile({ username: "boss" }), { handle: "boss" })
    assert.equal((await api(t, token, "GET", "/v1/me")).body.user.role, "admin")
})

test("the flow is bound to one browser and forms need the CSRF token", async () => {
    const session = await startLogin(t)
    const first = browser()
    first.take(
        await t.app.inject({
            method: "GET",
            url: `/login/${session.id}`,
            headers: first.headers(),
        }),
    )

    const other = browser()
    const res = await t.app.inject({
        method: "GET",
        url: `/login/${session.id}`,
        headers: other.headers(),
    })
    assert.equal(res.statusCode, 403)
    assert.match(res.body, /another browser/)

    const code = t.profile({ username: "csrf-test" })
    const { callback } = await browserToCallback(t, session.url, code, "github", first)
    const bad = await postForm(t, first, `/login/${session.id}/claim`, {
        csrf: "wrong",
        handle: "csrf-test",
    })
    assert.equal(bad.statusCode, 403)
    assert.ok(csrfOf(callback.body))
})

test("cancelling in the browser tells the app", async () => {
    const session = await startLogin(t)
    const { callback, browser: b } = await browserToCallback(
        t,
        session.url,
        t.profile({ username: "quitter" }),
    )
    const res = await postForm(t, b, `/login/${session.id}/deny`, { csrf: csrfOf(callback.body) })
    assert.equal(res.statusCode, 200)
    assert.equal((await poll(t, session)).status, "denied")
})

test("wrong poll secrets and unknown sessions are rejected", async () => {
    const session = await startLogin(t)
    const res = await t.app.inject({
        method: "POST",
        url: `/v1/auth/sessions/${session.id}/poll`,
        payload: { secret: "nope" },
    })
    assert.equal(res.statusCode, 404)
    const page = await t.app.inject({ method: "GET", url: "/login/doesnotexist" })
    assert.equal(page.statusCode, 404)
})

test("linking adds a second login, and the rules around it hold", async () => {
    const github = t.profile({ username: "linker" })
    const { token } = await login(t, github, { handle: "linker" })

    const start = await api(t, token, "POST", "/v1/me/links", {
        clientName: "BeePM Test",
        client: "app",
    })
    assert.equal(start.status, 200)
    const discord = t.profile({ provider: "discord", username: "linker_dc" })
    const { callback, browser: b } = await browserToCallback(t, start.body.url, discord, "discord")
    assert.match(callback.body, /Link to @linker/)
    const res = await postForm(t, b, `/link/${start.body.id}/approve`, {
        csrf: csrfOf(callback.body),
    })
    assert.equal(res.statusCode, 200, res.body)
    const linked = await poll(t, start.body)
    assert.deepEqual(linked.identity, { provider: "discord", username: "linker_dc" })

    // Now either login works
    assert.equal((await login(t, discord, { provider: "discord" })).user.handle, "linker")

    // A Discord account linked elsewhere can't be linked again
    const { token: otherToken } = await login(t, t.profile({ username: "other-user" }), {
        handle: "other-user",
    })
    const second = await api(t, otherToken, "POST", "/v1/me/links", { clientName: "x" })
    const { callback: refused } = await browserToCallback(t, second.body.url, discord, "discord")
    assert.equal(refused.statusCode, 409)
    assert.match(refused.body, /linked to another BeePM account/)

    // Unlinking: fine while another login remains, refused for the last one
    const unlink = await api(t, token, "DELETE", "/v1/me/identities/github")
    assert.equal(unlink.status, 200)
    assert.deepEqual(
        unlink.body.identities.map((i) => i.provider),
        ["discord"],
    )
    const last = await api(t, token, "DELETE", "/v1/me/identities/discord")
    assert.equal(last.status, 409)
})

test("tokens: list, publish tokens, revoke and logout", async () => {
    const { token } = await login(t, t.profile({ username: "tokens" }), { handle: "tokens" })
    const created = await api(t, token, "POST", "/v1/me/tokens", {
        name: "GitHub Actions",
        days: 30,
    })
    assert.equal(created.status, 200)
    const ci = created.body.token

    // Publish tokens can't manage the account
    assert.equal((await api(t, ci, "GET", "/v1/me")).status, 200)
    assert.equal((await api(t, ci, "GET", "/v1/me/tokens")).status, 403)
    assert.equal((await api(t, ci, "POST", "/v1/me/links", { clientName: "x" })).status, 403)

    const list = await api(t, token, "GET", "/v1/me/tokens")
    assert.equal(list.body.tokens.length, 2)
    assert.equal(list.body.tokens.find((x) => x.current).kind, "session")

    assert.equal((await api(t, token, "DELETE", `/v1/me/tokens/${created.body.id}`)).status, 200)
    assert.equal((await api(t, ci, "GET", "/v1/me")).status, 401)

    assert.equal((await api(t, token, "DELETE", "/v1/auth/token")).status, 200)
    const after = await api(t, token, "GET", "/v1/me")
    assert.equal(after.status, 401)
    assert.equal(after.body.error.code, "invalid_token")
})

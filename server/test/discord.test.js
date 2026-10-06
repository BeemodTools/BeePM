import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { buildContainer, buildEmbed, COLORS, createDiscordLog } from "../src/services/discord.js"
import { api, login, makePack, publish, setup } from "./helpers.js"

const LOG = "https://discord.com/api/webhooks/111/log-token"
const RELEASES = "https://discord.com/api/webhooks/222/releases-token"

/** A fake Discord: records each webhook call, and answers with `reply(url, body)`. */
function fakeDiscord(reply = () => new Response(null, { status: 204 })) {
    const calls = []
    const fetch = async (url, init) => {
        const body = JSON.parse(init.body)
        calls.push({ url, body })
        return reply(url, body)
    }
    return { calls, fetch }
}

test("logs look like BEE Bot's: header, fields, footer, buttons", () => {
    const at = new Date(1_700_000_000_000)
    const container = buildContainer(
        {
            title: "Account Banned",
            description: "@spammer was banned.",
            color: COLORS.red,
            fields: [
                ["Account", "@spammer"],
                ["Empty", null],
                ["Reason", "x".repeat(2000)],
            ],
            thumbnailUrl: "https://cdn.example/avatar.png",
            footer: "Banned on",
            buttons: [{ label: "View release", url: "https://github.com/a/b/releases/tag/v1" }],
        },
        at,
    )
    assert.equal(container.type, 17)
    assert.equal(container.accent_color, 0xff3636)
    const [header, account, reason, footer, row] = container.components
    assert.equal(header.type, 9) // a section, with the avatar beside the header
    assert.equal(header.components[0].content, "## Account Banned\n@spammer was banned.")
    assert.equal(header.accessory.media.url, "https://cdn.example/avatar.png")
    assert.equal(account.content, "**Account**\n@spammer")
    assert.equal(reason.content.length, "**Reason**\n".length + 1024) // cut like an embed field
    assert.ok(reason.content.endsWith("..."))
    assert.equal(footer.content, "-# Banned on | <t:1700000000:f>")
    assert.deepEqual(row.components, [
        { type: 2, style: 5, label: "View release", url: "https://github.com/a/b/releases/tag/v1" },
    ])
    assert.equal(container.components.length, 5) // the empty field is left out

    const embed = buildEmbed({ title: "Account Unbanned", fields: [["Account", "@a"]] }, at)
    assert.deepEqual(embed.fields, [{ name: "Account", value: "@a", inline: false }])
    assert.equal(embed.timestamp, at.toISOString())
})

test("sending: Components V2 first, a classic embed if refused, waits when rate limited", async () => {
    const message = {
        title: "Package Restored",
        color: COLORS.green,
        fields: [["Package", "@a/b"]],
    }

    const ok = fakeDiscord()
    const discord = createDiscordLog({ webhooks: { log: LOG }, fetch: ok.fetch })
    discord.send("log", message)
    discord.send("releases", message) // no releases webhook: nothing happens
    await discord.flush()
    assert.equal(ok.calls.length, 1)
    assert.equal(ok.calls[0].url, `${LOG}?with_components=true`)
    assert.equal(ok.calls[0].body.flags, 1 << 15)
    assert.deepEqual(ok.calls[0].body.allowed_mentions, { parse: [] })
    assert.equal(ok.calls[0].body.components[0].components[0].content, "## Package Restored")

    const refused = fakeDiscord((url) =>
        url.includes("with_components")
            ? new Response("{}", { status: 400 })
            : new Response(null, { status: 204 }),
    )
    const fallback = createDiscordLog({ webhooks: { log: LOG }, fetch: refused.fetch })
    fallback.send("log", message)
    await fallback.flush()
    assert.equal(refused.calls[1].url, LOG)
    assert.equal(refused.calls[1].body.embeds[0].title, "Package Restored")

    let first = true
    const limited = fakeDiscord(() => {
        if (!first) return new Response(null, { status: 204 })
        first = false
        return new Response(JSON.stringify({ retry_after: 0.01 }), { status: 429 })
    })
    const patient = createDiscordLog({ webhooks: { log: LOG }, fetch: limited.fetch })
    patient.send("log", message)
    await patient.flush()
    assert.equal(limited.calls.length, 2) // the same message again after waiting

    const wrong = fakeDiscord()
    const ignored = createDiscordLog({
        webhooks: { log: "https://example.com/hook" },
        fetch: wrong.fetch,
    })
    assert.equal(ignored.enabled("log"), false)
})

let t
const posts = { log: [], releases: [] }
before(async () => {
    t = await setup({ DISCORD_LOG_WEBHOOK: LOG, DISCORD_RELEASES_WEBHOOK: RELEASES })
    for (const [channel, url] of [
        ["log", LOG],
        ["releases", RELEASES],
    ]) {
        t.routes.set(`${url}?with_components=true`, (init) => {
            posts[channel].push(JSON.parse(init.body).components[0])
            return new Response(null, { status: 204 })
        })
    }
})
after(() => t.cleanup())

/** Every log's header line ("## Title"), per channel, after they've all arrived. */
async function titles() {
    await t.app.deps.activity.settle()
    const of = (containers) =>
        containers.map((c) => {
            const header = c.components[0]
            return (header.components?.[0] ?? header).content.split("\n")[0]
        })
    return { log: of(posts.log), releases: of(posts.releases) }
}

test("registry activity reaches Discord: publishes, moderation, new accounts", async () => {
    const { token } = await login(t, t.profile({ username: "Maker" }), { handle: "maker" })
    const boss = (await login(t, t.profile({ username: "boss" }), { handle: "boss" })).token
    assert.deepEqual((await titles()).log, ["## New Account", "## New Account"])

    const published = await publish(
        t,
        token,
        await makePack(t.dir, { id: "MAKER_ITEMS", manifest: { name: "items", version: "1.0.0" } }),
    )
    assert.equal(published.status, 200, JSON.stringify(published.body))
    let seen = await titles()
    assert.equal(seen.log.at(-1), "## Package Published")
    assert.deepEqual(seen.releases, ["## New Package"])
    const announced = posts.releases[0].components.map((c) => c.content ?? "")
    assert.ok(announced.includes("**Package**\nTest (@maker/items)"))
    assert.ok(announced.includes("**Published by**\n@maker"))

    await api(t, token, "POST", "/v1/packages/@maker/items/versions/1.0.0/yank", {
        reason: "broken",
    })
    await api(t, boss, "PATCH", "/v1/admin/users/maker", { banned: true, banReason: "spam" })
    seen = await titles()
    assert.deepEqual(seen.log.slice(-2), ["## Version Yanked", "## Account Banned"])
    const ban = posts.log.at(-1).components.map((c) => c.content ?? "")
    assert.ok(ban.includes("**Reason**\nspam"))
    assert.ok(ban.includes("**Moderator**\n@boss"))
    assert.equal(posts.log.at(-1).accent_color, 0xff3636)
    assert.equal(seen.releases.length, 1) // moderation stays out of the public channel
})

/**
 * Discord logging in BEE Bot's style (see its logui.py): a Components V2 container with a
 * colored accent bar, a "## Title" header with a description, one bold-name block per field,
 * a small "-# footer | <time>" line, and link buttons at the bottom; a classic embed with the
 * same content if Discord refuses that. Mentions never ping anyone.
 *
 * Messages go to channel webhooks (no bot): DISCORD_LOG_WEBHOOK is the moderators' activity log,
 * DISCORD_RELEASES_WEBHOOK (optional) announces new versions. They're sent in the background,
 * one at a time per webhook, so Discord being slow or down never affects a request.
 */

// BEE Bot's colors
export const COLORS = {
    red: 0xff3636, // bans, removals, failures
    green: 0x36ff72, // publishes, restores, unbans
    orange: 0xff9900, // yanks, deprecations
    blue: 0x3698ff, // new accounts, owner and role changes
    quiet: 0x99aab5, // small account events
}

const FIELD_LIMIT = 1024 // like an embed field; keeps a message under Discord's 4000 characters
const DESCRIPTION_LIMIT = 2048
const MAX_QUEUED = 50
const WEBHOOK_URL =
    /^https:\/\/(?:canary\.|ptb\.)?(?:discord|discordapp)\.com\/api\/(?:v\d+\/)?webhooks\/\d+\/[\w-]+$/

const IS_COMPONENTS_V2 = 1 << 15
const NO_MENTIONS = { parse: [] }

const truncate = (value, limit = FIELD_LIMIT) => {
    const text = String(value)
    return text.length <= limit ? text : `${text.slice(0, limit - 3)}...`
}

/**
 * A log message: { title, description?, color?, fields?: [[name, value]], thumbnailUrl?,
 * footer?, buttons?: [{ label, url }] }. Fields without a value are left out.
 */
export function buildContainer(message, now = new Date()) {
    const { title, description, color, fields = [], thumbnailUrl, footer, buttons = [] } = message
    let header = `## ${title}`
    if (description) header += `\n${truncate(description, DESCRIPTION_LIMIT)}`
    const headerText = { type: 10, content: header }

    const components = [
        thumbnailUrl
            ? {
                  type: 9, // section: the header with the avatar beside it
                  components: [headerText],
                  accessory: { type: 11, media: { url: thumbnailUrl } },
              }
            : headerText,
    ]
    for (const [name, value] of fields) {
        if (value) components.push({ type: 10, content: `**${name}**\n${truncate(value)}` })
    }
    if (footer) {
        const time = Math.floor(now.getTime() / 1000)
        components.push({ type: 10, content: `-# ${footer} | <t:${time}:f>` })
    }
    if (buttons.length) {
        components.push({
            type: 1,
            components: buttons.map((b) => ({ type: 2, style: 5, label: b.label, url: b.url })),
        })
    }
    return { type: 17, ...(color === undefined ? {} : { accent_color: color }), components }
}

/** The same message as a classic embed (link buttons become links in the description). */
export function buildEmbed(message, now = new Date()) {
    const { title, description, color, fields = [], thumbnailUrl, footer, buttons = [] } = message
    const links = buttons.map((b) => `[${b.label}](${b.url})`).join(" · ")
    const text = [description, links].filter(Boolean).join("\n\n")
    return {
        title,
        ...(text ? { description: truncate(text, DESCRIPTION_LIMIT) } : {}),
        ...(color === undefined ? {} : { color }),
        fields: fields
            .filter(([, value]) => value)
            .map(([name, value]) => ({ name, value: truncate(value), inline: false })),
        ...(thumbnailUrl ? { thumbnail: { url: thumbnailUrl } } : {}),
        ...(footer ? { footer: { text: footer } } : {}),
        timestamp: now.toISOString(),
    }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Sends log messages to Discord webhooks: { log, releases } are webhook URLs (either may be
 * missing; invalid ones are ignored with a warning). send(channel, message) never throws.
 */
export function createDiscordLog({ webhooks = {}, fetch = globalThis.fetch, logger = null } = {}) {
    const urls = {}
    for (const [channel, url] of Object.entries(webhooks)) {
        if (!url) continue
        if (WEBHOOK_URL.test(url)) urls[channel] = url
        else logger?.warn?.(`Ignoring the Discord webhook for "${channel}": it isn't a webhook URL`)
    }
    const queues = new Map() // channel -> { tail: Promise, pending: number }

    async function post(url, body) {
        for (let attempt = 0; attempt < 3; attempt++) {
            const res = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            })
            if (res.status !== 429) return res
            // Rate limited: Discord says how long to wait
            const data = await res.json().catch(() => ({}))
            const seconds = Number(data.retry_after ?? res.headers.get("retry-after") ?? 1)
            await sleep(Math.min(Math.max(seconds, 0.1), 30) * 1000)
        }
        return null
    }

    async function deliver(url, message) {
        const now = new Date()
        const v2 = await post(`${url}?with_components=true`, {
            flags: IS_COMPONENTS_V2,
            allowed_mentions: NO_MENTIONS,
            components: [buildContainer(message, now)],
        })
        if (v2?.ok) return
        // Like BEE Bot: if the container is refused, the same log as a classic embed
        const embed = await post(url, {
            allowed_mentions: NO_MENTIONS,
            embeds: [buildEmbed(message, now)],
        })
        if (!embed?.ok) {
            logger?.warn?.(`Couldn't post "${message.title}" to Discord (HTTP ${embed?.status})`)
        }
    }

    return {
        enabled: (channel) => Boolean(urls[channel]),

        send(channel, message) {
            const url = urls[channel]
            if (!url) return
            const queue = queues.get(channel) ?? { tail: Promise.resolve(), pending: 0 }
            queues.set(channel, queue)
            if (queue.pending >= MAX_QUEUED) return // Discord is down: don't pile up forever
            queue.pending++
            queue.tail = queue.tail
                .then(() => deliver(url, message))
                .catch((err) => logger?.warn?.(`Discord log failed: ${err.message}`))
                .finally(() => queue.pending--)
        },

        /** Waits until everything sent so far has been delivered (tests, shutdown). */
        async flush() {
            await Promise.all([...queues.values()].map((queue) => queue.tail))
        },
    }
}

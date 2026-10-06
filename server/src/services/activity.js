import { parseName } from "@beepm/core"
import { COLORS } from "./discord.js"

const PROVIDERS = { discord: "Discord", github: "GitHub", dev: "Test account" }
const ERROR_REPEAT_MS = 10 * 60 * 1000

const reasonOf = (value) => value || "No reason provided"
const sizeOf = (bytes) => (bytes ? `${(bytes / 1048576).toFixed(1)} MB` : null)
const releaseUrl = (source) =>
    source?.type === "github" && source.repo && source.tag
        ? `https://github.com/${source.repo}/releases/tag/${encodeURIComponent(source.tag)}`
        : null

/** Where a version came from, in words. */
function sourceOf(source) {
    if (source?.type === "github") {
        const where = `GitHub ${source.repo} ${source.tag}`
        return source.automatic ? `${where} (automatic)` : where
    }
    return "Upload"
}

/**
 * Turns registry events into Discord logs (see discord.js): every audit log entry goes to the
 * moderators' log, new versions also go to the releases channel, and failed automatic GitHub
 * releases and server errors are logged too. Nothing here ever throws into a request.
 */
export function createActivityLog({ db, discord, logger = null }) {
    const errorsSeen = new Map() // message -> when it was last posted
    const working = new Set() // audit entries still being turned into logs

    async function userOf(id) {
        if (!id) return null
        const { rows } = await db.query(
            "SELECT handle, display_name, avatar_url FROM users WHERE id = $1",
            [id],
        )
        return rows[0] ?? null
    }

    /** One log in the moderators' channel, with who did it beside the title. */
    const log = (actor, message) =>
        discord.send("log", { thumbnailUrl: actor?.avatar_url ?? undefined, ...message })

    async function published(actor, target, details) {
        if (details.imported) return // the old-registry import: logged once, as a whole
        const at = target.lastIndexOf("@")
        const fullName = target.slice(0, at)
        const version = target.slice(at + 1)
        const { scope, name } = parseName(fullName)
        const { rows } = await db.query(
            `SELECT p.display_name, p.description, v.compatible_with
               FROM packages p JOIN versions v ON v.package_id = p.id
              WHERE p.scope = $1 AND p.name = $2 AND v.version = $3`,
            [scope, name, version],
        )
        const pkg = rows[0] ?? {}
        const github = releaseUrl(details.source)
        const buttons = github ? [{ label: "View release", url: github }] : []
        const by = actor ? `@${actor.handle}` : "Unknown"

        log(actor, {
            title: details.created ? "Package Published" : "Version Published",
            description: `${target} was published.`,
            color: COLORS.green,
            fields: [
                ["Package", fullName],
                ["Version", version],
                ["Published by", by],
                ["From", sourceOf(details.source)],
                ["Size", sizeOf(details.size)],
                [
                    "Removed files",
                    details.strippedFiles?.length ? String(details.strippedFiles.length) : null,
                ],
            ],
            footer: "Published on",
            buttons,
        })
        discord.send("releases", {
            title: details.created ? "New Package" : "New Version",
            description: pkg.description ?? null,
            color: COLORS.green,
            thumbnailUrl: actor?.avatar_url ?? undefined,
            fields: [
                ["Package", pkg.display_name ? `${pkg.display_name} (${fullName})` : fullName],
                ["Version", version],
                ["Published by", by],
                ["BEE2 versions", pkg.compatible_with ?? null],
            ],
            footer: "Published on",
            buttons,
        })
    }

    async function audit({ actorId, action, target, details }) {
        const d = details ?? {}
        const actor = await userOf(actorId)
        const by = actor ? `@${actor.handle}` : "Unknown"
        switch (action) {
            case "version.publish":
                return published(actor, target, d)
            case "version.yank":
                return log(actor, {
                    title: "Version Yanked",
                    color: COLORS.orange,
                    fields: [
                        ["Version", target],
                        ["Yanked by", by],
                        ["Reason", reasonOf(d.reason)],
                    ],
                    footer: "Yanked on",
                })
            case "version.unyank":
                return log(actor, {
                    title: "Version Unyanked",
                    color: COLORS.green,
                    fields: [
                        ["Version", target],
                        ["Unyanked by", by],
                    ],
                    footer: "Unyanked on",
                })
            case "version.unpublish":
                return log(actor, {
                    title: "Version Unpublished",
                    color: COLORS.red,
                    fields: [
                        ["Version", target],
                        ["Unpublished by", by],
                    ],
                    footer: "Unpublished on",
                })
            case "deprecate":
                return log(actor, {
                    title: target.includes("@", 1) ? "Version Deprecated" : "Package Deprecated",
                    color: COLORS.orange,
                    fields: [
                        ["Package", target],
                        ["Deprecated by", by],
                        ["Message", d.message],
                    ],
                    footer: "Deprecated on",
                })
            case "undeprecate":
                return log(actor, {
                    title: "Deprecation Removed",
                    color: COLORS.green,
                    fields: [
                        ["Package", target],
                        ["Removed by", by],
                    ],
                    footer: "Removed on",
                })
            case "owner.add":
                return log(actor, {
                    title: "Owner Added",
                    color: COLORS.blue,
                    fields: [
                        ["Package", target],
                        ["Owner", `@${d.handle}`],
                        ["Added by", by],
                    ],
                    footer: "Added on",
                })
            case "owner.remove":
                return log(actor, {
                    title: "Owner Removed",
                    color: COLORS.orange,
                    fields: [
                        ["Package", target],
                        ["Owner", `@${d.handle}`],
                        ["Removed by", by],
                    ],
                    footer: "Removed on",
                })
            case "admin.package.remove":
                return log(actor, {
                    title: "Package Removed",
                    description: `${target} was removed from the registry.`,
                    color: COLORS.red,
                    fields: [
                        ["Package", target],
                        ["Moderator", by],
                        ["Reason", reasonOf(d.reason)],
                    ],
                    footer: "Removed on",
                })
            case "admin.package.restore":
                return log(actor, {
                    title: "Package Restored",
                    color: COLORS.green,
                    fields: [
                        ["Package", target],
                        ["Moderator", by],
                    ],
                    footer: "Restored on",
                })
            case "admin.user.update":
                return userUpdated(actor, by, target, d)
            case "admin.import-legacy":
                return log(actor, {
                    title: "Old Registry Imported",
                    color: COLORS.blue,
                    fields: [
                        ["Packages", String(d.packages ?? 0)],
                        ["Versions", String(d.versions ?? 0)],
                        ["Problems", String(d.problems ?? 0)],
                        ["Moderator", by],
                    ],
                    footer: "Imported on",
                })
            case "user.create":
                return log(actor, {
                    title: "New Account",
                    color: COLORS.blue,
                    fields: [
                        ["Account", target],
                        ["Logged in with", `${PROVIDERS[d.provider] ?? d.provider}: ${d.username}`],
                    ],
                    footer: "Joined on",
                })
            case "identity.link":
                return log(actor, {
                    title: "Account Linked",
                    color: COLORS.quiet,
                    fields: [
                        ["Account", target],
                        ["Linked", `${PROVIDERS[d.provider] ?? d.provider}: ${d.username}`],
                    ],
                    footer: "Linked on",
                })
            case "identity.unlink":
                return log(actor, {
                    title: "Account Unlinked",
                    color: COLORS.quiet,
                    fields: [
                        ["Account", target],
                        ["Unlinked", PROVIDERS[d.provider] ?? d.provider],
                    ],
                    footer: "Unlinked on",
                })
            case "token.create":
                return log(actor, {
                    title: "Publish Token Created",
                    color: COLORS.quiet,
                    fields: [
                        ["Account", by],
                        ["Token", d.name],
                    ],
                    footer: "Created on",
                })
            case "package.github_watch.stop":
                return log(actor, {
                    title: "Automatic Releases Stopped",
                    color: COLORS.quiet,
                    fields: [
                        ["Package", target],
                        ["Stopped by", by],
                    ],
                    footer: "Stopped on",
                })
            default:
                return null // e.g. account.update: nicknames and pictures aren't worth a log
        }
    }

    function userUpdated(actor, by, target, d) {
        if (d.banned === true) {
            log(actor, {
                title: "Account Banned",
                description: `${target} was banned.`,
                color: COLORS.red,
                fields: [
                    ["Account", target],
                    ["Moderator", by],
                    ["Reason", reasonOf(d.banReason)],
                ],
                footer: "Banned on",
            })
        } else if (d.banned === false) {
            log(actor, {
                title: "Account Unbanned",
                color: COLORS.green,
                fields: [
                    ["Account", target],
                    ["Moderator", by],
                ],
                footer: "Unbanned on",
            })
        }
        if (d.role) {
            log(actor, {
                title: "Role Changed",
                color: COLORS.blue,
                fields: [
                    ["Account", target],
                    ["Role", d.role],
                    ["Moderator", by],
                ],
                footer: "Changed on",
            })
        }
        if (d.handle && `@${d.handle}` !== target) {
            log(actor, {
                title: "Handle Changed",
                color: COLORS.blue,
                fields: [
                    ["Account", `${target} → @${d.handle}`],
                    ["Moderator", by],
                ],
                footer: "Changed on",
            })
        }
    }

    return {
        /** An audit log entry was written: { actorId, action, target, details }. */
        audit(entry) {
            const job = audit(entry).catch((err) =>
                logger?.warn?.(`Activity log failed: ${err.message}`),
            )
            working.add(job)
            job.finally(() => working.delete(job))
        },

        /** Waits until every log so far has reached Discord (tests, shutdown). */
        async settle() {
            await Promise.all(working)
            await discord.flush()
        },

        /** An automatic GitHub release couldn't be published (see githubWatch.js). */
        releaseFailed({ fullName, repo, tag, error }) {
            discord.send("log", {
                title: "Automatic Release Failed",
                color: COLORS.red,
                fields: [
                    ["Package", fullName],
                    ["Repository", repo],
                    ["Release", tag],
                    ["Reason", error],
                ],
                footer: "Checked on",
                buttons: [
                    { label: "View release", url: releaseUrl({ type: "github", repo, tag }) },
                ],
            })
        },

        /** A request failed on the server. The same error is posted at most every 10 minutes. */
        serverError({ method, url, message }) {
            const now = Date.now()
            if (now - (errorsSeen.get(message) ?? 0) < ERROR_REPEAT_MS) return
            errorsSeen.set(message, now)
            if (errorsSeen.size > 200) errorsSeen.delete(errorsSeen.keys().next().value)
            discord.send("log", {
                title: "Server Error",
                color: COLORS.red,
                fields: [
                    ["Request", `${method} ${String(url).split("?")[0]}`],
                    ["Error", message],
                ],
                footer: "Failed on",
            })
        },
    }
}

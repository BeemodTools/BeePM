import { readFileSync } from "node:fs"
import cookie from "@fastify/cookie"
import formbody from "@fastify/formbody"
import Fastify, { LogController } from "fastify"
import { homePage, PAGE_HEADERS } from "./auth/pages.js"
import authRoutes from "./auth/routes.js"
import { onAudit } from "./lib/audit.js"
import { ApiError } from "./lib/errors.js"
import adminRoutes from "./routes/admin.js"
import githubRoutes from "./routes/github.js"
import manageRoutes from "./routes/manage.js"
import meRoutes from "./routes/me.js"
import packageRoutes from "./routes/packages.js"
import publishRoutes from "./routes/publish.js"
import { createActivityLog } from "./services/activity.js"
import { createDiscordLog } from "./services/discord.js"

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))

/**
 * Builds the API. Everything it talks to is passed in, so tests can use PGlite,
 * local storage and fake OAuth providers:
 *   { config, db, storage, providers, fetch }
 * Activity goes to Discord when DISCORD_LOG_WEBHOOK / DISCORD_RELEASES_WEBHOOK are set.
 */
export async function buildApp(deps) {
    const app = Fastify({
        logger: deps.logger ?? { level: deps.config.logLevel },
        trustProxy: true,
        bodyLimit: 1024 * 1024,
        // Request logs are written below without query strings (OAuth codes live there)
        logController: new LogController({ disableRequestLogging: true }),
    })
    app.decorate("deps", { fetch: globalThis.fetch, ...deps, log: app.log })
    app.decorateRequest("user", null)

    const webhooks = {
        log: deps.config.discordLogWebhook,
        releases: deps.config.discordReleasesWebhook,
    }
    const discord = createDiscordLog({ webhooks, fetch: app.deps.fetch, logger: app.log })
    // Which channels are on (never the URLs), so a missing or mistyped variable shows in the log
    const state = (channel, variable) =>
        discord.enabled(channel)
            ? "on"
            : `off (${variable} ${webhooks[channel] ? "isn't a webhook URL" : "isn't set"})`
    app.log.info(
        `Discord: activity log ${state("log", "DISCORD_LOG_WEBHOOK")}, new versions ${state("releases", "DISCORD_RELEASES_WEBHOOK")}`,
    )
    if (discord.enabled("log") || discord.enabled("releases")) {
        const activity = createActivityLog({ db: deps.db, discord, logger: app.log })
        onAudit(deps.db, (entry) => activity.audit(entry))
        app.deps.activity = activity
    }
    app.deps.discord = discord
    // Logs still on their way to Discord get there before the server stops
    app.addHook("onClose", () => app.deps.activity?.settle() ?? discord.flush())

    await app.register(cookie)
    await app.register(formbody)

    app.addHook("onResponse", async (request, reply) => {
        app.log.info(
            {
                method: request.method,
                path: request.url.split("?")[0],
                status: reply.statusCode,
                ms: Math.round(reply.elapsedTime),
            },
            "request",
        )
    })

    app.setErrorHandler((err, request, reply) => {
        if (err instanceof ApiError) {
            return reply.code(err.status).send({
                error: {
                    code: err.code,
                    message: err.message,
                    ...(err.details ? { details: err.details } : {}),
                },
            })
        }
        if (err.validation || err.statusCode === 400 || err.statusCode === 415) {
            return reply.code(400).send({ error: { code: "bad_request", message: err.message } })
        }
        if (err.statusCode === 413) {
            return reply
                .code(413)
                .send({ error: { code: "too_large", message: "Request body too large." } })
        }
        request.log.error({ err }, "request failed")
        app.deps.activity?.serverError({
            method: request.method,
            url: request.url,
            message: err.message,
        })
        return reply.code(500).send({
            error: { code: "internal", message: "Something went wrong on the server." },
        })
    })

    app.setNotFoundHandler((request, reply) =>
        reply.code(404).send({
            error: {
                code: "not_found",
                message: `No route for ${request.method} ${request.url.split("?")[0]}`,
            },
        }),
    )

    app.get("/health", async () => ({ ok: true }))

    app.get("/v1", async () => ({
        name: "BeePM registry",
        version,
        providers: Object.keys(deps.providers),
        limits: {
            maxUploadBytes: deps.config.maxUploadBytes,
            minAccountAgeDays: deps.config.minAccountAgeDays,
            unpublishHours: deps.config.unpublishHours,
        },
    }))

    app.get("/", async (request, reply) => reply.headers(PAGE_HEADERS).send(homePage()))

    await app.register(authRoutes)
    await app.register(meRoutes)
    await app.register(packageRoutes)
    await app.register(publishRoutes)
    await app.register(githubRoutes)
    await app.register(manageRoutes)
    await app.register(adminRoutes)
    if (deps.storage.routes) await app.register(deps.storage.routes)

    return app
}

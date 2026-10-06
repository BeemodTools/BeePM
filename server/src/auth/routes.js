import { audit } from "../lib/audit.js"
import { tooMany } from "../lib/errors.js"
import { randomId, safeEqual, sha256Hex } from "../lib/ids.js"
import { createRateLimiter } from "../lib/ratelimit.js"
import {
    addIdentity,
    createUser,
    findUserByIdentity,
    freeHandleFor,
    handleProblem,
} from "../services/users.js"
import { requireUser } from "./guard.js"
import {
    approvePage,
    choosePage,
    claimPage,
    devLoginPage,
    donePage,
    linkConfirmPage,
    messagePage,
    PAGE_HEADERS,
} from "./pages.js"
import { createAuthSession, getAuthSession, isExpired, pollAuthSession } from "./sessions.js"

/** An error shown to the person in the browser as a page. */
class PageError extends Error {
    constructor(status, title, message) {
        super(message)
        this.status = status
        this.title = title
    }
}

const cookieName = (sessionId) => `bpm_auth_${sessionId}`

export default async function authRoutes(app) {
    const { db, config, providers, log } = app.deps
    const startLimit = createRateLimiter({ limit: 30, windowMs: 10 * 60 * 1000 })

    // ---------- API used by the app and CLI ----------

    app.post("/v1/auth/sessions", async (request) => {
        if (!startLimit(request.ip))
            throw tooMany("Too many login attempts. Try again in a few minutes.")
        const { clientName, client } = request.body || {}
        return createAuthSession(db, config, { kind: "login", clientName, clientKind: client })
    })

    app.post("/v1/auth/sessions/:id/poll", async (request) => {
        return pollAuthSession(db, config, request.params.id, request.body?.secret)
    })

    app.delete("/v1/auth/token", async (request) => {
        const user = await requireUser(request)
        await db.query("UPDATE tokens SET revoked_at = now() WHERE id = $1", [user.tokenId])
        return { ok: true }
    })

    app.post("/v1/me/links", async (request) => {
        const user = await requireUser(request, { session: true })
        const { clientName, client } = request.body || {}
        return createAuthSession(db, config, {
            kind: "link",
            clientName,
            clientKind: client,
            userId: user.id,
        })
    })

    // ---------- Browser pages ----------

    const send = (reply, status, body) => reply.code(status).headers(PAGE_HEADERS).send(body)

    /** Wraps a page handler so PageErrors (and crashes) render as pages. */
    const pageRoute = (handler) => async (request, reply) => {
        try {
            return await handler(request, reply)
        } catch (err) {
            if (err instanceof PageError) {
                return send(reply, err.status, messagePage(err.title, err.message, { error: true }))
            }
            log.error({ err }, "auth page failed")
            return send(
                reply,
                500,
                messagePage("Something went wrong", "Please start the login again from BeePM.", {
                    error: true,
                }),
            )
        }
    }

    const providerList = (kind, id, excluded = []) =>
        Object.values(providers)
            .filter((p) => !excluded.includes(p.id))
            .map((p) => ({ id: p.id, label: p.label, href: `/${kind}/${id}/start/${p.id}` }))

    async function linkedProviders(userId) {
        const { rows } = await db.query("SELECT provider FROM identities WHERE user_id = $1", [
            userId,
        ])
        return rows.map((r) => r.provider)
    }

    async function userById(id) {
        const { rows } = await db.query("SELECT * FROM users WHERE id = $1", [id])
        return rows[0] || null
    }

    /**
     * Loads a pending session for the browser. The first browser to open the link gets a
     * cookie (bind = true); every later step must come from that same browser.
     */
    async function browserSession(request, reply, session, { bind = false } = {}) {
        if (!session)
            throw new PageError(
                404,
                "Link not found",
                "This link isn't valid. Start again from BeePM.",
            )
        if (isExpired(session)) {
            throw new PageError(
                410,
                "Link expired",
                "This link has expired. Start again from BeePM.",
            )
        }
        if (session.status !== "pending") {
            throw new PageError(
                410,
                "Link already used",
                "This link was already used. Start again from BeePM if you need to.",
            )
        }

        const cookie = request.cookies[cookieName(session.id)]
        if (!session.browser_hash && bind) {
            const value = randomId(24)
            const { rowCount } = await db.query(
                "UPDATE auth_sessions SET browser_hash = $2 WHERE id = $1 AND browser_hash IS NULL",
                [session.id, sha256Hex(value)],
            )
            if (rowCount === 1) {
                reply.setCookie(cookieName(session.id), value, {
                    path: "/",
                    httpOnly: true,
                    sameSite: "lax",
                    secure: config.publicUrl.startsWith("https://"),
                    maxAge: config.authSessionMinutes * 60,
                })
                return session
            }
            session = await getAuthSession(db, session.id)
        }
        if (
            !session.browser_hash ||
            !cookie ||
            !safeEqual(sha256Hex(cookie), session.browser_hash)
        ) {
            throw new PageError(
                403,
                "Different browser",
                "This link was opened in another browser. Start again from BeePM and finish in one browser.",
            )
        }
        return session
    }

    function checkCsrf(request, session) {
        if (!safeEqual(request.body?.csrf ?? "", session.csrf)) {
            throw new PageError(403, "Form expired", "Reload the page and try again.")
        }
    }

    async function sessionFor(request, reply, kind, options) {
        const session = await getAuthSession(db, request.params.id)
        return browserSession(request, reply, session?.kind === kind ? session : null, options)
    }

    for (const kind of ["login", "link"]) {
        // Step 1: choose Discord or GitHub
        app.get(
            `/${kind}/:id`,
            pageRoute(async (request, reply) => {
                const session = await sessionFor(request, reply, kind, { bind: true })
                if (kind === "login") {
                    return send(reply, 200, choosePage(session, providerList(kind, session.id)))
                }
                const user = await userById(session.user_id)
                const choices = providerList(kind, session.id, await linkedProviders(user.id))
                return send(reply, 200, choosePage(session, choices, { linkingTo: user.handle }))
            }),
        )

        // Step 2: go to the provider
        app.get(
            `/${kind}/:id/start/:provider`,
            pageRoute(async (request, reply) => {
                const session = await sessionFor(request, reply, kind)
                const provider = providers[request.params.provider]
                if (!provider)
                    throw new PageError(404, "Not available", "That login type isn't available.")
                const state = randomId(24)
                await db.query(
                    "UPDATE auth_sessions SET oauth_state = $2, oauth_provider = $3 WHERE id = $1",
                    [session.id, state, provider.id],
                )
                const redirectUri = `${config.publicUrl}/oauth/${provider.id}/callback`
                return reply.redirect(provider.authorizeUrl({ state, redirectUri }))
            }),
        )

        // Cancel
        app.post(
            `/${kind}/:id/deny`,
            pageRoute(async (request, reply) => {
                const session = await sessionFor(request, reply, kind)
                checkCsrf(request, session)
                await db.query("UPDATE auth_sessions SET status = 'denied' WHERE id = $1", [
                    session.id,
                ])
                return send(
                    reply,
                    200,
                    messagePage("Cancelled", "Nothing was changed. You can close this tab."),
                )
            }),
        )
    }

    if (providers.dev) {
        app.get("/dev-login", async (request, reply) =>
            send(reply, 200, devLoginPage(String(request.query?.state || ""))),
        )
    }

    // Step 3: the provider sends the browser back here
    app.get(
        "/oauth/:provider/callback",
        pageRoute(async (request, reply) => {
            const provider = providers[request.params.provider]
            const { code, state, error } = request.query || {}
            if (!provider || typeof state !== "string") {
                throw new PageError(
                    400,
                    "Invalid link",
                    "This login attempt isn't valid. Start again from BeePM.",
                )
            }
            const { rows } = await db.query("SELECT * FROM auth_sessions WHERE oauth_state = $1", [
                state,
            ])
            let session = await browserSession(request, reply, rows[0] || null)
            const { rowCount } = await db.query(
                "UPDATE auth_sessions SET oauth_state = NULL WHERE id = $1 AND oauth_state = $2",
                [session.id, state],
            )
            if (rowCount !== 1 || session.oauth_provider !== provider.id) {
                throw new PageError(
                    400,
                    "Invalid link",
                    "This login attempt isn't valid. Start again from BeePM.",
                )
            }
            if (error || typeof code !== "string") {
                // Cancelled on the provider's page: back to the choice
                return reply.redirect(`/${session.kind}/${session.id}`)
            }

            let profile
            try {
                profile = await provider.fetchProfile({
                    code,
                    redirectUri: `${config.publicUrl}/oauth/${provider.id}/callback`,
                })
            } catch (err) {
                log.warn({ err: err.message, provider: provider.id }, "OAuth profile fetch failed")
                throw new PageError(
                    502,
                    "Login failed",
                    `${provider.label} didn't accept the login: ${err.message}`,
                )
            }

            const owner = await findUserByIdentity(db, profile.provider, profile.providerId)

            if (session.kind === "link") {
                const user = await userById(session.user_id)
                if (owner?.id === user.id) {
                    throw new PageError(
                        409,
                        "Already linked",
                        `This ${provider.label} account is already linked to @${user.handle}.`,
                    )
                }
                if (owner) {
                    throw new PageError(
                        409,
                        "Already in use",
                        `This ${provider.label} account is linked to another BeePM account (@${owner.handle}). Unlink it there first.`,
                    )
                }
                if ((await linkedProviders(user.id)).includes(profile.provider)) {
                    throw new PageError(
                        409,
                        "Already linked",
                        `@${user.handle} already has a ${provider.label} account. Unlink it first to use a different one.`,
                    )
                }
                await db.query("UPDATE auth_sessions SET profile = $2 WHERE id = $1", [
                    session.id,
                    JSON.stringify(profile),
                ])
                return send(reply, 200, linkConfirmPage(session, profile, provider.label, user))
            }

            if (owner?.banned_at) {
                throw new PageError(
                    403,
                    "Account banned",
                    `@${owner.handle} is banned${owner.ban_reason ? `: ${owner.ban_reason}` : "."}`,
                )
            }
            await db.query("UPDATE auth_sessions SET profile = $2, user_id = $3 WHERE id = $1", [
                session.id,
                JSON.stringify(profile),
                owner?.id ?? null,
            ])
            session = { ...session, user_id: owner?.id ?? null }
            if (owner) return send(reply, 200, approvePage(session, profile, provider.label, owner))
            const handle = await freeHandleFor(db, profile.username)
            return send(reply, 200, claimPage(session, profile, provider.label, { handle }))
        }),
    )

    // Step 4a: new account
    app.post(
        "/login/:id/claim",
        pageRoute(async (request, reply) => {
            const session = await sessionFor(request, reply, "login")
            checkCsrf(request, session)
            const profile = session.profile
            if (!profile || session.user_id) {
                throw new PageError(400, "Start over", "Log in with Discord or GitHub first.")
            }
            const provider = providers[profile.provider]
            const handle = String(request.body?.handle || "")
                .trim()
                .toLowerCase()

            const problem = await handleProblem(db, handle)
            if (problem) {
                return send(
                    reply,
                    400,
                    claimPage(session, profile, provider.label, { handle, error: problem }),
                )
            }
            if (await findUserByIdentity(db, profile.provider, profile.providerId)) {
                throw new PageError(
                    409,
                    "Already registered",
                    "This account was just registered. Start the login again.",
                )
            }

            let user
            try {
                user = await createUser(db, {
                    handle,
                    profile,
                    role: config.bootstrapAdmins.includes(handle) ? "admin" : "user",
                })
            } catch (err) {
                if (err.code !== "23505") throw err
                return send(
                    reply,
                    409,
                    claimPage(session, profile, provider.label, {
                        handle,
                        error: `@${handle} was just taken. Pick another.`,
                    }),
                )
            }
            await db.query(
                "UPDATE auth_sessions SET status = 'approved', user_id = $2, profile = NULL WHERE id = $1",
                [session.id, user.id],
            )
            await audit(db, user.id, "user.create", `@${handle}`, {
                provider: profile.provider,
                username: profile.username,
            })
            return send(reply, 200, donePage(session, `Welcome, @${handle}!`))
        }),
    )

    // Step 4b: existing account (login) or confirming a link
    for (const kind of ["login", "link"]) {
        app.post(
            `/${kind}/:id/approve`,
            pageRoute((request, reply) => approve(kind, request, reply)),
        )
    }

    async function approve(kind, request, reply) {
        const session = await sessionFor(request, reply, kind)
        checkCsrf(request, session)
        const profile = session.profile
        const user = session.user_id ? await userById(session.user_id) : null
        if (!profile || !user)
            throw new PageError(400, "Start over", "Log in with Discord or GitHub first.")
        const provider = providers[profile.provider]

        if (kind === "link") {
            try {
                await db.tx(async (tx) => {
                    await addIdentity(tx, user.id, profile)
                    // No profile picture yet: use the one from the newly linked account
                    await tx.query(
                        `UPDATE users SET avatar_url = $2::text, avatar_source = $3
                          WHERE id = $1 AND avatar_url IS NULL AND avatar_source IS DISTINCT FROM 'none'
                            AND $2::text IS NOT NULL`,
                        [user.id, profile.avatarUrl ?? null, profile.provider],
                    )
                    await tx.query(
                        "UPDATE auth_sessions SET status = 'approved', profile = NULL, result = $2 WHERE id = $1",
                        [
                            session.id,
                            JSON.stringify({
                                identity: {
                                    provider: profile.provider,
                                    username: profile.username,
                                },
                            }),
                        ],
                    )
                })
            } catch (err) {
                if (err.code !== "23505") throw err
                throw new PageError(
                    409,
                    "Already linked",
                    `That ${provider.label} account is already linked to a BeePM account.`,
                )
            }
            await audit(db, user.id, "identity.link", `@${user.handle}`, {
                provider: profile.provider,
                username: profile.username,
            })
            return send(
                reply,
                200,
                donePage(session, `Linked ${provider.label} account ${profile.username}`),
            )
        }

        if (user.banned_at) throw new PageError(403, "Account banned", `@${user.handle} is banned.`)
        const linked = await db.tx(async (tx) => {
            const { rowCount } = await tx.query(
                `UPDATE identities SET username = $3, last_login_at = now(), avatar_url = $5
                      WHERE provider = $1 AND provider_id = $2 AND user_id = $4`,
                [
                    profile.provider,
                    profile.providerId,
                    profile.username,
                    user.id,
                    profile.avatarUrl,
                ],
            )
            if (rowCount !== 1) return false
            await tx.query(
                // The profile picture follows the provider it was chosen from (or the first one)
                `UPDATE users SET claimed_at = coalesce(claimed_at, now()),
                            avatar_url = CASE WHEN avatar_source = $5
                                                OR (avatar_source IS NULL AND avatar_url IS NULL)
                                              THEN $2::text ELSE avatar_url END,
                            avatar_source = CASE WHEN avatar_source IS NULL AND avatar_url IS NULL
                                                  AND $2::text IS NOT NULL
                                                 THEN $5 ELSE avatar_source END,
                            display_name = coalesce(display_name, $3),
                            role = CASE WHEN $4 THEN 'admin' ELSE role END
                      WHERE id = $1`,
                [
                    user.id,
                    profile.avatarUrl,
                    profile.displayName,
                    config.bootstrapAdmins.includes(user.handle),
                    profile.provider,
                ],
            )
            await tx.query(
                "UPDATE auth_sessions SET status = 'approved', profile = NULL WHERE id = $1",
                [session.id],
            )
            return true
        })
        if (!linked)
            throw new PageError(
                409,
                "Account changed",
                "That login was unlinked in the meantime. Start again from BeePM.",
            )
        return send(reply, 200, donePage(session, `Signed in as @${user.handle}`))
    }
}

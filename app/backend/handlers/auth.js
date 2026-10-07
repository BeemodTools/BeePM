import { randomUUID } from "node:crypto"
import { beginLogin, defaultClientName, RegistryError } from "@beepm/core/client"
import { AppError, isWebUrl, requireText } from "../util.js"

const PROVIDERS = { discord: "Discord", github: "GitHub" }
const providerName = (provider) => PROVIDERS[provider] ?? provider

/**
 * Browser login and account linking (DESIGN.md "Browser login"): the window shows the confirm
 * code while the browser is open, and gets an "auth:login-result" event when it's done.
 */
export function authHandlers(shared) {
    const { ctx, deps, log, step } = shared
    const api = ctx.api
    let flow = null // the login or link in progress: { id, controller }

    function cancelFlow() {
        flow?.controller.abort()
        flow = null
    }

    async function start(kind) {
        if (kind === "link" && !shared.login) {
            throw new AppError("Log in first.", { code: "login_required" })
        }
        cancelFlow()
        const session = await beginLogin(api, {
            client: "app",
            clientName: defaultClientName("app"),
            link: kind === "link",
        })
        const id = randomUUID()
        const controller = new AbortController()
        flow = { id, controller }
        const what = kind === "login" ? "Login" : "Linking"
        log.info(`${what} started in the browser`)

        session
            .wait({ signal: controller.signal })
            .then(async (result) => {
                if (flow?.id === id) flow = null
                if (kind === "login") {
                    await shared.saveLogin({ token: result.token, user: result.user })
                    log.info(`Logged in as @${result.user.handle}`)
                    deps.send("auth:login-result", { id, kind, ok: true, user: result.user })
                } else {
                    const identity = result.identity
                    log.info(
                        identity
                            ? `Linked ${providerName(identity.provider)} account ${identity.username}`
                            : "Linked an account",
                    )
                    deps.send("auth:login-result", {
                        id,
                        kind,
                        ok: true,
                        identity,
                    })
                }
            })
            .catch((err) => {
                if (flow?.id === id) flow = null
                if (err.reason === "aborted") log.info(`${what} cancelled`)
                else log.warn(`${what} failed: ${err.message}`)
                deps.send("auth:login-result", {
                    id,
                    kind,
                    ok: false,
                    reason: err.reason ?? err.code ?? "error",
                    error: err.message,
                })
            })

        // If the browser doesn't open, the window has an "Open browser again" button
        if (isWebUrl(session.url))
            await Promise.resolve(deps.openExternal(session.url)).catch(() => {})
        return {
            id,
            kind,
            confirmCode: session.confirmCode,
            url: session.url,
            expiresAt: session.expiresAt,
        }
    }

    return {
        /**
         * Who's logged in. A network error (or a registry outage) keeps the saved login and
         * reports offline: true; only a 401 means the login is gone.
         */
        "auth:status": async () => {
            const login = shared.login
            if (!login) return { loggedIn: false }
            try {
                const me = await api.me()
                if (
                    JSON.stringify(me.user) !== JSON.stringify(login.user) &&
                    shared.login === login
                ) {
                    await shared.saveLogin({ token: login.token, user: me.user }).catch(() => {})
                }
                return {
                    loggedIn: true,
                    offline: false,
                    user: me.user,
                    avatarSource: me.avatarSource ?? null,
                    identities: me.identities,
                    canPublish: me.canPublish,
                    publishBlockedReason: me.publishBlockedReason,
                    tokenKind: me.token?.kind ?? null,
                }
            } catch (err) {
                if (!(err instanceof RegistryError)) throw err
                if (err.status === 401) {
                    if (await shared.clearLogin(login)) {
                        log.info(
                            "The registry no longer accepts the saved login, so it was removed",
                        )
                    }
                    return { loggedIn: false, expired: true, message: err.message }
                }
                const saved = {
                    loggedIn: true,
                    user: login.user,
                    identities: null,
                    canPublish: false,
                    publishBlockedReason: null,
                }
                if (err.code === "banned") {
                    return {
                        ...saved,
                        banned: true,
                        publishBlockedReason: err.message,
                        error: err.message,
                    }
                }
                return { ...saved, offline: true, canPublish: null, error: err.message }
            }
        },

        /** Account settings: { displayName?, avatar?: "discord" | "github" | "none" } */
        "auth:update-profile": async (changes = {}) => {
            if (!shared.login) throw new AppError("Log in first.", { code: "login_required" })
            const body = {}
            if (changes?.displayName !== undefined) body.displayName = changes.displayName
            if (changes?.avatar !== undefined) body.avatar = changes.avatar
            const me = await step("Saving account settings", () => api.updateMe(body))
            await shared.saveLogin({ token: shared.login.token, user: me.user }).catch(() => {})
            return { user: me.user, identities: me.identities, avatarSource: me.avatarSource }
        },

        "auth:login": () => start("login"),
        "auth:link": () => start("link"),

        // With an id, only that login is cancelled (not one started since)
        "auth:cancel": async (id) => {
            if (!id || flow?.id === id) cancelFlow()
            return {}
        },

        "auth:unlink": async (provider) => {
            const name = requireText(provider, "Say which account to unlink.")
            const { identities } = await step(`Unlinking ${providerName(name)}`, () =>
                api.unlink(name),
            )
            return { identities }
        },

        // Revokes the token on the registry, then forgets it (even if the registry can't be reached)
        "auth:logout": () =>
            step("Logging out", async () => {
                cancelFlow()
                const revoked = shared.login
                    ? await api.logout().then(
                          () => true,
                          () => false,
                      )
                    : true
                if (!revoked) {
                    log.warn("Couldn't reach the registry, so the login was only removed here")
                }
                await shared.clearLogin()
                return { revoked }
            }),
    }
}

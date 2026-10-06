import { watch } from "node:fs"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { createClientContext, RegistryError } from "@beepm/core/client"
import { appHandlers } from "./handlers/app.js"
import { authHandlers } from "./handlers/auth.js"
import { bee2Handlers } from "./handlers/bee2.js"
import { manageHandlers } from "./handlers/manage.js"
import { adoptOldInstalls, packageHandlers } from "./handlers/packages.js"
import { publishHandlers } from "./handlers/publish.js"
import { registryHandlers } from "./handlers/registry.js"
import { createAppTokenStore } from "./tokenStore.js"
import { createLock, toFailure } from "./util.js"

/**
 * Everything the window can ask the main process to do, kept free of Electron so it can run
 * with stand-ins. `deps`:
 *   env, fetch, appVersion, safeStorage            (safeStorage encrypts the saved token)
 *   openExternal(url), openPath(dir), showOpenDialog(options)
 *   send(channel, payload)                         events for the window
 *
 * invoke(channel, ...args) never throws: it resolves to { ok: true, ...data } or
 * { ok: false, error, code?, problems?, ... }.
 */
export async function createBackend(deps = {}) {
    const {
        env = process.env,
        fetch = globalThis.fetch,
        appVersion = "0.0.0",
        safeStorage = null,
    } = deps
    const send = deps.send ?? (() => {})
    const ctx = await createClientContext({ env, fetch, userAgent: `beepm-app/${appVersion}` })
    const tokens = createAppTokenStore(
        path.join(ctx.paths.configDir, "credentials-app.json"),
        safeStorage,
    )

    const shared = {
        ctx,
        deps: {
            appVersion,
            send,
            openExternal: deps.openExternal ?? (async () => {}),
            openPath: deps.openPath ?? (async () => ""),
            showOpenDialog:
                deps.showOpenDialog ?? (async () => ({ canceled: true, filePaths: [] })),
        },
        lock: createLock(),
        disposers: [],
        login: null, // { registry, token, user, savedAt }

        get handle() {
            return this.login?.user?.handle ?? null
        },

        async saveLogin({ token, user }) {
            const login = { registry: ctx.registry, token, user, savedAt: new Date().toISOString() }
            await tokens.save(login)
            this.login = login
            ctx.api.setToken(token)
        },

        /** Forgets the login; with `expected`, only if that's still the current one. */
        async clearLogin(expected) {
            if (expected && this.login !== expected) return false
            this.login = null
            ctx.api.setToken(null)
            await tokens.clear()
            return true
        },
    }

    // A login saved for a different registry (e.g. BEEPM_REGISTRY in development) doesn't apply
    const saved = await tokens.load().catch(() => null)
    if (saved?.token && saved.registry === ctx.registry) {
        shared.login = saved
        ctx.api.setToken(saved.token)
    }

    const handlers = {
        ...appHandlers(shared),
        ...authHandlers(shared),
        ...registryHandlers(shared),
        ...packageHandlers(shared),
        ...bee2Handlers(shared),
        ...publishHandlers(shared),
        ...manageHandlers(shared),
    }

    /**
     * Tells the window when installed.json changes, including from outside the app (e.g.
     * `beepm install` in a terminal), so the installed list never goes stale.
     */
    async function watchInstalled() {
        await mkdir(ctx.paths.configDir, { recursive: true })
        const file = path.basename(ctx.paths.installed)
        let timer = null
        const watcher = watch(ctx.paths.configDir, (_event, name) => {
            if (name && name !== file) return
            clearTimeout(timer)
            timer = setTimeout(() => send("packages:changed", {}), 300)
        })
        watcher.on("error", () => watcher.close())
        shared.disposers.push(async () => {
            clearTimeout(timer)
            watcher.close()
        })
    }

    async function invoke(channel, ...args) {
        if (!Object.hasOwn(handlers, channel))
            return { ok: false, error: `Unknown request "${channel}".` }
        const login = shared.login
        try {
            return { ok: true, ...((await handlers[channel](...args)) ?? {}) }
        } catch (err) {
            // The registry no longer accepts this login (revoked or expired): forget it
            if (err instanceof RegistryError && err.status === 401 && login) {
                if (await shared.clearLogin(login).catch(() => false)) {
                    send("auth:changed", { loggedIn: false, reason: "expired" })
                }
            }
            return toFailure(err)
        }
    }

    return {
        ctx,
        handlers,
        invoke,
        get login() {
            return shared.login
        },
        /**
         * One-time work after the window opens: watching installed.json, and taking over
         * installs from earlier BeePM versions. Never throws.
         */
        startup: () => {
            watchInstalled().catch((err) =>
                console.warn(`Can't watch installed.json for changes: ${err.message}`),
            )
            return adoptOldInstalls(shared).catch((err) =>
                console.warn(
                    `Couldn't take over packages installed by an earlier BeePM version: ${err.message}`,
                ),
            )
        },
        /** Removes temporary files (prepared packages). */
        async dispose() {
            for (const dispose of shared.disposers) await dispose().catch(() => {})
        },
    }
}

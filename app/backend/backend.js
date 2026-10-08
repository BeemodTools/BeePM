import { watch } from "node:fs"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import {
    applyPlan,
    askBee2ToClose,
    bee2Status,
    createClientContext,
    findBee2Program,
    isBee2Running,
    outdated,
    planInstall,
    RegistryError,
} from "@beepm/core/client"
import semver from "semver"
import { appHandlers } from "./handlers/app.js"
import { authHandlers } from "./handlers/auth.js"
import { bee2Handlers } from "./handlers/bee2.js"
import { manageHandlers } from "./handlers/manage.js"
import { adoptOldInstalls, packageHandlers } from "./handlers/packages.js"
import { publishHandlers } from "./handlers/publish.js"
import { registryHandlers } from "./handlers/registry.js"
import { createSettings } from "./settings.js"
import { createAppTokenStore } from "./tokenStore.js"
import { createUpdateWatcher } from "./updateWatcher.js"
import { createLock, isExpected, listOf, toFailure } from "./util.js"

/** Stands in for the log when none is given (tests): only bugs are printed. */
const quietLog = {
    section: (_title, fn) => fn(),
    info() {},
    warn() {},
    error: (...args) => console.error(...args),
    debug() {},
    getLogsDirectory: () => null,
}

/**
 * Everything the window can ask the main process to do, kept free of Electron so it can run
 * with stand-ins. `deps`:
 *   env, fetch, appVersion, safeStorage            (safeStorage encrypts the saved token)
 *   openExternal(url), openPath(dir), showOpenDialog(options)
 *   send(channel, payload)                         events for the window
 *   log                                            the log file (logger.js)
 *   askUpdate({ name, from, to }), askClose(names), notify(text), openProgram(file),
 *   backgroundDefault, onSettingsChanged(settings) running in the background (updateWatcher.js)
 *   bee2Process                                    stand-ins for { isRunning, findProgram,
 *                                                  askToClose } (tests)
 *
 * invoke(channel, ...args) never throws: it resolves to { ok: true, ...data } or
 * { ok: false, error, code?, problems?, ... }. What changes something (installs, publishing,
 * BEE2 setup, ...) is a step in the log, with how it ended; failed requests and bugs are logged
 * too.
 */
export async function createBackend(deps = {}) {
    const {
        env = process.env,
        fetch = globalThis.fetch,
        appVersion = "0.0.0",
        safeStorage = null,
        log = quietLog,
    } = deps
    const send = deps.send ?? (() => {})
    const reported = new WeakSet() // errors whose step already logged them

    /**
     * Runs `fn` as a step in the log: its title, what's logged while it runs, then how it
     * ended. A bug's stack trace goes in the step too.
     */
    const step = (title, fn) =>
        log.section(title, async () => {
            try {
                return await fn()
            } catch (err) {
                if (!isExpected(err)) log.error(err)
                if (err && typeof err === "object") reported.add(err)
                throw err
            }
        })

    const bee2Process = {
        isRunning: isBee2Running,
        findProgram: findBee2Program,
        askToClose: askBee2ToClose,
        ...deps.bee2Process,
    }

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
        settings: createSettings(path.join(ctx.paths.configDir, "app-settings.json")),
        /** The settings the window sees: background filled in with its default. */
        async appSettings() {
            const settings = await this.settings.load()
            return {
                ...settings,
                background: settings.background ?? Boolean(deps.backgroundDefault),
            }
        },
        onSettingsChanged: deps.onSettingsChanged ?? (() => {}),

        /**
         * BEE2's program file (its folder holds BEE2's own packages folder): from BEE2 if it's
         * running, which is remembered, or else the one remembered. Null until BeePM sees BEE2 run.
         */
        async bee2Program() {
            if (await bee2Process.isRunning()) {
                const program = await bee2Process.findProgram()
                if (program) {
                    await this.rememberBee2(program)
                    return program
                }
            }
            return (await this.settings.load()).bee2Program ?? null
        },
        async rememberBee2(program) {
            if (program && (await this.settings.load()).bee2Program !== program) {
                await this.settings.update({ bee2Program: program })
            }
        },
        log,
        step,
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

    // In the background: offers updates when BEE2 opens (see updateWatcher.js)
    const watcher = createUpdateWatcher({
        log,
        isBee2Running: bee2Process.isRunning,
        async findBee2() {
            const program = await bee2Process.findProgram()
            await shared.rememberBee2(program).catch(() => {})
            return program
        },
        askBee2ToClose: bee2Process.askToClose,
        openBee2: deps.openProgram ?? (() => {}),
        ask: deps.askUpdate ?? (async () => "later"),
        askClose: deps.askClose ?? (async () => "later"),
        notify: deps.notify ?? (() => {}),
        // Updates that would reach BEE2 (it's hooked), except the ones not to ask about again
        async findUpdates() {
            if (!(await bee2Status(ctx.paths, ctx.bee2)).hooked) return []
            const { ignoredUpdates } = await shared.settings.load()
            return (await outdated(ctx))
                .filter((row) => row.wanted && semver.gt(row.wanted, row.current))
                .filter((row) => !ignoredUpdates.includes(row.name))
                .map((row) => ({ name: row.name, from: row.current, to: row.wanted }))
        },
        async ignore(name) {
            const { ignoredUpdates } = await shared.settings.load()
            await shared.settings.update({
                ignoredUpdates: [...new Set([...ignoredUpdates, name])],
            })
        },
        update: (names) =>
            shared.lock(() =>
                step(`Updating ${listOf(names, "packages")} for BEE2`, async () => {
                    const plan = await planInstall(ctx, names, { update: true })
                    for (const s of plan.steps) log.info(`${s.name} ${s.from} -> ${s.to}`)
                    await applyPlan(ctx, plan)
                    send("packages:changed", {})
                }),
            ),
    })

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
            if (!reported.has(err)) {
                if (isExpected(err)) log.warn(`${channel} failed: ${err.message}`)
                else log.error(`${channel} failed:`, err)
            }
            // The registry no longer accepts this login (revoked or expired): forget it
            if (err instanceof RegistryError && err.status === 401 && login) {
                if (await shared.clearLogin(login).catch(() => false)) {
                    log.info("The registry no longer accepts the saved login, so it was removed")
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
        watcher,
        appSettings: () => shared.appSettings(),
        get login() {
            return shared.login
        },
        /**
         * One-time work after the window opens: watching installed.json, and taking over
         * installs from earlier BeePM versions. Never throws.
         */
        startup: () => {
            log.info(`Registry: ${ctx.registry}`)
            log.info(`Packages folder: ${ctx.paths.packages}`)
            log.info(shared.login ? `Logged in as @${shared.handle}` : "Not logged in")
            watchInstalled().catch((err) =>
                log.warn(`Can't watch installed.json for changes: ${err.message}`),
            )
            // A failed step is in the log already
            return adoptOldInstalls(shared).catch(() => {})
        },
        /** Stops watching BEE2, and removes temporary files (prepared packages). */
        async dispose() {
            watcher.stop()
            for (const dispose of shared.disposers) await dispose().catch(() => {})
        },
    }
}

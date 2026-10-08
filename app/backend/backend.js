import { watch } from "node:fs"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { duplicateRemovals, hasDuplicates } from "@beepm/core"
import {
    applyPlan,
    askBee2ToClose,
    findBee2Folder,
    checkBee2Packages,
    createClientContext,
    exists,
    findBee2Program,
    findBee2Programs,
    isBee2Running,
    leaveHook,
    loadConfig,
    outdated,
    planInstall,
    RegistryError,
    removePackageFiles,
    setBee2Folder,
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
 *   trash(file)                                    deletes to the Recycle Bin (else: backups)
 *   ask(question), showReview(), notify(text), openProgram(file), backgroundDefault,
 *   onSettingsChanged(settings)                    running in the background (updateWatcher.js)
 *   bee2Process                                    stand-ins for { isRunning(folder?),
 *                                                  programs(), findProgram(folder?),
 *                                                  askToClose(folder?) } (tests)
 *
 * invoke(channel, ...args) never throws: it resolves to { ok: true, ...data } or
 * { ok: false, error, code?, problems?, ... }. What changes something (installs, publishing,
 * BEE2's packages, ...) is a step in the log, with how it ended; failed requests and bugs are
 * logged too.
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

    // BEE2's processes; given a folder, only the BEE2 from that folder (tests use stand-ins)
    const bee2Process = {
        isRunning: isBee2Running,
        programs: findBee2Programs,
        findProgram: findBee2Program,
        askToClose: askBee2ToClose,
        ...deps.bee2Process,
    }
    const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()

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
            openProgram: deps.openProgram ?? (() => {}),
            showOpenDialog:
                deps.showOpenDialog ?? (async () => ({ canceled: true, filePaths: [] })),
        },
        bee2Process,
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
         * BEE2's program file: from BEE2 if it's running, which is remembered, or else the one
         * remembered. Null until BeePM sees BEE2 run.
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

        /** BeePM's BEE2 is running, so its package files are open (any BEE2 without a folder). */
        isLocked() {
            return bee2Process.isRunning(ctx.paths.bee2Dir)
        },

        /**
         * Uses BEE2 from a folder (BEE2's, or one inside it): saved, with its version, and
         * BeePM's packages come along from the BEE2 it used before. What waited for BeePM to
         * know where BEE2 is happens now. Returns { dir, version, moved }.
         */
        async useBee2Folder(folder) {
            const result = await this.lock(() => setBee2Folder(ctx, folder))
            log.info(
                `BEE2: ${result.dir}, ${result.version ? `version ${result.version}` : "version unknown"}${result.moved ? `; moved ${result.moved} of BeePM's packages here` : ""}`,
            )
            await adoptOldInstalls(this).catch(() => {})
            await this.leaveHook().catch((err) => log.warn(err.message))
            send("packages:changed", {})
            return result
        },

        /** BEE2 IDs whose own copy the user keeps: not offered BeePM's version again. */
        async keepOwn(ids) {
            const { keepOwn } = await this.settings.load()
            await this.settings.update({ keepOwn: [...new Set([...keepOwn, ...ids])] })
        },

        /**
         * Earlier 1.0 builds hooked BEE2 to a folder of BeePM's own: this undoes it as soon as
         * it can (see core's leaveHook). What it's waiting for is kept in hookState.
         */
        hookState: null,
        async leaveHook() {
            const config = await loadConfig(ctx.paths)
            if (!config.hook && !(await exists(ctx.paths.hookedPackages))) {
                this.hookState = null
                return null
            }
            const running = await bee2Process.isRunning()
            const program = running || !ctx.paths.bee2Dir ? await this.bee2Program() : null
            const result = await this.lock(() => leaveHook(ctx, { program, running }))
            if (result?.done) {
                log.info(
                    `BEE2 isn't hooked anymore (packages folder: ${result.restored ?? "its default"}); moved ${result.moved} of BeePM's packages into ${ctx.paths.packages}`,
                )
                send("packages:changed", {})
                send("app:notice", {
                    severity: "success",
                    message:
                        "BEE2 loads its own packages folder again, with BeePM's packages in it.",
                })
            } else if (result && result.waitingFor !== this.hookState?.waitingFor) {
                log.info(
                    result.waitingFor === "bee2"
                        ? "BEE2 is hooked: that's undone once BEE2 closes"
                        : "BEE2 is hooked: that's undone once BeePM knows where BEE2 is",
                )
            }
            this.hookState = result?.done ? null : result
            return result
        },

        /** What the BEE2 check finds now (see core's checkBee2Packages), or null without BEE2. */
        async checkBee2() {
            const { keepOwn } = await this.settings.load()
            return checkBee2Packages(ctx, { keepOwn })
        },

        /**
         * Changes BEE2's packages the way the user chose, with BEE2 closed: removes duplicates
         * (to the Recycle Bin), installs BeePM's version of the user's own packages (theirs go
         * to BeePM's backups) and installs updates. Returns { removed, uninstalled, installed,
         * replaced }.
         */
        applyWork({ remove = [], adopt = [], update = [] }) {
            const parts = [
                remove.length &&
                    `deleting ${listOf(
                        remove.map((f) => path.basename(f)),
                        "duplicates",
                    )}`,
                adopt.length && `switching ${listOf(adopt, "packages")} to BeePM's`,
                update.length && `updating ${listOf(update, "packages")}`,
            ].filter(Boolean)
            const title = parts.join(", ").replace(/^./, (c) => c.toUpperCase())
            return this.lock(() =>
                step(title || "Nothing to change", async () => {
                    const result = { removed: [], uninstalled: [], installed: [], replaced: [] }
                    if (remove.length) {
                        Object.assign(
                            result,
                            await removePackageFiles(ctx, remove, {
                                remove: deps.trash ?? undefined,
                            }),
                        )
                        for (const file of result.removed) log.info(`Deleted ${file}`)
                        for (const name of result.uninstalled) log.info(`Uninstalled ${name}`)
                    }
                    const names = [...new Set([...adopt, ...update])]
                    if (names.length) {
                        const plan = await planInstall(ctx, names, { update: true })
                        for (const s of plan.steps)
                            log.info(`${s.name} ${s.from ?? "-"} -> ${s.to}`)
                        for (const warning of plan.warnings) log.info(warning)
                        const applied = await applyPlan(ctx, plan)
                        result.installed = applied.installed.map((s) => `${s.name}@${s.to}`)
                        result.replaced = applied.replaced
                    }
                    send("packages:changed", {})
                    return result
                }),
            )
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

    // In the background: looks at BEE2's packages when BEE2 opens (see updateWatcher.js)
    const watcher = createUpdateWatcher({
        log,
        isBee2Running: () => bee2Process.isRunning(),
        isLocked: () => shared.isLocked(),
        // A launched BEE2 that isn't BeePM's (or BeePM doesn't know one): its folder
        async whichBee2() {
            const dirs = (await bee2Process.programs()).map((program) => path.dirname(program))
            const current = ctx.paths.bee2Dir
            if (!dirs.length || (current && dirs.some((dir) => samePath(dir, current)))) {
                return { other: null }
            }
            const other = await findBee2Folder(dirs[0]).catch(() => dirs[0])
            const { ignoredBee2 } = await shared.settings.load()
            return { other, current, ignored: ignoredBee2.some((dir) => samePath(dir, other)) }
        },
        useBee2: (folder) => shared.useBee2Folder(folder),
        async ignoreBee2(folder) {
            const { ignoredBee2 } = await shared.settings.load()
            await shared.settings.update({ ignoredBee2: [...new Set([...ignoredBee2, folder])] })
        },
        // BeePM's BEE2, to open it again after closing it
        async findBee2() {
            const program = await bee2Process.findProgram(ctx.paths.bee2Dir)
            await shared.rememberBee2(program).catch(() => {})
            return program
        },
        askBee2ToClose: () => bee2Process.askToClose(ctx.paths.bee2Dir),
        openBee2: shared.deps.openProgram,
        ask: deps.ask ?? (async () => "later"),
        choose: deps.showReview ?? (() => {}),
        notify: deps.notify ?? (() => {}),
        async review() {
            const check = await shared.checkBee2()
            if (!check) return { duplicates: null, onBeepm: [], updates: [] }
            const duplicates = hasDuplicates(check.duplicates)
                ? {
                      count: check.duplicates.packages.length + check.duplicates.items.length,
                      remove: duplicateRemovals(check.duplicates),
                  }
                : null
            // Updates, except the ones not to ask about again (none if the registry is out of reach)
            const { ignoredUpdates } = await shared.settings.load()
            const rows = await outdated(ctx).catch((err) => {
                log.warn(`Couldn't check for updates: ${err.message}`)
                return []
            })
            const updates = rows
                .filter((row) => row.wanted && semver.gt(row.wanted, row.current))
                .filter((row) => !ignoredUpdates.includes(row.name))
                .map((row) => ({ name: row.name, from: row.current, to: row.wanted }))
            return { duplicates, onBeepm: check.onBeepm, updates }
        },
        keepOwn: (ids) => shared.keepOwn(ids),
        async ignore(name) {
            const { ignoredUpdates } = await shared.settings.load()
            await shared.settings.update({
                ignoredUpdates: [...new Set([...ignoredUpdates, name])],
            })
        },
        apply: (work) => shared.applyWork(work),
        // BEE2 just closed: a hook it kept from being undone can be now
        whenClosed: async () => {
            if (shared.hookState) await shared.leaveHook()
        },
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
         * One-time work after the window opens: watching installed.json, taking over installs
         * from earlier BeePM versions, and undoing the hook of earlier 1.0 builds. Never throws.
         */
        startup: () => {
            log.info(`Registry: ${ctx.registry}`)
            log.info(
                ctx.paths.bee2Dir ? `BEE2: ${ctx.paths.bee2Dir}` : "BEE2's folder isn't chosen yet",
            )
            log.info(shared.login ? `Logged in as @${shared.handle}` : "Not logged in")
            watchInstalled().catch((err) =>
                log.warn(`Can't watch installed.json for changes: ${err.message}`),
            )
            // A failed step is in the log already
            return adoptOldInstalls(shared)
                .catch(() => {})
                .then(() => shared.leaveHook())
                .catch((err) => log.warn(`Couldn't undo the hook yet: ${err.message}`))
        },
        /** Stops watching BEE2, and removes temporary files (prepared packages). */
        async dispose() {
            watcher.stop()
            for (const dispose of shared.disposers) await dispose().catch(() => {})
        },
    }
}

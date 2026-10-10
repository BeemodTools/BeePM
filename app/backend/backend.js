import { randomUUID } from "node:crypto"
import { watch } from "node:fs"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { duplicateRemovals, hasDuplicates } from "@beepm/core"
import {
    applyPlan,
    askBee2ToClose,
    bee2ErrorPackage,
    bee2LogProblems,
    findBee2Folder,
    checkBee2Packages,
    createClientContext,
    endLeftoverBee2,
    findBee2Program,
    fixPackageFolders,
    findBee2Programs,
    findLeftoverBee2,
    hasHook,
    isBee2Running,
    leaveHook,
    outdated,
    planInstall,
    readBee2Log,
    RegistryError,
    removePackageFiles,
    scanBee2,
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

const MAX_REVIEWS = 10

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
 *   showContents(name, version, title)             a "View contents" window
 *   ask(question), showReview(reviewId), notify(text), openProgram(file), backgroundDefault,
 *   onSettingsChanged(settings)                    running in the background (updateWatcher.js)
 *   bee2Process                                    stand-ins for { isRunning(folder?),
 *                                                  programs(), findProgram(folder?),
 *                                                  askToClose(folder?), leftovers(folder?),
 *                                                  endLeftovers(folder?) } (tests)
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
        leftovers: findLeftoverBee2,
        endLeftovers: endLeftoverBee2,
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
            showContents: deps.showContents ?? (() => {}),
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

        /** BEE2 checks shown to the user, by reviewId, so choices are made on what they saw. */
        reviews: new Map(),
        rememberReview(check) {
            const reviewId = randomUUID()
            this.reviews.set(reviewId, check)
            while (this.reviews.size > MAX_REVIEWS) {
                this.reviews.delete(this.reviews.keys().next().value)
            }
            return reviewId
        },

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
         * Ends what's left of BeePM's BEE2 after it crashed (see core's listBee2Processes),
         * which holds its package files open. Resolves to how many processes were ended.
         */
        async endLeftoverBee2() {
            if (!ctx.paths.bee2Dir) return 0
            const ended = await bee2Process.endLeftovers(ctx.paths.bee2Dir).catch((err) => {
                log.warn(`Couldn't end what's left of BEE2: ${err.message}`)
                return 0
            })
            if (ended) {
                log.info(
                    `Ended ${ended === 1 ? "a BEE2 process" : `${ended} BEE2 processes`} left after it crashed`,
                )
            }
            return ended
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
            this.readPackagesAhead()
            return result
        },

        /**
         * Reads BEE2's packages ahead of time, checking every file in the zips like "Check
         * packages", into the scan cache: checks after it only read what changed since. Done
         * when BeePM starts and when it learns where BEE2 is, in the background; a check made
         * meanwhile waits for it (see core's scanPackages). Never throws.
         */
        reading: null, // { dir, controller, done }
        readPackagesAhead() {
            const dir = ctx.paths.bee2Dir
            if (!dir) return Promise.resolve()
            if (this.reading?.dir === dir) return this.reading.done
            this.reading?.controller.abort() // BEE2's folder changed
            const controller = new AbortController()
            const started = Date.now()
            const done = scanBee2(ctx.paths, { deep: true, signal: controller.signal })
                .then((found) => {
                    const seconds = ((Date.now() - started) / 1000).toFixed(1)
                    log.info(`Read BEE2's ${found.length} packages ahead of time (${seconds} s)`)
                })
                .catch((err) => {
                    if (err?.name !== "AbortError") {
                        log.warn(`Couldn't read BEE2's packages ahead of time: ${err.message}`)
                    }
                })
                .finally(() => {
                    if (this.reading?.done === done) this.reading = null
                })
            this.reading = { dir, controller, done }
            return done
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
            if (!(await hasHook(ctx))) {
                this.hookState = null
                return null
            }
            const running = await bee2Process.isRunning()
            const program = running || !ctx.paths.bee2Dir ? await this.bee2Program() : null
            const result = await this.lock(() => leaveHook(ctx, { program, running }))
            const restored = result && "restored" in result
            const notice = (severity, message) => send("app:notice", { severity, message })
            if (restored) {
                log.info(
                    `BEE2 isn't hooked anymore (packages folder: ${result.restored ?? "its default"})`,
                )
            }
            if (result?.moved) {
                log.info(`Moved ${result.moved} of BeePM's packages into ${ctx.paths.packages}`)
                send("packages:changed", {})
                notice(
                    "success",
                    "BEE2 loads its own packages folder again, with BeePM's packages in it.",
                )
            } else if (restored && result.done) {
                notice("success", "BEE2 loads its own packages folder again.")
            } else if (restored) {
                notice(
                    "info",
                    "BEE2 loads its own packages folder again. Choose where BEE2 is in Settings to move BeePM's packages there.",
                )
            } else if (result && !result.done && result.waitingFor !== this.hookState?.waitingFor) {
                log.info(
                    result.waitingFor === "bee2"
                        ? "BEE2 is hooked: that's undone once BEE2 closes"
                        : "BeePM's packages move into BEE2's packages folder once BeePM knows where BEE2 is",
                )
            }
            this.hookState = result?.done ? null : result
            return result
        },

        /**
         * What the BEE2 check finds now (see core's checkBee2Packages), or null without BEE2.
         * deep: every file in the zips is checked too ("Check packages"; slower the first time).
         */
        async checkBee2({ deep = false } = {}) {
            const { keepOwn } = await this.settings.load()
            return checkBee2Packages(ctx, { keepOwn, deep })
        },

        /**
         * Changes BEE2's packages the way the user chose, with BEE2 closed: removes packages
         * (duplicates, ones BEE2 can't load; to the Recycle Bin), fixes zips with packages in
         * folders (fix: [{ file, folders }]), installs BeePM's version of the user's own packages
         * (theirs go to BeePM's backups) and installs updates. Returns { removed, uninstalled,
         * fixed: [{ file, created }], installed, replaced }.
         */
        applyWork({ remove = [], fix = [], adopt = [], update = [] }) {
            const parts = [
                remove.length &&
                    `deleting ${listOf(
                        remove.map((f) => path.basename(f)),
                        "packages",
                    )}`,
                fix.length &&
                    `fixing ${listOf(
                        fix.map((f) => path.basename(f.file)),
                        "packages",
                    )}`,
                adopt.length && `switching ${listOf(adopt, "packages")} to BeePM's`,
                update.length && `updating ${listOf(update, "packages")}`,
            ].filter(Boolean)
            const title = parts.join(", ").replace(/^./, (c) => c.toUpperCase())
            return this.lock(() =>
                step(title || "Nothing to change", async () => {
                    await this.endLeftoverBee2() // it has the files open
                    const result = {
                        removed: [],
                        uninstalled: [],
                        fixed: [],
                        installed: [],
                        replaced: [],
                    }
                    for (const { file, folders } of fix) {
                        const created = await fixPackageFolders(ctx, file, folders, {
                            remove: deps.trash ?? undefined,
                        })
                        for (const made of created) log.info(`Made ${made}`)
                        log.info(`Deleted ${file}`)
                        result.fixed.push({ file, created })
                    }
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

    /**
     * BEE2 writes its log the moment it starts, so watching its logs folder tells the watcher
     * right away (it looks every few seconds otherwise). Follows BEE2's folder; a logs folder
     * that isn't there yet (BEE2 never ran) is looked for again at the watcher's next look.
     */
    let logWatch = null // { dir, handle }
    function watchBee2Log() {
        const dir = ctx.paths.bee2Dir ? path.join(ctx.paths.bee2Dir, "logs") : null
        if (logWatch?.dir === dir) return
        logWatch?.handle.close()
        logWatch = null
        if (!dir) return
        try {
            const handle = watch(dir, () => watcher.poke())
            handle.unref()
            handle.on("error", () => {
                handle.close()
                if (logWatch?.handle === handle) logWatch = null
            })
            logWatch = { dir, handle }
        } catch {
            // Not there yet
        }
    }
    shared.disposers.push(async () => logWatch?.handle.close())
    // Reading packages ahead of time stops where it is (what it read is kept)
    shared.disposers.push(async () => {
        shared.reading?.controller.abort()
        await shared.reading?.done
    })

    // In the background: looks at BEE2's packages when BEE2 opens (see updateWatcher.js)
    let bee2WasRunning = null
    const watcher = createUpdateWatcher({
        log,
        // Every few seconds; BEE2's log tells sooner. The window hears when that changes (it
        // disables installing while BEE2 is open).
        isBee2Running: async () => {
            watchBee2Log()
            const running = await bee2Process.isRunning()
            if (bee2WasRunning !== null && running !== bee2WasRunning) send("bee2:changed", {})
            bee2WasRunning = running
            return running
        },
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
        // What's left of BeePM's BEE2 after it crashed, and ending it
        leftoverBee2: async () =>
            ctx.paths.bee2Dir ? bee2Process.leftovers(ctx.paths.bee2Dir) : [],
        endLeftovers: () => shared.endLeftoverBee2(),
        openBee2: shared.deps.openProgram,
        ask: deps.ask ?? (async () => "later"),
        // A window to choose in, showing the check the question came from
        choose: (found) => deps.showReview?.(found.reviewId ?? null),
        notify: deps.notify ?? (() => {}),
        async review() {
            // Updates, except the ones not to ask about again (none if the registry is out of reach)
            const [check, rows, { ignoredUpdates }] = await Promise.all([
                shared.checkBee2(),
                outdated(ctx).catch((err) => {
                    log.warn(`Couldn't check for updates: ${err.message}`)
                    return []
                }),
                shared.settings.load(),
            ])
            if (!check) return { duplicates: null, onBeepm: [], updates: [] }
            // "Choose" shows this check, not a new one
            const reviewId = shared.rememberReview(check)
            const duplicates = hasDuplicates(check.duplicates)
                ? {
                      count: check.duplicates.packages.length + check.duplicates.items.length,
                      remove: duplicateRemovals(check.duplicates),
                  }
                : null
            const updates = rows
                .filter((row) => row.wanted && semver.gt(row.wanted, row.current))
                .filter((row) => !ignoredUpdates.includes(row.name))
                .map((row) => ({ name: row.name, from: row.current, to: row.wanted }))
            return { duplicates, onBeepm: check.onBeepm, updates, reviewId }
        },
        keepOwn: (ids) => shared.keepOwn(ids),
        async ignore(name) {
            const { ignoredUpdates } = await shared.settings.load()
            await shared.settings.update({
                ignoredUpdates: [...new Set([...ignoredUpdates, name])],
            })
        },
        apply: (work) => shared.applyWork(work),
        // What broke BeePM's BEE2 (the log of its run), and the files of those packages in its
        // folder: the package BEE2 named, else the first one the error names (by its ID or an
        // item's). An error that names none comes with no files.
        async brokenPackages({ since }) {
            if (!ctx.paths.bee2Dir) return []
            const bee2Log = await readBee2Log(ctx.paths.bee2Dir, { since })
            if (!bee2Log) {
                log.info("BEE2 wrote no log for that run")
                return []
            }
            const logName = path.basename(bee2Log.file)
            const problems = bee2LogProblems(bee2Log.text)
            if (!problems.length) {
                log.info(`${logName} shows no errors`)
                return []
            }
            const packages = new Map() // package ID -> its copies
            const items = new Map() // item ID -> the IDs of the packages with it
            for (const pkg of await scanBee2(ctx.paths)) {
                if (!pkg.id) continue
                packages.set(pkg.id, [...(packages.get(pkg.id) ?? []), pkg])
                for (const item of pkg.items ?? []) {
                    items.set(item, new Set([...(items.get(item) ?? []), pkg.id]))
                }
            }
            const findPackage = (id) =>
                packages.has(id) ? id : items.get(id)?.size === 1 ? [...items.get(id)][0] : null
            const broken = new Map() // package ID (or a message without one) -> what's offered
            for (const { packageId, message } of problems) {
                const id = packages.has(packageId)
                    ? packageId
                    : bee2ErrorPackage(message, findPackage)
                if (!id) {
                    log.info(`${logName}: ${message} -> it names no package`)
                    broken.set(message, { name: null, files: [], message })
                    continue
                }
                const copies = packages.get(id)
                const files = copies.map((pkg) => pkg.path)
                const name = copies.find((pkg) => pkg.name)?.name ?? path.basename(files[0])
                log.info(
                    `${logName}: ${message} -> ${name} (${files.map((f) => path.basename(f)).join(", ")})`,
                )
                if (!broken.has(id)) broken.set(id, { name, files, message })
            }
            return [...broken.values()]
        },
        // BEE2's log of the run that was running then (it said what broke it)
        async openBee2Log({ since }) {
            const log = ctx.paths.bee2Dir ? await readBee2Log(ctx.paths.bee2Dir, { since }) : null
            if (log) await shared.deps.openPath(log.file)
        },
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
         * from earlier BeePM versions, undoing the hook of earlier 1.0 builds, then reading
         * BEE2's packages ahead of time. Never throws.
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
                .then(() => shared.readPackagesAhead())
        },
        /** Stops watching BEE2, and removes temporary files (prepared packages). */
        async dispose() {
            watcher.stop()
            for (const dispose of shared.disposers) await dispose().catch(() => {})
        },
    }
}

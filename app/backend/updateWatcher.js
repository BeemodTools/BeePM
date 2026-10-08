/**
 * BeePM in the background: when BEE2 opens, it looks at BEE2's packages and asks about what it
 * finds, in a small window in the corner:
 *   duplicates  packages BEE2 refuses to load together: "Delete duplicates" keeps the newest of
 *               each, "Choose" opens a window to pick in (what was found, not looked at again)
 *   onBeepm     packages the user added themselves that are on BeePM: "Use BeePM's" (BeePM's
 *               version gets updates) or "Keep mine" (not asked again); "Choose" with several
 *   updates     each of BeePM's packages with an update: Update, Not now, or Don't ask again
 * BEE2 has the package files open, so changing them waits for it: the user picks when it closes,
 * now (BEE2 is asked to close the way its close button does, and opened again after) or when
 * they close it themselves. BEE2 is never closed without asking.
 * A BEE2 from another folder than BeePM's (or before BeePM knows one) is asked about first:
 * "Use this BEE2" switches BeePM to it; otherwise it's left alone, not checked or closed.
 * When BeePM's BEE2 closes, its log says if a package broke it (it crashed, or couldn't load
 * packages): "Remove it" deletes that package and opens BEE2 again, or "Not now".
 * BEE2 can crash and leave its process running, without a window: that's BEE2 closed, not open.
 * What's left like that is ended once BEE2 opens again, or before its files are changed. If BeePM
 * didn't see that BEE2 run (it crashed right away, or before BeePM started), what broke it is
 * offered the same way.
 * Kept free of Electron:
 *   isBee2Running() (any BEE2, not what's left of one that crashed), isLocked() (BeePM's BEE2
 *   is running, so its files are open; optional, else isBee2Running), whichBee2() ->
 *   { other, current, ignored } (optional: the folder of a launched BEE2 that isn't BeePM's),
 *   useBee2(folder), ignoreBee2(folder), findBee2() -> BeePM's BEE2's program file or null,
 *   askBee2ToClose() -> whether it was asked, openBee2(file),
 *   review() -> { duplicates: { count, remove: [files] } | null, onBeepm: [{ id, name, package }],
 *                 updates: [{ name, from, to }], reviewId? },
 *   ask(question) -> the answer; question.kind: "duplicates" ("delete" | "choose" | "later"),
 *     "adopt" ("use" | "keep" | "choose" | "later"), "update" ("update" | "later" | "never"),
 *     "close" ("now" | "later"), "use-bee2" ("use" | "later" | "never"),
 *     "broken" ({ name, message }: "remove" | "later"), "crashed" ({ message }: what stopped
 *     BEE2 names no package; "log" | "later"),
 *   choose(found) (a window to choose in, for what review() found), keepOwn(ids), ignore(name),
 *   apply({ remove, adopt, update }), notify(text), log,
 *   brokenPackages({ since }) (optional) -> [{ name, files, message }]: what broke the BEE2 that
 *   was running then (ms), from the log of its run (no files: no package can be told),
 *   openBee2Log({ since }) (optional: shows that log),
 *   leftoverBee2() (optional) -> [{ pid, program, started, leftover }]: what's left of BeePM's
 *   BEE2 after it crashed (leftover: when its run ended), endLeftovers() (optional) ends it,
 *   whenClosed() (optional: BEE2 was just closed), sleep(ms) (optional)
 */

/** How long BEE2 ran, for the log: "3 s", "12 min", "2 h". */
const howLong = (ms) =>
    ms < 120 * 1000
        ? `${Math.max(0, Math.round(ms / 1000))} s`
        : ms < 120 * 60 * 1000
          ? `${Math.round(ms / 60000)} min`
          : `${Math.round(ms / 3600000)} h`

const noWork = () => ({ remove: [], adopt: [], update: [] })
const isEmpty = (work) => !work.remove.length && !work.adopt.length && !work.update.length
const merge = (a, b) => ({
    remove: [...new Set([...a.remove, ...b.remove])],
    adopt: [...new Set([...a.adopt, ...b.adopt])],
    update: [...new Set([...a.update, ...b.update])],
})

export function createUpdateWatcher(
    deps,
    {
        everyMs = 5000,
        graceMs = 30000,
        closeWaitMs = 2 * 60 * 1000,
        settleMs = 1000,
        reopenWithinMs = 2 * 60 * 1000,
    } = {},
) {
    const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    const isLocked = deps.isLocked ?? deps.isBee2Running
    let timer = null
    let wasRunning = false
    // After BeePM opens BEE2 again, it isn't looked at again (even if a check that started
    // while BEE2 was closed finishes late)
    let quietUntil = 0
    let offering = null // the offer in progress, if any
    let waiting = noWork() // to do once the user closes BEE2
    let installing = null // doing it
    // The BEE2 running now: { program (to open it again; null if it isn't BeePM's), since }
    let ours = null
    // What's left of BEE2s that crashed, already asked about ("<pid>:<started>")
    const handled = new Set()
    const leftoverKey = (proc) => `${proc.pid}:${proc.started}`

    /**
     * Looks at BEE2's packages and asks about them now (BEE2 just opened: `launched`, or
     * "Check for updates" in the tray). Resolves to the work the user chose, done now or once
     * BEE2 closes, or null if there was nothing to ask about.
     */
    function offer({ launched = false } = {}) {
        offering ??= offerNow(launched).finally(() => {
            offering = null
        })
        return offering
    }

    /** Does `work`, and what waited for BEE2 to close (it's closed now). */
    async function install(work) {
        const all = merge(waiting, work)
        waiting = noWork()
        await deps.apply(all)
    }

    /** Waits up to `ms` for BeePM's BEE2 to close (it may ask the user something first). */
    async function waitForExit(ms) {
        for (let waited = 0; await isLocked(); waited += 1000) {
            if (waited >= ms) return false
            await sleep(1000)
        }
        return true
    }

    async function askAbout(found) {
        const work = noWork()
        let choosing = false // BeePM's window shows both duplicates and packages on BeePM
        if (found.duplicates) {
            const answer = await deps.ask({ kind: "duplicates", count: found.duplicates.count })
            deps.log.info(`Duplicates (${found.duplicates.count}): ${answer}`)
            if (answer === "delete") work.remove.push(...found.duplicates.remove)
            else if (answer === "choose") choosing = true
        }
        if (found.onBeepm.length && !choosing) {
            const answer = await deps.ask({ kind: "adopt", packages: found.onBeepm })
            deps.log.info(`On BeePM: ${found.onBeepm.map((p) => p.package).join(", ")}: ${answer}`)
            if (answer === "use") work.adopt.push(...found.onBeepm.map((p) => p.package))
            else if (answer === "keep") await deps.keepOwn(found.onBeepm.map((p) => p.id))
            else if (answer === "choose") choosing = true
        }
        if (choosing) deps.choose(found)
        for (const update of found.updates) {
            const answer = await deps.ask({ kind: "update", ...update })
            deps.log.info(`Update ${update.name} ${update.from} -> ${update.to}: ${answer}`)
            if (answer === "update") work.update.push(update.name)
            else if (answer === "never") await deps.ignore(update.name)
        }
        return work
    }

    /** A launched BEE2 that isn't BeePM's: false if it's left alone. */
    async function sameBee2() {
        const running = await deps.whichBee2()
        if (!running.other) return true
        if (running.ignored) return false
        const answer = await deps.ask({
            kind: "use-bee2",
            folder: running.other,
            current: running.current ?? null,
        })
        deps.log.info(`BEE2 from ${running.other}: ${answer}`)
        if (answer === "use") {
            await deps.useBee2(running.other)
            return true
        }
        if (answer === "never") await deps.ignoreBee2(running.other)
        return false
    }

    async function offerNow(launched) {
        await installing?.catch(() => {}) // Its failure is check()'s to report
        if (launched && deps.whichBee2 && !(await sameBee2())) return null
        const found = await deps.review()
        if (!found.duplicates && !found.onBeepm.length && !found.updates.length) return null
        const work = await askAbout(found)
        if (isEmpty(work)) return work
        if (!(await isLocked())) {
            await install(work)
            return work
        }

        // BEE2 has the package files open
        const program = await deps.findBee2()
        const answer = await deps.ask({ kind: "close" })
        deps.log.info(`Close BEE2: ${answer}`)
        if (answer === "now") {
            // Not asked: closed already (by the user), or a dialog is open in it
            const asked = await deps.askBee2ToClose()
            if (await waitForExit(asked ? closeWaitMs : 0)) {
                try {
                    await install(work)
                } finally {
                    if (program) reopen(program)
                }
                return work
            }
            deps.log.info("BEE2 didn't close")
            deps.notify("BEE2 didn't close. BeePM finishes once you close it.")
        }
        waiting = merge(waiting, work)
        deps.log.info("Waiting for BEE2 to close")
        return work
    }

    /** BeePM opened BEE2 (again): what's looked at when it closes. */
    function reopen(program) {
        deps.openBee2(program)
        wasRunning = true
        quietUntil = Date.now() + graceMs
        ours = { program, since: Date.now() }
    }

    /**
     * BEE2 just closed: if a package broke it, removing it (and opening BEE2 again) is offered.
     * If what stopped BEE2 names no package, that's said, with its log a click away.
     */
    async function offerRemoval(run) {
        const broken = await deps.brokenPackages({ since: run.since }).catch((err) => {
            deps.log.warn(`Couldn't read BEE2's log: ${err.message}`)
            return []
        })
        const named = broken.filter((pkg) => pkg.files.length)
        if (!named.length && broken.length) {
            const { message } = broken[0]
            const answer = await deps.ask({ kind: "crashed", message })
            deps.log.info(`BEE2 stopped (${message}): ${answer}`)
            if (answer === "log") {
                await deps.openBee2Log?.({ since: run.since }).catch((err) => {
                    deps.log.warn(`Couldn't open BEE2's log: ${err.message}`)
                })
            }
            return
        }
        const remove = []
        for (const pkg of named) {
            const answer = await deps.ask({ kind: "broken", name: pkg.name, message: pkg.message })
            deps.log.info(`${pkg.name} broke BEE2 (${pkg.message}): ${answer}`)
            if (answer === "remove") remove.push(...pkg.files)
        }
        if (!remove.length) return
        await install({ ...noWork(), remove })
        if (run.program) reopen(run.program)
    }

    async function check() {
        const running = await deps.isBee2Running().catch(() => false)
        const opened = running && !wasRunning
        const closed = !running && wasRunning
        wasRunning = running
        if (closed && deps.whenClosed) {
            await deps.whenClosed().catch((err) => deps.log.warn(err.message))
        }
        // What waited is done once BeePM's BEE2 is closed (another one may still be open)
        if (!isEmpty(waiting) && !offering && !(running && (await isLocked()))) {
            deps.log.info("BEE2 closed: doing what waited for it")
            installing = install(noWork())
            try {
                await installing
            } finally {
                installing = null
            }
        }
        if (closed) {
            const run = ours
            ours = null
            deps.log.info(
                run ? `BEE2 closed after ${howLong(Date.now() - run.since)}` : "BEE2 closed",
            )
            if (run && deps.brokenPackages) {
                // What's left of it if it crashed is this run's: not asked about again below
                for (const proc of await leftovers()) handled.add(leftoverKey(proc))
                await offerRemoval(run)
            }
        } else if (!running && deps.brokenPackages) {
            // BEE2 crashed without BeePM seeing it run (right away, or before BeePM started), and
            // left its process behind
            const left = (await leftovers()).filter((proc) => !handled.has(leftoverKey(proc)))
            for (const proc of left) handled.add(leftoverKey(proc))
            if (left.length) {
                const ran = howLong(left[0].leftover - left[0].started)
                deps.log.info(`BEE2 crashed after ${ran} and was left running: looking at its log`)
                // It's opened again (after removing what broke it) only if that was just now
                const recent =
                    Date.now() - Math.max(...left.map((p) => p.leftover)) < reopenWithinMs
                // From the latest run's log (what broke one before may be gone by now)
                await offerRemoval({
                    program: recent ? left[0].program : null,
                    since: Math.max(...left.map((p) => p.started)),
                })
            }
        }
        if (opened) {
            // What's left of BEE2s that crashed before holds its files open
            await deps.endLeftovers?.().catch((err) => deps.log.warn(err.message))
            ours = deps.brokenPackages
                ? { program: await deps.findBee2().catch(() => null), since: Date.now() }
                : null
            if (Date.now() >= quietUntil) {
                deps.log.info("BEE2 opened: looking at its packages")
                await offer({ launched: true })
            }
        }
    }

    /** What's left of BeePM's BEE2 after it crashed (none without leftoverBee2). */
    async function leftovers() {
        if (!deps.leftoverBee2) return []
        return deps.leftoverBee2().catch((err) => {
            deps.log.warn(`Couldn't look for what's left of BEE2: ${err.message}`)
            return []
        })
    }

    // One check at a time: answering the questions, or installing, can take a while. A poke
    // during one checks again after it, unless that one saw BEE2 open.
    let checking = false
    let poked = false
    let settling = null // a check once BEE2's log is quiet
    async function run() {
        if (checking) return
        checking = true
        try {
            do {
                poked = false
                await check().catch((err) =>
                    deps.log.warn(`Checking BEE2's packages failed: ${err.message}`),
                )
            } while (poked && !wasRunning)
        } finally {
            checking = false
        }
    }

    return {
        offer,
        check,
        /**
         * BEE2 wrote its log: it may have just opened, so this checks now, not at the next look.
         * When it's open, it may have just crashed (it writes that last): this checks once its
         * log is quiet for a moment.
         */
        poke() {
            if (!timer) return
            if (wasRunning) {
                clearTimeout(settling)
                settling = setTimeout(run, settleMs)
                settling.unref?.()
                return
            }
            poked = true
            run()
        },
        start() {
            if (timer) return
            timer = setInterval(run, everyMs)
            timer.unref?.()
            run()
        },
        stop() {
            clearInterval(timer)
            clearTimeout(settling)
            timer = null
        },
    }
}

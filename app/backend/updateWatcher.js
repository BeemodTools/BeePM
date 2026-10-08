/**
 * BeePM in the background: when BEE2 opens, it asks about each installed package that has an
 * update ("Update", "Not now" or "Don't ask again" for that package). BEE2 keeps the package
 * files open, so while it's open the user picks when it closes: now (BEE2 is asked to close the
 * way its close button does, and opened again after updating) or when they close it themselves
 * (the updates are installed then). BEE2 is never closed without asking. Kept free of Electron:
 *   isBee2Running(), findBee2() -> program file or null, askBee2ToClose() -> whether it was
 *   asked, openBee2(file), findUpdates() -> [{ name, from, to }] (not the ignored ones),
 *   update(names), ask({ name, from, to }) -> "update" | "later" | "never",
 *   askClose(names) -> "now" | "later", ignore(name) ("Don't ask again"), notify(text), log,
 *   sleep(ms) (optional)
 */
export function createUpdateWatcher(
    deps,
    { everyMs = 5000, graceMs = 30000, closeWaitMs = 2 * 60 * 1000 } = {},
) {
    const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    let timer = null
    let wasRunning = false
    // After an update opens BEE2 again, it isn't asked about again (even if a check that started
    // while BEE2 was closed finishes late)
    let quietUntil = 0
    let offering = null // the offer in progress, if any
    let waiting = [] // updates to install once the user closes BEE2
    let installing = null // installing them

    /**
     * Asks about the updates now (BEE2 just opened, or "Check for updates" in the tray).
     * Resolves to the packages updated now, or null if there were no updates to ask about.
     */
    function offer() {
        offering ??= offerNow().finally(() => {
            offering = null
        })
        return offering
    }

    /** Installs `names`, and what waited for BEE2 to close (it's closed now). */
    async function install(names) {
        const all = [...new Set([...waiting, ...names])]
        waiting = []
        await deps.update(all)
    }

    /** Waits up to `ms` for BEE2 to close (it may ask the user something first). */
    async function waitForExit(ms) {
        for (let waited = 0; await deps.isBee2Running(); waited += 1000) {
            if (waited >= ms) return false
            await sleep(1000)
        }
        return true
    }

    async function offerNow() {
        await installing?.catch(() => {}) // Its failure is check()'s to report
        const updates = await deps.findUpdates()
        if (!updates.length) return null
        const chosen = []
        for (const update of updates) {
            const answer = await deps.ask(update)
            deps.log.info(`Update ${update.name} ${update.from} -> ${update.to}: ${answer}`)
            if (answer === "update") chosen.push(update.name)
            else if (answer === "never") await deps.ignore(update.name)
        }
        if (!chosen.length) return []
        if (!(await deps.isBee2Running())) {
            await install(chosen)
            return chosen
        }

        // BEE2 has the package files open
        const program = await deps.findBee2()
        const answer = await deps.askClose(chosen)
        deps.log.info(`Close BEE2 to update: ${answer}`)
        if (answer === "now") {
            // Not asked: closed already (by the user), or a dialog is open in it
            const asked = await deps.askBee2ToClose()
            if (await waitForExit(asked ? closeWaitMs : 0)) {
                try {
                    await install(chosen)
                } finally {
                    if (program) {
                        deps.openBee2(program)
                        wasRunning = true
                        quietUntil = Date.now() + graceMs
                    }
                }
                return chosen
            }
            deps.log.info("BEE2 didn't close")
            deps.notify("BEE2 didn't close. BeePM updates once you close it.")
        }
        waiting = [...new Set([...waiting, ...chosen])]
        deps.log.info(`Updating ${chosen.join(", ")} once BEE2 closes`)
        return []
    }

    async function check() {
        const running = await deps.isBee2Running().catch(() => false)
        const opened = running && !wasRunning
        wasRunning = running
        if (!running && waiting.length && !offering) {
            deps.log.info("BEE2 closed: installing the updates that waited for it")
            installing = install([])
            try {
                await installing
            } finally {
                installing = null
            }
        } else if (opened && Date.now() >= quietUntil) {
            deps.log.info("BEE2 opened: checking for updates")
            await offer()
        }
    }

    return {
        offer,
        check,
        start() {
            if (timer) return
            // One check at a time: answering the questions, or installing, can take a while
            let checking = false
            const run = async () => {
                if (checking) return
                checking = true
                try {
                    await check()
                } catch (err) {
                    deps.log.warn(`Checking for updates failed: ${err.message}`)
                } finally {
                    checking = false
                }
            }
            timer = setInterval(run, everyMs)
            timer.unref?.()
            run()
        },
        stop() {
            clearInterval(timer)
            timer = null
        },
    }
}

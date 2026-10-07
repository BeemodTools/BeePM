/**
 * BeePM in the background: when BEE2 opens, it asks about each installed package that has an
 * update ("Update", "Not now" or "Don't ask again" for that package). Updating closes BEE2,
 * installs the updates and opens BEE2 again, so it loads them. Kept free of Electron:
 *   isBee2Running(), findBee2() -> program file or null, closeBee2() -> whether it closed,
 *   openBee2(file), findUpdates() -> [{ name, from, to }] (not the ignored ones),
 *   update(names), ask({ name, from, to }) -> "update" | "later" | "never",
 *   ignore(name) ("Don't ask again"), log
 */
export function createUpdateWatcher(deps, { everyMs = 5000, graceMs = 30000 } = {}) {
    let timer = null
    let wasRunning = false
    // After an update opens BEE2 again, it isn't asked about again (even if a check that started
    // while BEE2 was closed finishes late)
    let quietUntil = 0
    let offering = null // the offer in progress, if any

    /**
     * Asks about the updates now (BEE2 just opened, or "Check for updates" in the tray).
     * Resolves to the packages updated, or null if there were no updates to ask about.
     */
    function offer() {
        offering ??= offerNow().finally(() => {
            offering = null
        })
        return offering
    }

    async function offerNow() {
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

        // BEE2 keeps the package files open, and only reads them when it starts
        const program = (await deps.isBee2Running()) ? await deps.findBee2() : null
        const closed = await deps.closeBee2()
        try {
            await deps.update(chosen)
        } finally {
            if (closed && program) {
                deps.openBee2(program)
                wasRunning = true
                quietUntil = Date.now() + graceMs
            }
        }
        return chosen
    }

    async function check() {
        const running = await deps.isBee2Running().catch(() => false)
        const opened = running && !wasRunning
        wasRunning = running
        if (opened && Date.now() >= quietUntil) {
            deps.log.info("BEE2 opened: checking for updates")
            await offer()
        }
    }

    return {
        offer,
        check,
        start() {
            if (timer) return
            const run = () =>
                check().catch((err) => deps.log.warn(`Checking for updates failed: ${err.message}`))
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

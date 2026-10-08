/**
 * Keeps BeePM itself up to date, from its GitHub releases (electron-updater; electron-builder.js
 * says where they are). It looks for a new version soon after BeePM starts and then every few
 * hours, downloads it in the background, and asks in the corner whether to restart now; if not,
 * the update is installed when BeePM quits (and asked about again at the next look).
 * Kept free of Electron:
 *   updater   electron-updater's autoUpdater (or a stand-in with the same events and methods)
 *   ask(version) -> "restart" | "later"
 *   log, onStatus(status) (optional: the status changed, for the window)
 * status: { phase: "idle" | "checking" | "downloading" | "ready" | "current" | "error", version?,
 *   percent?, error? }
 */
export function createAppUpdater(
    { updater, ask, log, onStatus = () => {} },
    { firstLookMs = 15 * 1000, everyMs = 6 * 60 * 60 * 1000 } = {},
) {
    let status = { phase: "idle" }
    let timers = []
    let asking = false

    const set = (next) => {
        status = next
        onStatus(status)
    }

    updater.autoDownload = true
    updater.autoInstallOnAppQuit = true
    updater.logger = { info() {}, warn: (text) => log.warn(String(text)), error() {}, debug() {} }

    updater.on("checking-for-update", () => set({ phase: "checking" }))
    updater.on("update-not-available", () => set({ phase: "current" }))
    updater.on("update-available", (info) => {
        log.info(`BeePM ${info.version} is out: downloading it`)
        set({ phase: "downloading", version: info.version, percent: 0 })
    })
    updater.on("download-progress", (progress) => {
        if (status.phase === "downloading") {
            set({ ...status, percent: Math.round(progress.percent ?? 0) })
        }
    })
    updater.on("update-downloaded", async (info) => {
        set({ phase: "ready", version: info.version })
        if (asking) return
        asking = true
        try {
            const answer = await ask(info.version)
            log.info(`BeePM ${info.version} downloaded: ${answer}`)
            if (answer === "restart") restart()
        } finally {
            asking = false
        }
    })
    updater.on("error", (err) => {
        log.warn(`Couldn't update BeePM: ${err?.message ?? err}`)
        set({ phase: "error", error: err?.message ?? String(err) })
    })

    /** Installs the downloaded update (silently, as it was installed) and starts BeePM again. */
    function restart() {
        updater.quitAndInstall(true, true)
    }

    /** Looks for a new version now (errors arrive as the "error" status). */
    function check() {
        return Promise.resolve(updater.checkForUpdates()).catch(() => {})
    }

    return {
        check,
        restart,
        status: () => status,
        start() {
            if (timers.length) return
            timers = [setTimeout(check, firstLookMs), setInterval(check, everyMs)]
            for (const timer of timers) timer.unref?.()
        },
        stop() {
            for (const timer of timers) clearTimeout(timer)
            timers = []
        },
    }
}

import { mkdir } from "node:fs/promises"
import { AppError, isWebUrl } from "../util.js"

export function appHandlers(shared) {
    const { ctx, deps, log } = shared
    return {
        "app:info": async () => ({
            version: deps.appVersion,
            registry: ctx.registry,
            packagesDir: ctx.paths.packages,
            platform: process.platform,
        }),

        // Only http(s) links: the window must not be able to launch other programs or files
        "app:open-external": async (url) => {
            if (!isWebUrl(url)) throw new AppError("Only web links can be opened.")
            await deps.openExternal(String(url))
            return {}
        },

        "app:open-packages-folder": async () => {
            await mkdir(ctx.paths.packages, { recursive: true })
            const problem = await deps.openPath(ctx.paths.packages)
            if (problem) throw new AppError(problem)
            return {}
        },

        "app:settings": async () => ({ settings: await shared.appSettings() }),

        // { background?: boolean, ignoredUpdates?: [package names] (to ask about them again) }
        "app:update-settings": async (changes = {}) => {
            const update = {}
            if (typeof changes?.background === "boolean") update.background = changes.background
            if (Array.isArray(changes?.ignoredUpdates)) {
                update.ignoredUpdates = changes.ignoredUpdates.filter((n) => typeof n === "string")
            }
            if (changes?.trayHintShown === true) update.trayHintShown = true
            await shared.settings.update(update)
            const settings = await shared.appSettings()
            log.info(`Settings: run in the background ${settings.background ? "on" : "off"}`)
            shared.onSettingsChanged(settings)
            return { settings }
        },

        "app:open-logs-folder": async () => {
            const dir = log.getLogsDirectory()
            if (!dir) throw new AppError("There's no logs folder.")
            const problem = await deps.openPath(dir)
            if (problem) throw new AppError(problem)
            return {}
        },
    }
}

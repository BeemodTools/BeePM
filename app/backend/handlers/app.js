import { mkdir } from "node:fs/promises"
import { AppError, isWebUrl } from "../util.js"

export function appHandlers({ ctx, deps, log }) {
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

        "app:open-logs-folder": async () => {
            const dir = log.getLogsDirectory()
            if (!dir) throw new AppError("There's no logs folder.")
            const problem = await deps.openPath(dir)
            if (problem) throw new AppError(problem)
            return {}
        },
    }
}

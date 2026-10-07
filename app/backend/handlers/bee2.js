import {
    bee2Status,
    hookBee2,
    installBasePackages,
    listBee2Releases,
    loadConfig,
    refreshBaseIds,
    saveConfig,
    unhookBee2,
} from "@beepm/core/client"
import { AppError, fileSize, requireText, throttle } from "../util.js"

/** What the window needs to know about config.bee2 (BEE2 version and its base packages). */
function setupSummary(config) {
    const bee2 = config.bee2
    if (!bee2) return null
    return {
        version: bee2.version ?? null,
        name: bee2.name ?? null,
        itemsTag: bee2.itemsTag ?? null,
        basePackageCount: bee2.basePackages?.length ?? 0,
        installedAt: bee2.installedAt ?? null,
        fromLegacy: Boolean(bee2.fromLegacy),
    }
}

/**
 * BEE2 setup and hooking. hookBee2, unhookBee2 and installBasePackages change the config
 * object, so every change is followed by saveConfig.
 */
export function bee2Handlers(shared) {
    const { ctx, deps, log, step } = shared
    let settingUp = false

    /** What hooking or unhooking did, in the log. */
    function logHook(result, unchanged) {
        if (result.closedBee2) log.info("Closed BEE2")
        if (!result.changed) log.info(unchanged)
        if (result.restored) log.info(`BEE2's packages folder is ${result.restored} again`)
    }

    return {
        "bee2:status": async () => {
            const [status, config] = await Promise.all([
                bee2Status(ctx.paths, ctx.bee2),
                loadConfig(ctx.paths),
            ])
            // Setups made before BeePM could read BEE2's LZMA packages have no IDs yet
            if (await refreshBaseIds(ctx.paths, config).catch(() => false)) {
                await saveConfig(ctx.paths, config)
            }
            return {
                ...status,
                packagesDir: ctx.paths.packages,
                configFile: ctx.bee2.configFile,
                bee2: setupSummary(config),
            }
        },

        "bee2:releases": async () => ({ releases: await listBee2Releases({ fetch: ctx.fetch }) }),

        /**
         * Downloads BEE2's own packages for a version, then hooks BEE2. Sends "bee2:progress"
         * events: { step: "plan", assets } (every download, packages before music), { step:
         * "closed-bee2" } if BEE2 was running, { step: "download" | "extract", asset, received,
         * total }, then { step: "hook" }.
         */
        "bee2:setup": async (options = {}) => {
            const version = requireText(options?.version, "Pick a BEE2 version.").replace(/^v/i, "")
            if (settingUp) throw new AppError("BEE2 is already being set up.")
            settingUp = true
            const report = throttle((progress) => deps.send("bee2:progress", progress), {
                key: (p) => `${p.step}:${p.asset ?? ""}`,
            })
            const onProgress = (progress) => {
                if (progress.step === "plan") {
                    const files = progress.assets.map((a) => `${a.name} (${fileSize(a.size)})`)
                    log.info(`Downloading ${files.join(", ")}`)
                } else if (progress.step === "closed-bee2") {
                    log.info("Closed BEE2")
                }
                report(progress)
            }
            try {
                return await shared.lock(() =>
                    step(`Setting up BEE2 ${version}`, async () => {
                        const config = await loadConfig(ctx.paths)
                        await installBasePackages(ctx.paths, config, {
                            version,
                            name: typeof options.name === "string" ? options.name : null,
                            includeMusic: options.includeMusic !== false,
                            fetch: ctx.fetch,
                            onProgress,
                        })
                        // Record BEE2's packages even if hooking fails
                        await saveConfig(ctx.paths, config)
                        log.info(
                            `Installed ${config.bee2.basePackages.length} of BEE2's packages (BEE2-items ${config.bee2.itemsTag})`,
                        )
                        report({ step: "hook" })
                        report.flush()
                        let hook
                        try {
                            hook = await hookBee2(ctx.paths, ctx.bee2, config)
                        } catch (err) {
                            throw new AppError(
                                `BEE2's packages were installed, but BEE2 couldn't be hooked: ${err.message}`,
                                { code: "hook_failed", bee2: setupSummary(config) },
                            )
                        }
                        await saveConfig(ctx.paths, config)
                        logHook(hook, "BEE2 was already hooked")
                        return {
                            bee2: setupSummary(config),
                            hookChanged: hook.changed,
                            closedBee2: hook.closedBee2,
                        }
                    }),
                )
            } finally {
                report.flush()
                settingUp = false
            }
        },

        "bee2:hook": () =>
            shared.lock(() =>
                step("Hooking BEE2", async () => {
                    const config = await loadConfig(ctx.paths)
                    const result = await hookBee2(ctx.paths, ctx.bee2, config)
                    await saveConfig(ctx.paths, config)
                    logHook(result, "It was already hooked")
                    return {
                        changed: result.changed,
                        closedBee2: result.closedBee2,
                        needsSetup: !config.bee2?.basePackages?.length,
                    }
                }),
            ),

        "bee2:unhook": () =>
            shared.lock(() =>
                step("Unhooking BEE2", async () => {
                    const config = await loadConfig(ctx.paths)
                    const result = await unhookBee2(ctx.paths, ctx.bee2, config)
                    await saveConfig(ctx.paths, config)
                    logHook(result, "It wasn't hooked")
                    return {
                        changed: result.changed,
                        closedBee2: result.closedBee2,
                        restored: result.restored ?? null,
                    }
                }),
            ),
    }
}

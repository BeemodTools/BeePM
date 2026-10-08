import {
    bee2Info,
    findBee2Program,
    isBee2Running,
    loadConfig,
    saveConfig,
    setBee2Folder,
} from "@beepm/core/client"
import path from "node:path"
import { CliError, getContext, leaveHookIfNeeded } from "../context.js"
import { color, info, ok, warn } from "../output.js"

export function register(program) {
    program
        .command("bee2 [folder]")
        .description("Show where BEE2 is, or tell BeePM (the folder BEE2.exe is in)")
        .action(async (folder) => {
            const ctx = await getContext()
            if (folder) {
                const { dir, version, moved } = await setBee2Folder(ctx, folder)
                ok(`BEE2: ${dir}${version ? ` (${version})` : ""}`)
                if (moved) info(`Moved ${moved} of BeePM's packages from the BEE2 before.`)
                info(color.dim(`Packages go in ${ctx.paths.packages}`))
                if (!version) info(color.dim("Open BEE2 once so BeePM can tell its version."))
                await leaveHookIfNeeded(ctx)
                return
            }
            const bee2 = await bee2Info(ctx)
            if (!bee2.dir) {
                const running = (await isBee2Running()) ? await findBee2Program() : null
                info("BeePM doesn't know where BEE2 is yet.")
                info(
                    running
                        ? `BEE2 is running from there: ${color.cyan(`beepm bee2 "${path.dirname(running)}"`)}`
                        : `Tell it: ${color.cyan("beepm bee2 <the folder BEE2.exe is in>")}`,
                )
                return
            }
            info(`Folder:    ${bee2.dir}`)
            if (!bee2.found) warn("BEE2 isn't in that folder anymore.")
            info(`Version:   ${bee2.version ?? color.yellow("unknown (open BEE2 once)")}`)
            info(`Packages:  ${ctx.paths.packages}`)
        })

    program
        .command("status")
        .description("Show BeePM's setup: BEE2, registry and login")
        .action(async () => {
            const ctx = await getContext()
            const bee2 = await bee2Info(ctx)
            info(`Registry:  ${ctx.registry}`)
            info(
                `Login:     ${ctx.login?.user ? `@${ctx.login.user.handle}` : ctx.login ? "token from BEEPM_TOKEN" : "not logged in"}`,
            )
            info(
                `BEE2:      ${bee2.dir ? `${bee2.dir} (${bee2.version ?? "version unknown: open BEE2 once"})` : color.yellow("not chosen yet (beepm bee2 <folder>)")}`,
            )
            if (bee2.dir) info(`Packages:  ${ctx.paths.packages}`)
        })

    program
        .command("registry [url]")
        .description('Show or change which registry BeePM uses ("default" to reset)')
        .action(async (url) => {
            const ctx = await getContext()
            if (!url) return info(ctx.registry)
            const config = await loadConfig(ctx.paths)
            if (url === "default") delete config.registry
            else {
                if (!/^https?:\/\//.test(url))
                    throw new CliError("The registry must be an http(s) URL.")
                config.registry = url.replace(/\/+$/, "")
            }
            await saveConfig(ctx.paths, config)
            ok(`Registry: ${config.registry ?? "default"}`)
        })
}

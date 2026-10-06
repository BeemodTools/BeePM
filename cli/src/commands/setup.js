import {
    bee2Status,
    hookBee2,
    installBasePackages,
    listBee2Releases,
    loadConfig,
    saveConfig,
    unhookBee2,
} from "@beepm/core/client"
import { CliError, getContext } from "../context.js"
import { ask, color, formatDate, info, ok, progress, table, warn } from "../output.js"

export function register(program) {
    program
        .command("setup")
        .alias("init")
        .description("Download BEE2's own packages for your BEE2 version and hook BEE2 to BeePM")
        .option("--version <version>", "BEE2 version, e.g. 2.4.46.1 (default: ask, or the newest)")
        .option("--list", "list BEE2 versions and exit")
        .option("--no-music", "skip BEE2's music packages")
        .action(async (options) => {
            const ctx = await getContext()
            const releases = await listBee2Releases({ fetch: ctx.fetch })
            if (options.list) {
                return table(
                    releases.map((r) => [r.version, r.name, formatDate(r.publishedAt)]),
                    ["VERSION", "NAME", "RELEASED"],
                )
            }

            const config = await loadConfig(ctx.paths)
            let version = options.version?.replace(/^v/i, "")
            if (!version) {
                info(
                    `Newest BEE2 versions: ${releases
                        .slice(0, 5)
                        .map((r) => r.version)
                        .join(", ")}`,
                )
                version = (
                    await ask(
                        "Which BEE2 version do you use?",
                        config.bee2?.version || releases[0]?.version,
                    )
                ).replace(/^v/i, "")
            }
            const release = releases.find((r) => r.version === version)
            if (!release) warn(`${version} isn't in the list of BEE2 releases; trying anyway.`)

            info(`Getting BEE2's own packages for ${version} (this can take a few minutes)...`)
            let bar = null
            let asset = null
            await installBasePackages(ctx.paths, config, {
                version,
                name: release?.name ?? null,
                includeMusic: options.music,
                fetch: ctx.fetch,
                onProgress: (p) => {
                    if (p.asset !== asset || p.step === "extract") {
                        if (p.asset !== asset) {
                            bar?.done()
                            asset = p.asset
                            bar = progress(`Downloading ${p.asset}`)
                        }
                    }
                    if (p.step === "download") bar.update(p.received, p.total)
                },
            })
            bar?.done()
            ok(
                `Installed ${config.bee2.basePackages.length} BEE2 packages (${config.bee2.itemsTag})`,
            )

            const hook = await hookBee2(ctx.paths, ctx.bee2, config)
            await saveConfig(ctx.paths, config)
            ok(
                hook.changed
                    ? "BEE2 now loads packages from BeePM. Close BEE2 before running this, or it may undo the change."
                    : "BEE2 was already hooked to BeePM.",
            )
            info(color.dim(`Packages folder: ${ctx.paths.packages}`))
        })

    program
        .command("hook")
        .description("Point BEE2 at BeePM's packages folder")
        .action(async () => {
            const ctx = await getContext()
            const config = await loadConfig(ctx.paths)
            const result = await hookBee2(ctx.paths, ctx.bee2, config)
            await saveConfig(ctx.paths, config)
            if (!config.bee2?.basePackages?.length) {
                warn(
                    `BEE2's own packages aren't in BeePM's folder yet. Run ${color.cyan("beepm setup")}.`,
                )
            }
            ok(
                result.changed
                    ? "Hooked BEE2 to BeePM. (Close BEE2 first, or it may undo this when it exits.)"
                    : "BEE2 is already hooked to BeePM.",
            )
        })

    program
        .command("unhook")
        .description("Point BEE2 back at the packages folder it used before")
        .action(async () => {
            const ctx = await getContext()
            const config = await loadConfig(ctx.paths)
            const result = await unhookBee2(ctx.paths, ctx.bee2, config)
            await saveConfig(ctx.paths, config)
            if (!result.changed) return info("BEE2 isn't hooked to BeePM.")
            ok(
                result.restored
                    ? `BEE2 uses ${result.restored} again.`
                    : "BEE2 uses its default packages folder again.",
            )
        })

    program
        .command("status")
        .description("Show BeePM's setup: BEE2 version, hook, registry and login")
        .action(async () => {
            const ctx = await getContext()
            const config = await loadConfig(ctx.paths)
            const status = await bee2Status(ctx.paths, ctx.bee2)
            info(`Registry:  ${ctx.registry}`)
            info(
                `Login:     ${ctx.login?.user ? `@${ctx.login.user.handle}` : ctx.login ? "token from BEEPM_TOKEN" : "not logged in"}`,
            )
            info(
                `BEE2:      ${config.bee2?.version ?? color.yellow("unknown (run beepm setup)")}${config.bee2?.itemsTag ? ` with BEE2-items ${config.bee2.itemsTag}` : ""}`,
            )
            info(
                `Hooked:    ${status.hooked ? color.green("yes") : status.configFound ? color.yellow(`no (BEE2 uses ${status.packageDir ?? "its default folder"})`) : color.yellow("BEE2's settings weren't found")}`,
            )
            info(`Packages:  ${ctx.paths.packages}`)
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

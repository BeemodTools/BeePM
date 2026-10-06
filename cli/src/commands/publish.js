import { stat, writeFile } from "node:fs/promises"
import path from "node:path"
import {
    formatName,
    MANIFEST_FILE,
    PackError,
    parseSpec,
    PUBLISH_RULES,
    putFileInZip,
} from "@beepm/core"
import {
    checkWithRegistry,
    loadConfig,
    preparePublish,
    publishPrepared,
    RegistryError,
    suggestManifest,
} from "@beepm/core/client"
import { CliError, getContext, requireLogin } from "../context.js"
import { color, confirm, formatBytes, info, ok, progress, warn } from "../output.js"

/** "@scope/name@1.2.0" -> { name, version } (the version is required). */
function nameAndVersion(spec) {
    const parsed = parseSpec(spec)
    if (!parsed.scope || !parsed.range) {
        throw new CliError(`Write it as @scope/name@version, e.g. @areng14/arengitems@1.0.0`)
    }
    return { name: formatName(parsed.scope, parsed.name), version: parsed.range }
}

/** Shows the publishing rules and asks to agree, unless --yes already did. */
async function agreeToRules(options) {
    if (options.yes) return
    info(PUBLISH_RULES.intro)
    for (const item of PUBLISH_RULES.items) info(`  - ${item}`)
    if (!(await confirm("Do you agree?"))) {
        throw new CliError("Not published. Publishing needs you to agree to the rules (or --yes).")
    }
}

function fullName(spec) {
    const parsed = parseSpec(spec)
    if (!parsed.scope) throw new CliError("Use the full @scope/name.")
    return { name: formatName(parsed.scope, parsed.name), version: parsed.range }
}

export function register(program) {
    program
        .command("publish [path]")
        .description(
            "Publish a .bee_pack file or package folder (or a GitHub release with --github)",
        )
        .option("--dry-run", "check the package without publishing it")
        .option("--github <owner/repo[@tag]>", "publish the .bee_pack attached to a GitHub release")
        .option("--asset <file>", "which .bee_pack to use if the release has several")
        .option("--watch", "with --github: publish the repo's new releases automatically too")
        .option("-y, --yes", "agree to the publishing rules without asking (e.g. in CI)")
        .action(async (input = ".", options) => {
            const ctx = await getContext()

            if (options.github) {
                requireLogin(ctx)
                const match = /^([^/\s]+)\/([^@\s]+)(?:@(.+))?$/.exec(options.github)
                if (!match) throw new CliError("Use --github owner/repo or owner/repo@tag")
                await agreeToRules(options)
                info(`Publishing from GitHub release ${options.github}...`)
                const result = await ctx.api.importGithub({
                    owner: match[1],
                    repo: match[2],
                    tag: match[3],
                    asset: options.asset,
                    watch: options.watch ? true : undefined,
                })
                if (result.strippedFiles?.length) {
                    warn(
                        `Left out ${result.strippedFiles.length} file(s) of types packages can't include.`,
                    )
                }
                ok(`Published ${color.bold(`${result.name}@${result.version}`)}`)
                if (result.watching) info("Its new releases will be published automatically.")
                return
            }

            const handle = ctx.login?.user?.handle ?? null
            let prepared
            try {
                prepared = await preparePublish(path.resolve(input), { handle })
            } catch (err) {
                if (err instanceof PackError) throw new CliError(err.message)
                if (err.code === "ENOENT") throw new CliError(`${input} doesn't exist.`)
                throw err
            }

            try {
                const m = prepared.manifest
                info(
                    `${color.bold(m.fullName ?? `${m.name} (under your handle)`)}@${m.version}  ${color.dim(`BEE2 ID ${prepared.beeId}, ${formatBytes(prepared.size)}`)}`,
                )
                if (m.compatibleWith) info(`  BEE2 ${m.compatibleWith}`)
                const deps = Object.entries(m.dependencies)
                if (deps.length)
                    info(
                        `  Needs ${deps.map(([n, r]) => (r === "*" ? n : `${n}@${r}`)).join(", ")}`,
                    )
                if (prepared.skipped.length) {
                    warn(
                        `Left out of the zip: ${prepared.skipped.slice(0, 8).join(", ")}${prepared.skipped.length > 8 ? ", ..." : ""}`,
                    )
                }
                if (prepared.stripped.length) {
                    warn(
                        `Removed ${prepared.stripped.length} file(s) of types packages can't include: ${prepared.stripped.slice(0, 8).join(", ")}${prepared.stripped.length > 8 ? ", ..." : ""}`,
                    )
                }
                // The registry's rules too (owner, version, BEE2 ID...), before uploading anything
                if (ctx.login) {
                    try {
                        await checkWithRegistry(ctx.api, prepared)
                    } catch (err) {
                        const unchecked =
                            err instanceof RegistryError &&
                            (!err.status || err.status === 404 || err.status >= 500)
                        if (!unchecked) throw err
                        warn(`The registry couldn't check it yet: ${err.message}`)
                    }
                }
                if (options.dryRun)
                    return ok("The package passed every check. (Dry run: nothing was published.)")

                requireLogin(ctx)
                await agreeToRules(options)
                const bar = progress("Uploading")
                const result = await publishPrepared(ctx.api, prepared, {
                    onProgress: (sent, total) => bar.update(sent, total),
                })
                bar.done()
                ok(
                    `Published ${color.bold(`${result.name}@${result.version}`)}${result.created ? " (new package)" : ""}`,
                )
                info(`Install it with: ${color.cyan(`beepm install ${result.name}`)}`)
            } finally {
                await prepared.cleanup()
            }
        })

    program
        .command("new [path]")
        .alias("generate")
        .description("Create bee-package.json for a package folder or .bee_pack, from its info.txt")
        .option("-f, --force", "replace an existing bee-package.json")
        .option("-y, --yes", "accept the suggestions without asking")
        .action(async (input = ".", options) => {
            const ctx = await getContext()
            const target = path.resolve(input)
            const stats = await stat(target).catch(() => null)
            if (!stats) throw new CliError(`${target} doesn't exist.`)
            const isPack = stats.isFile()
            const where = isPack ? path.basename(target) : path.join(target, MANIFEST_FILE)

            const config = await loadConfig(ctx.paths)
            const { manifest, existing } = await suggestManifest(
                { api: ctx.api, basePackages: config.bee2?.basePackages },
                target,
                { handle: ctx.login?.user?.handle ?? null, bee2Version: config.bee2?.version },
            )
            if (existing && !options.force) {
                throw new CliError(
                    `${where} already has a bee-package.json (use --force to replace it).`,
                )
            }
            const text = JSON.stringify(manifest, null, 4) + "\n"
            info(text)
            const question = isPack ? `Add this to ${where}?` : `Write this to ${where}?`
            if (!options.yes && !(await confirm(question, true))) throw new CliError("Cancelled.")
            if (isPack) await putFileInZip(target, MANIFEST_FILE, text)
            else await writeFile(path.join(target, MANIFEST_FILE), text)
            ok(
                `${isPack ? "Added bee-package.json to" : "Wrote"} ${where}. Edit it if needed, then run beepm publish`,
            )
        })

    program
        .command("yank <package@version>")
        .description("Hide a version from installs (it still installs when pinned exactly)")
        .option("--reason <text>", "why, shown to users")
        .option("--undo", "unyank")
        .action(async (spec, options) => {
            const ctx = await getContext()
            requireLogin(ctx)
            const { name, version } = nameAndVersion(spec)
            if (options.undo) await ctx.api.unyank(name, version)
            else await ctx.api.yank(name, version, options.reason)
            ok(`${options.undo ? "Unyanked" : "Yanked"} ${name}@${version}`)
        })

    program
        .command("deprecate <package[@version]> [message]")
        .description("Mark a package or version as deprecated (shown when installing)")
        .option("--undo", "remove the deprecation")
        .action(async (spec, message, options) => {
            const ctx = await getContext()
            requireLogin(ctx)
            const { name, version } = fullName(spec)
            if (!options.undo && !message)
                throw new CliError('Add a message, e.g. "Use @me/new-thing instead".')
            await ctx.api.deprecate(name, {
                message: options.undo ? null : message,
                version: version ?? undefined,
            })
            ok(
                `${options.undo ? "Undeprecated" : "Deprecated"} ${version ? `${name}@${version}` : name}`,
            )
        })

    program
        .command("unpublish <package@version>")
        .description("Delete a version published in the last 72 hours (its number can't be reused)")
        .option("-y, --yes", "don't ask for confirmation")
        .action(async (spec, options) => {
            const ctx = await getContext()
            requireLogin(ctx)
            const { name, version } = nameAndVersion(spec)
            if (!options.yes && !(await confirm(`Permanently delete ${name}@${version}?`)))
                throw new CliError("Cancelled.")
            await ctx.api.unpublish(name, version)
            ok(`Unpublished ${name}@${version}`)
        })

    const owner = program.command("owner").description("Manage who can publish a package")
    owner.command("list <package>").action(async (spec) => {
        const ctx = await getContext()
        const { owners } = await ctx.api.owners(fullName(spec).name)
        for (const o of owners) info(`@${o}`)
    })
    owner.command("add <package> <handle>").action(async (spec, handle) => {
        const ctx = await getContext()
        requireLogin(ctx)
        const { owners } = await ctx.api.addOwner(fullName(spec).name, handle)
        ok(`Owners: ${owners.map((o) => `@${o}`).join(", ")}`)
    })
    owner
        .command("remove <package> <handle>")
        .alias("rm")
        .action(async (spec, handle) => {
            const ctx = await getContext()
            requireLogin(ctx)
            const { owners } = await ctx.api.removeOwner(fullName(spec).name, handle)
            ok(`Owners: ${owners.map((o) => `@${o}`).join(", ")}`)
        })
}

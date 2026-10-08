import { readFile } from "node:fs/promises"
import {
    applyPlan,
    bee2Info,
    InstallError,
    loadConfig,
    loadInstalled,
    outdated,
    planInstall,
    resolveSpec,
    uninstall,
} from "@beepm/core/client"
import { isCompatible } from "@beepm/core/compat"
import { adoptOldInstalls, CliError, getContext } from "../context.js"
import {
    color,
    confirm,
    formatBytes,
    formatDate,
    info,
    ok,
    progress,
    table,
    warn,
} from "../output.js"

/** Reads a requirements file: one package per line, # comments. */
async function readRequirements(file) {
    const text = await readFile(file, "utf8").catch(() => {
        throw new CliError(`Couldn't read ${file}.`)
    })
    return text
        .split(/\r?\n/)
        .map((line) => line.replace(/#.*/, "").trim())
        .filter(Boolean)
}

function describeStep(step) {
    const change = step.from ? `${step.from} → ${step.to}` : step.to
    return `${color.bold(step.name)} ${change}${step.explicit ? "" : color.dim(" (dependency)")} ${color.dim(formatBytes(step.size))}`
}

async function runPlan(ctx, plan, { yes = false } = {}) {
    for (const w of plan.warnings) warn(w)
    if (!plan.steps.length && !plan.markExplicit?.length) {
        info("Nothing to do.")
        return
    }
    if (plan.steps.length) {
        info(`${plan.steps.length} package(s) to install:`)
        for (const step of plan.steps) info(`  ${describeStep(step)}`)
        const downgrades = plan.steps.filter((s) => s.change === "downgrade")
        if (
            downgrades.length &&
            !yes &&
            !(await confirm("Some packages will be downgraded. Continue?"))
        ) {
            throw new CliError("Cancelled.")
        }
    }
    let bar = null
    let current = -1
    const result = await applyPlan(ctx, plan, {
        onProgress: ({ index, count, name, received, total }) => {
            if (index !== current) {
                bar?.done()
                current = index
                bar = progress(`[${index + 1}/${count}] ${name}`)
            }
            bar.update(received, total)
        },
    })
    bar?.done()
    for (const step of result.installed) ok(`Installed ${step.name}@${step.to}`)
    for (const name of result.removed) info(color.dim(`Removed ${name} (no longer needed)`))
    for (const { name, files } of result.replaced) {
        info(color.dim(`Moved your own copy of ${name} (${files.join(", ")}) to BeePM's backups`))
    }
    info(color.dim("Restart BEE2 (or reload packages) to see the changes."))
}

export function register(program) {
    program
        .command("search [query]")
        .description("Search the registry")
        .action(async (query = "") => {
            const ctx = await getContext()
            const { total, packages } = await ctx.api.search(query, { limit: 100 })
            if (!packages.length)
                return info(query ? `No packages match "${query}".` : "The registry is empty.")
            table(
                packages.map((p) => [p.name, p.latest ?? "-", p.displayName ?? "", p.downloads]),
                ["NAME", "LATEST", "TITLE", "DOWNLOADS"],
            )
            if (total > packages.length)
                info(color.dim(`...and ${total - packages.length} more. Narrow the search.`))
        })

    program
        .command("info <package>")
        .description("Show a package's details and versions")
        .action(async (spec) => {
            const ctx = await getContext()
            const { name } = await resolveSpec(ctx.api, spec)
            const doc = await ctx.api.packument(name)
            const bee2Version = (await loadConfig(ctx.paths)).bee2?.version
            info(`${color.bold(doc.name)}${doc.displayName ? ` — ${doc.displayName}` : ""}`)
            if (doc.description) info(doc.description)
            if (doc.deprecated) info(color.yellow(`Deprecated: ${doc.deprecated}`))
            info(
                `BEE2 ID: ${doc.beeId}   Owners: ${doc.owners.map((o) => `@${o}`).join(", ")}   Downloads: ${doc.downloads}`,
            )
            info("")
            const rows = Object.values(doc.versions)
                .reverse()
                .map((v) => [
                    v.version + (v.version === doc.latest ? color.green(" latest") : ""),
                    formatDate(v.publishedAt),
                    v.compatibleWith ?? "any",
                    bee2Version && !isCompatible(v.compatibleWith, bee2Version)
                        ? color.yellow("not for your BEE2")
                        : "",
                    v.yanked
                        ? color.red(`yanked${v.yankReason ? `: ${v.yankReason}` : ""}`)
                        : v.deprecated
                          ? color.yellow("deprecated")
                          : "",
                    Object.keys(v.dependencies).join(", "),
                ])
            table(rows, ["VERSION", "PUBLISHED", "BEE2", "", "", "DEPENDENCIES"])
        })

    program
        .command("install [packages...]")
        .alias("i")
        .alias("add")
        .description("Install packages (e.g. @areng14/arengitems, arengitems@^1.0.0)")
        .option("-r, --requirements <file>", "install the packages listed in a file")
        .option("-f, --force", "reinstall even if already installed")
        .option("-y, --yes", "don't ask before downgrading")
        .action(async (specs = [], options) => {
            const ctx = await getContext()
            await adoptOldInstalls(ctx)
            const all = [
                ...specs,
                ...(options.requirements ? await readRequirements(options.requirements) : []),
            ]
            if (!all.length)
                throw new CliError(
                    "Say which packages to install, e.g. beepm install @areng14/arengitems",
                )
            const bee2 = await bee2Info(ctx) // reads BEE2's version from its log again
            if (bee2.dir && !bee2.version) {
                warn(
                    "BeePM doesn't know your BEE2 version yet (open BEE2 once), so compatibility isn't checked.",
                )
            }
            await runPlan(ctx, await planInstall(ctx, all, { force: options.force }), options)
        })

    program
        .command("uninstall <packages...>")
        .alias("remove")
        .alias("rm")
        .description("Uninstall packages (and dependencies nothing else needs)")
        .option("-f, --force", "uninstall even if other packages need it")
        .action(async (specs, options) => {
            const ctx = await getContext()
            await adoptOldInstalls(ctx)
            const { removed } = await uninstall(ctx, specs, options)
            for (const name of removed) ok(`Uninstalled ${name}`)
        })

    program
        .command("update [packages...]")
        .alias("upgrade")
        .description("Update installed packages (all of them if none are named)")
        .option("-y, --yes", "don't ask before downgrading")
        .action(async (specs = [], options) => {
            const ctx = await getContext()
            await adoptOldInstalls(ctx)
            const installed = await loadInstalled(ctx.paths)
            if (!Object.keys(installed.packages).length) return info("No packages are installed.")
            await runPlan(ctx, await planInstall(ctx, specs, { update: true }), options)
        })

    program
        .command("outdated")
        .description("List installed packages that have newer versions")
        .action(async () => {
            const ctx = await getContext()
            await adoptOldInstalls(ctx)
            const rows = await outdated(ctx)
            if (!rows.length) return ok("Everything is up to date.")
            table(
                rows.map((r) => [
                    r.name,
                    r.current,
                    r.wanted ?? "-",
                    r.latest ?? "-",
                    r.removed
                        ? color.red("removed from registry")
                        : r.yanked
                          ? color.red("yanked")
                          : r.deprecated
                            ? color.yellow("deprecated")
                            : "",
                ]),
                ["NAME", "INSTALLED", "WANTED", "LATEST", ""],
            )
            info(color.dim("Run beepm update to install the WANTED versions."))
        })

    program
        .command("list")
        .alias("ls")
        .description("List installed packages")
        .action(async () => {
            const ctx = await getContext()
            await adoptOldInstalls(ctx)
            const installed = await loadInstalled(ctx.paths)
            const entries = Object.entries(installed.packages)
            if (!entries.length)
                return info("No packages are installed. Find some with beepm search.")
            table(
                entries
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([name, e]) => [
                        name,
                        e.version,
                        e.explicit ? "" : color.dim("dependency"),
                        formatDate(e.installedAt),
                    ]),
                ["NAME", "VERSION", "", "INSTALLED"],
            )
        })
}

export { InstallError }

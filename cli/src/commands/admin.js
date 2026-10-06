import { formatName, parseSpec } from "@beepm/core"
import { CliError, getContext, requireLogin } from "../context.js"
import { color, confirm, formatDate, info, ok, table, warn } from "../output.js"

function packageName(spec) {
    const parsed = parseSpec(spec)
    if (!parsed.scope) throw new CliError("Use the full @scope/name.")
    return formatName(parsed.scope, parsed.name)
}

export function register(program) {
    const admin = program.command("admin").description("Registry moderation (admins only)")

    admin
        .command("remove <package>")
        .description("Hide a package from the registry (files are kept; see restore)")
        .option("--reason <text>")
        .action(async (spec, options) => {
            const ctx = await getContext()
            requireLogin(ctx)
            const name = packageName(spec)
            if (!(await confirm(`Remove ${name} from the registry?`)))
                throw new CliError("Cancelled.")
            await ctx.api.admin.removePackage(name, options.reason)
            ok(`Removed ${name}`)
        })

    admin.command("restore <package>").action(async (spec) => {
        const ctx = await getContext()
        requireLogin(ctx)
        await ctx.api.admin.restorePackage(packageName(spec))
        ok(`Restored ${packageName(spec)}`)
    })

    admin
        .command("ban <handle>")
        .option("--reason <text>")
        .action(async (handle, options) => {
            const ctx = await getContext()
            requireLogin(ctx)
            await ctx.api.admin.updateUser(handle, { banned: true, banReason: options.reason })
            ok(`Banned @${handle.replace(/^@/, "")} and revoked their tokens`)
        })

    admin.command("unban <handle>").action(async (handle) => {
        const ctx = await getContext()
        requireLogin(ctx)
        await ctx.api.admin.updateUser(handle, { banned: false })
        ok(`Unbanned @${handle.replace(/^@/, "")}`)
    })

    admin
        .command("role <handle> <role>")
        .description('Set a user\'s role: "admin" or "user"')
        .action(async (handle, role) => {
            const ctx = await getContext()
            requireLogin(ctx)
            await ctx.api.admin.updateUser(handle, { role })
            ok(`@${handle.replace(/^@/, "")} is now ${role}`)
        })

    admin
        .command("rename <handle> <newHandle>")
        .description("Change a user's handle (their packages move to the new scope)")
        .action(async (handle, newHandle) => {
            const ctx = await getContext()
            requireLogin(ctx)
            await ctx.api.admin.updateUser(handle, { handle: newHandle })
            ok(`@${handle.replace(/^@/, "")} is now @${newHandle.toLowerCase()}`)
        })

    admin
        .command("audit")
        .option("--limit <n>", "how many entries", "50")
        .action(async (options) => {
            const ctx = await getContext()
            requireLogin(ctx)
            const { entries } = await ctx.api.admin.audit(Number.parseInt(options.limit, 10) || 50)
            table(
                entries.map((e) => [
                    formatDate(e.at),
                    e.actor ? `@${e.actor}` : "-",
                    e.action,
                    e.target ?? "",
                    e.details ? JSON.stringify(e.details).slice(0, 80) : "",
                ]),
                ["DATE", "WHO", "ACTION", "TARGET", "DETAILS"],
            )
        })

    admin
        .command("import-legacy [registryUrl]")
        .description("Copy BeePM 1's packages into this registry (safe to run again)")
        .action(async (registryUrl) => {
            const ctx = await getContext()
            requireLogin(ctx)
            info(
                "Importing BeePM 1's registry. This downloads every package, so it can take a while...",
            )
            const result = await ctx.api.admin.importLegacy(registryUrl)
            for (const line of result.imported) ok(line)
            if (result.skipped.length) info(color.dim(`Already imported: ${result.skipped.length}`))
            for (const problem of result.problems) warn(problem)
            ok(`Imported ${result.versions} version(s) of ${result.packages} package(s)`)
        })
}

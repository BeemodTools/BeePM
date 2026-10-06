import { beginLogin, defaultClientName } from "@beepm/core/client"
import { CliError, getContext, openBrowser, requireLogin } from "../context.js"
import { color, formatDate, info, ok, table, warn } from "../output.js"

async function browserFlow(ctx, { link = false } = {}) {
    const flow = await beginLogin(ctx.api, {
        client: "cli",
        clientName: defaultClientName("cli"),
        link,
    })
    info(
        `Opening your browser to ${link ? "link an account" : "log in"}. If it doesn't open, go to:`,
    )
    info(`  ${color.cyan(flow.url)}`)
    info(`Check that the browser shows this code: ${color.bold(color.green(flow.confirmCode))}`)
    openBrowser(flow.url)
    info(color.dim("Waiting for you to finish in the browser... (Ctrl+C to cancel)"))
    const controller = new AbortController()
    const onInterrupt = () => controller.abort()
    process.once("SIGINT", onInterrupt)
    try {
        return await flow.wait({ signal: controller.signal })
    } finally {
        process.off("SIGINT", onInterrupt)
    }
}

export function register(program) {
    program
        .command("login")
        .description("Log in with Discord or GitHub (in your browser)")
        .action(async () => {
            const ctx = await getContext()
            const result = await browserFlow(ctx)
            await ctx.tokens.save({
                registry: ctx.registry,
                token: result.token,
                user: result.user,
            })
            ok(`Logged in as ${color.bold(`@${result.user.handle}`)}`)
        })

    program
        .command("logout")
        .description("Log out and revoke this computer's token")
        .action(async () => {
            const ctx = await getContext()
            if (ctx.login) {
                await ctx.api
                    .logout()
                    .catch((err) => warn(`The registry didn't confirm the logout: ${err.message}`))
            }
            await ctx.tokens.clear()
            ok("Logged out")
        })

    program
        .command("whoami")
        .description("Show who you're logged in as")
        .action(async () => {
            const ctx = await getContext()
            requireLogin(ctx)
            const me = await ctx.api.me()
            info(
                `${color.bold(`@${me.user.handle}`)}${me.user.role === "admin" ? color.magenta(" (admin)") : ""}`,
            )
            for (const identity of me.identities)
                info(`  ${identity.provider}: ${identity.username}`)
            if (!me.canPublish) warn(me.publishBlockedReason)
        })

    program
        .command("link")
        .description("Link another Discord or GitHub account to your BeePM account")
        .action(async () => {
            const ctx = await getContext()
            requireLogin(ctx)
            const result = await browserFlow(ctx, { link: true })
            ok(`Linked ${result.identity.provider} account ${color.bold(result.identity.username)}`)
        })

    program
        .command("unlink <provider>")
        .description("Unlink a Discord or GitHub account (you must keep at least one)")
        .action(async (provider) => {
            const ctx = await getContext()
            requireLogin(ctx)
            const { identities } = await ctx.api.unlink(provider.toLowerCase())
            ok(
                `Unlinked ${provider}. Still linked: ${identities.map((i) => i.provider).join(", ")}`,
            )
        })

    const token = program
        .command("token")
        .description("Manage API tokens (e.g. for publishing from CI)")
    token
        .command("list")
        .description("List your tokens")
        .action(async () => {
            const ctx = await getContext()
            requireLogin(ctx)
            const { tokens } = await ctx.api.tokens()
            table(
                tokens.map((t) => [
                    t.id,
                    t.name + (t.current ? color.green(" (this computer)") : ""),
                    t.kind,
                    formatDate(t.createdAt),
                    formatDate(t.lastUsedAt),
                    formatDate(t.expiresAt),
                ]),
                ["ID", "NAME", "KIND", "CREATED", "LAST USED", "EXPIRES"],
            )
        })
    token
        .command("create <name>")
        .description("Create a publish token (shown once)")
        .option("--days <days>", "days until it expires (1-365)", "90")
        .action(async (name, options) => {
            const ctx = await getContext()
            requireLogin(ctx)
            const days = Number.parseInt(options.days, 10)
            if (!Number.isInteger(days)) throw new CliError("--days must be a number.")
            const created = await ctx.api.createToken({ name, days })
            ok(
                `Created token "${name}" (expires ${formatDate(created.expiresAt)}). Copy it now, it won't be shown again:`,
            )
            info(created.token)
            info(color.dim("Use it with BEEPM_TOKEN=<token> beepm publish"))
        })
    token
        .command("revoke <id>")
        .description("Revoke a token")
        .action(async (id) => {
            const ctx = await getContext()
            requireLogin(ctx)
            await ctx.api.revokeToken(id)
            ok(`Revoked token ${id}`)
        })
}

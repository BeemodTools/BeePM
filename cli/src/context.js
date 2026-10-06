import { spawn } from "node:child_process"
import { access } from "node:fs/promises"
import { adoptLegacyInstalls, createClientContext, createFileTokenStore } from "@beepm/core/client"
import { color, info, warn } from "./output.js"

/** Thrown for problems the user should just read (no stack trace). */
export class CliError extends Error {}

/**
 * The client context plus the saved CLI login (credentials.json). A login saved for
 * a different registry is ignored.
 */
export async function getContext() {
    const ctx = await createClientContext({ userAgent: "beepm-cli" })
    ctx.tokens = createFileTokenStore(ctx.paths.credentials)
    const saved = await ctx.tokens.load()
    if (process.env.BEEPM_TOKEN) {
        // CI: a publish token from the environment
        ctx.api.setToken(process.env.BEEPM_TOKEN.trim())
        ctx.login = { registry: ctx.registry, token: process.env.BEEPM_TOKEN.trim(), user: null }
    } else if (saved?.token && saved.registry === ctx.registry) {
        ctx.api.setToken(saved.token)
        ctx.login = saved
    }
    return ctx
}

export function requireLogin(ctx) {
    if (!ctx.login)
        throw new CliError(`You're not logged in. Run ${color.cyan("beepm login")} first.`)
    return ctx.login
}

/** Takes over installs from earlier BeePM versions the first time a package command runs. */
export async function adoptOldInstalls(ctx) {
    const exists = await access(ctx.paths.legacyInstalled).then(
        () => true,
        () => false,
    )
    if (!exists) return
    try {
        const { adopted, unknown } = await adoptLegacyInstalls(ctx)
        if (adopted.length)
            info(
                `Took over ${adopted.length} package(s) installed by an earlier BeePM version: ${adopted.join(", ")}`,
            )
        if (unknown.length)
            warn(
                `These packages from an earlier BeePM version aren't in the registry and were left alone: ${unknown.join(", ")}`,
            )
    } catch (err) {
        warn(`Couldn't take over packages installed by an earlier BeePM version yet: ${err.message}`)
    }
}

/** Opens a URL in the default browser without going through a shell. */
export function openBrowser(url) {
    if (process.env.BEEPM_NO_BROWSER) return
    const [command, args] =
        process.platform === "win32"
            ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
            : process.platform === "darwin"
              ? ["open", [url]]
              : ["xdg-open", [url]]
    try {
        const child = spawn(command, args, { stdio: "ignore", detached: true })
        child.on("error", () => {})
        child.unref()
    } catch {
        // The URL is printed too, so the user can open it by hand
    }
}

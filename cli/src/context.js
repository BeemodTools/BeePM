import { spawn } from "node:child_process"
import { access } from "node:fs/promises"
import {
    adoptLegacyInstalls,
    createClientContext,
    createFileTokenStore,
    findBee2Program,
    hasHook,
    isBee2Running,
    leaveHook,
} from "@beepm/core/client"
import { color, info, ok, warn } from "./output.js"

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
    await leaveHookIfNeeded(ctx)
    return ctx
}

/**
 * Earlier BeePM 1.0 builds pointed BEE2 at a folder of BeePM's own ("hooking"). This puts BEE2
 * back and moves the packages into BEE2's packages folder as soon as it can (see leaveHook).
 */
export async function leaveHookIfNeeded(ctx) {
    if (!(await hasHook(ctx))) return
    const running = await isBee2Running()
    const program = running || !ctx.paths.bee2Dir ? await findBee2Program() : null
    const result = await leaveHook(ctx, { program, running }).catch((err) => {
        warn(`Couldn't move BeePM's packages into BEE2's packages folder yet: ${err.message}`)
        return null
    })
    if (!result) return
    if (result.done) {
        if (result.moved) {
            ok(`BEE2 loads its own packages folder again, and BeePM's packages are in it now.`)
        } else if ("restored" in result) ok("BEE2 loads its own packages folder again.")
    } else if (result.waitingFor === "bee2") {
        warn("BEE2 still loads BeePM's old packages folder. Close BEE2 so BeePM can set it back.")
    } else {
        if ("restored" in result) ok("BEE2 loads its own packages folder again.")
        warn(
            `BeePM now keeps packages in BEE2's own packages folder. Tell it where BEE2 is: ${color.cyan("beepm bee2 <folder>")}`,
        )
    }
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
        warn(
            `Couldn't take over packages installed by an earlier BeePM version yet: ${err.message}`,
        )
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

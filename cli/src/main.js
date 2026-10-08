import { readFileSync } from "node:fs"
import { InstallError, LoginError, RegistryError, Bee2Error } from "@beepm/core/client"
import { ManifestError, PackError } from "@beepm/core"
import { Command, CommanderError } from "commander"
import * as account from "./commands/account.js"
import * as admin from "./commands/admin.js"
import * as packages from "./commands/packages.js"
import * as publish from "./commands/publish.js"
import * as setup from "./commands/setup.js"
import { CliError } from "./context.js"
import { fail } from "./output.js"

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))

export function buildProgram() {
    const program = new Command()
    program
        .name("beepm")
        .description("BeePM: install and publish BEEmod packages")
        .version(version, "-v, --version")
        .showHelpAfterError()
        .configureHelp({ sortSubcommands: false })
    for (const group of [packages, publish, account, setup, admin]) group.register(program)
    return program
}

const EXPECTED = [
    CliError,
    InstallError,
    LoginError,
    RegistryError,
    Bee2Error,
    PackError,
    ManifestError,
]

/** Runs the CLI and returns the exit code. */
export async function run(argv = process.argv) {
    const program = buildProgram()
    program.exitOverride()
    try {
        await program.parseAsync(argv)
        return 0
    } catch (err) {
        if (err instanceof CommanderError) return err.exitCode
        if (EXPECTED.some((type) => err instanceof type)) {
            fail(
                err.code === "bee2_not_set"
                    ? `${err.message} Run: beepm bee2 <the folder BEE2.exe is in>`
                    : err.message,
            )
            if (err instanceof RegistryError && err.details?.problems) {
                for (const problem of err.details.problems) console.error(`  - ${problem}`)
            }
        } else {
            fail(
                process.env.BEEPM_DEBUG
                    ? err.stack
                    : `${err.message} (set BEEPM_DEBUG=1 for details)`,
            )
        }
        return 1
    }
}

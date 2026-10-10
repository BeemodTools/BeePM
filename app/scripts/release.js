/**
 * npm run publish [patch | minor | major | <version>] [--notes "..."] [--dry-run]
 * (from the repo or from app/; npm passes what comes after `--`: npm run publish -- minor)
 *
 * Releases BeePM: the next version (a patch by default) is built from what's committed and
 * published as a GitHub release, which installed BeePMs update from (electron-builder.config.js).
 *   1. Checks: nothing uncommitted, not behind the remote branch, gh logged in, and that
 *      version isn't out yet
 *   2. Raises the version in app/package.json (and package-lock.json)
 *   3. Builds the installer (npm run build, which checks what it packed)
 *   4. Commits "BeePM <version>" and pushes it
 *   5. Makes the GitHub release v<version> at that commit, with the installer, its .blockmap and
 *      latest.yml. Its notes: --notes, else the commits since the last release.
 * If the build fails, the version goes back and nothing is committed or released.
 * --dry-run only checks, and says what it would do.
 */
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import semver from "semver"
import builder from "../electron-builder.config.js"

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const repo = path.dirname(app)
const { owner, repo: repoName } = builder.publish[0]
const github = `${owner}/${repoName}`

const args = process.argv.slice(2)
const dryRun = args.includes("--dry-run")
const notesAt = args.indexOf("--notes")
const notesGiven = notesAt >= 0 ? args[notesAt + 1] : null
// The version: what isn't a --flag or the notes' text
const bump =
    args.find((arg, i) => !arg.startsWith("--") && !(notesAt >= 0 && i === notesAt + 1)) ?? "patch"

class Stop extends Error {}
const stop = (message) => {
    throw new Stop(message)
}

/** Runs a program in the repo: its output, or (show) shown as it runs. */
function run(program, programArgs, { show = false, allowFail = false } = {}) {
    // npm is a .cmd on Windows, which Node won't start without a shell: run its script instead
    const [command, commandArgs] =
        program === "npm" && process.env.npm_execpath
            ? [process.execPath, [process.env.npm_execpath, ...programArgs]]
            : [program, programArgs]
    const result = spawnSync(command, commandArgs, {
        cwd: repo,
        encoding: "utf8",
        stdio: show ? "inherit" : "pipe",
        shell: program === "npm" && !process.env.npm_execpath,
    })
    if (result.error) stop(`${program} couldn't run: ${result.error.message}`)
    if (result.status !== 0 && !allowFail) {
        const said = show ? "" : `\n${(result.stderr || result.stdout || "").trim()}`
        stop(`${program} ${programArgs.join(" ")} failed${said}`)
    }
    return { ok: result.status === 0, out: (result.stdout ?? "").trim() }
}

const version = () => JSON.parse(readFileSync(path.join(app, "package.json"), "utf8")).version

function check(next) {
    if (run("git", ["status", "--porcelain"]).out) {
        stop("Commit or stash your changes first: the release is built from what's committed.")
    }
    run("git", ["fetch", "--tags", "--quiet"])
    const counts = run("git", ["rev-list", "--left-right", "--count", "@{u}...HEAD"], {
        allowFail: true,
    })
    if (!counts.ok) stop("This branch has no branch on GitHub to push to.")
    if (Number(counts.out.split(/\s+/)[0])) {
        stop("The branch on GitHub has commits this one doesn't: pull first.")
    }
    if (!run("gh", ["auth", "status"], { allowFail: true }).ok) {
        stop("Log in to GitHub first: gh auth login")
    }
    if (run("gh", ["release", "view", `v${next}`, "--repo", github], { allowFail: true }).ok) {
        stop(`v${next} is out already: give a higher version (npm run publish -- <version>).`)
    }
    // A tag left from a release that was deleted: the new release would be made at that commit
    if (run("git", ["ls-remote", "--tags", "origin", `refs/tags/v${next}`]).out) {
        stop(
            `The tag v${next} is on GitHub already (from a release that was deleted?). Delete it first (git push --delete origin v${next}), or give a higher version.`,
        )
    }
}

/** --notes, else the commits since the last release. */
function releaseNotes() {
    if (notesGiven) return notesGiven
    const last = run("git", ["describe", "--tags", "--abbrev=0", "--match", "v*"], {
        allowFail: true,
    })
    const range = last.ok ? `${last.out}..HEAD` : "HEAD"
    const commits = run("git", ["log", range, "--no-merges", "--format=- %s"]).out
    return commits
        ? `${last.ok ? `Since ${last.out}:` : "In this version:"}\n\n${commits}`
        : "Fixes and small changes."
}

function main() {
    const current = version()
    const next = semver.valid(bump) ?? semver.inc(current, bump)
    if (!next) stop(`"${bump}" isn't patch, minor, major or a version like 1.2.3.`)
    // The version it's at already, given on purpose: released as it is (if it isn't out)
    const asIs = semver.eq(next, current)
    if (!asIs && !semver.gt(next, current)) stop(`${next} isn't higher than ${current}.`)
    check(next)
    const notes = releaseNotes()
    const files = [`BeePM-Setup-${next}.exe`, `BeePM-Setup-${next}.exe.blockmap`, "latest.yml"].map(
        (file) => path.join(app, "release", file),
    )

    console.log(
        `BeePM ${asIs ? next : `${current} -> ${next}`} (release v${next} on ${github})\n\n${notes}\n`,
    )
    if (dryRun) {
        console.log("Dry run: nothing was changed.")
        return
    }

    const changed = ["app/package.json", "package-lock.json"]
    if (!asIs) run("npm", ["version", next, "-w", "@beepm/app", "--no-git-tag-version"])
    try {
        run("npm", ["run", "build", "-w", "@beepm/app"], { show: true })
        const missing = files.filter((file) => !existsSync(file))
        if (missing.length) stop(`The build didn't make ${missing.map((f) => path.basename(f))}`)
    } catch (err) {
        if (!asIs) run("git", ["checkout", "--", ...changed])
        throw err
    }

    if (!asIs) {
        run("git", ["add", ...changed])
        run("git", ["commit", "-m", `BeePM ${next}`])
    }
    run("git", ["push"], { show: true })
    const commit = run("git", ["rev-parse", "HEAD"]).out
    run(
        "gh",
        [
            "release",
            "create",
            `v${next}`,
            ...files,
            "--repo",
            github,
            "--target",
            commit,
            "--title",
            `BeePM ${next}`,
            "--notes",
            notes,
        ],
        { show: true },
    )
    console.log(`\nBeePM ${next} is out. Installed BeePMs offer it within a few hours.`)
}

try {
    main()
} catch (err) {
    console.error(err instanceof Stop ? `\n${err.message}` : err)
    process.exit(1)
}

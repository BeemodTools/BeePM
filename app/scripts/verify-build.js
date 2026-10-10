/**
 * The last step of `npm run build`: checks the packed app (release/*-unpacked/resources/app.asar)
 * against its sources, file by file. electron-builder notes each file's size before writing it,
 * so a file that changes while it packs (an edit, a formatter) shifts every file after it, and
 * BeePM doesn't start at all. It also checks package.json can be read, the main process's
 * dependencies are packed, and none of the page's (Vite bundles those into dist).
 * A build that fails this has its installer deleted, so it can't be installed by mistake.
 */
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import asar from "@electron/asar"

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const repo = path.dirname(app)
const release = path.join(app, "release")
const pkg = JSON.parse(readFileSync(path.join(app, "package.json"), "utf8"))

/** The packed file's source: the app's own files, @beepm/core from the workspace, or a module. */
function source(file) {
    if (file.startsWith("node_modules/@beepm/core/")) {
        return path.join(repo, "core", file.slice("node_modules/@beepm/core/".length))
    }
    if (file.startsWith("node_modules/")) {
        return [app, repo].map((base) => path.join(base, file)).find((p) => existsSync(p)) ?? null
    }
    return path.join(app, file)
}

function check(archive) {
    const problems = []
    const files = []
    ;(function walk(node, parts) {
        for (const [name, child] of Object.entries(node.files ?? {})) {
            if (child.files) walk(child, [...parts, name])
            else if (!child.unpacked && !child.link) files.push([...parts, name].join("/"))
        }
    })(asar.getRawHeader(archive).header, [])

    const read = (file) => asar.extractFile(archive, path.normalize(file))
    for (const file of files) {
        const packed = read(file)
        // electron-builder rewrites package.json files (it leaves fields out): they only have to
        // be readable
        if (file === "package.json" || file.endsWith("/package.json")) {
            try {
                JSON.parse(packed.toString("utf8"))
            } catch (err) {
                problems.push(`${file} can't be read: ${err.message}`)
            }
            continue
        }
        const from = source(file)
        if (from && existsSync(from) && !packed.equals(readFileSync(from))) {
            problems.push(`${file} isn't the same as ${path.relative(repo, from)}`)
        }
    }

    const packedModules = new Set(
        files
            .map((file) => /^node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(file)?.[1])
            .filter(Boolean),
    )
    for (const name of Object.keys(pkg.dependencies ?? {})) {
        if (!packedModules.has(name)) problems.push(`${name} (a dependency) isn't packed`)
    }
    for (const name of Object.keys(pkg.devDependencies ?? {})) {
        if (packedModules.has(name)) problems.push(`${name} (only for building) is packed`)
    }
    return { files: files.length, problems }
}

const archives = existsSync(release)
    ? readdirSync(release)
          .filter((name) => name.endsWith("-unpacked"))
          .map((name) => path.join(release, name, "resources", "app.asar"))
          .filter((file) => existsSync(file))
    : []
if (!archives.length) {
    console.error("verify-build: no packed app in release/ to check")
    process.exit(1)
}

// The page this build made (vite build runs first): a packed app older than it is from an
// earlier build, which electron-builder couldn't replace
const builtAt = statSync(path.join(app, "dist", "index.html")).mtimeMs

let failed = false
let stale = false
for (const archive of archives) {
    const where = path.relative(app, archive)
    if (statSync(archive).mtimeMs < builtAt) {
        failed = stale = true
        console.error(`verify-build: ${where} is from an earlier build: it wasn't replaced.`)
        continue
    }
    const { files, problems } = check(archive)
    if (!problems.length) {
        console.log(`verify-build: ${where} is fine (${files} files)`)
        continue
    }
    failed = true
    console.error(`verify-build: ${where} is broken:`)
    for (const problem of problems.slice(0, 20)) console.error(`  - ${problem}`)
    if (problems.length > 20) console.error(`  ...and ${problems.length - 20} more`)
}
if (failed) {
    for (const name of readdirSync(release)) {
        if (/\.(exe|blockmap|AppImage|yml)$/i.test(name)) rmSync(path.join(release, name))
    }
    console.error(
        stale
            ? "verify-build: its installer was deleted. Something has the old app.asar open (an editor like VS Code, or a copy of BeePM run from release/): close it, then build again."
            : "verify-build: its installer was deleted. Build again, changing nothing meanwhile.",
    )
    process.exit(1)
}

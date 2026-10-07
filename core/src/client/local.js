import { copyFile, mkdir, readdir, readFile, rm, stat } from "node:fs/promises"
import path from "node:path"
import { readInfoTxt } from "../infotxt.js"
import { formatName, parseName } from "../names.js"
import { hashFile, packFolder, readPack } from "../pack.js"
import { replaceFile } from "./files.js"
import { InstallError } from "./install.js"
import { loadConfig, loadInstalled, saveInstalled } from "./state.js"

/**
 * Local packages: .bee_pack files and package folders from this PC, copied into BeePM's
 * packages folder so BEE2 loads them while it's hooked to BeePM. They aren't in the registry,
 * so they never update, and the registry's packages come first: importing one that's on BeePM
 * installs it from BeePM instead, and installing a package with the same BEE2 ID later replaces
 * the local copy (see applyPlan).
 */

/** The file a local package gets in the packages folder (no "@", unlike registry packages). */
export const localFileName = (beeId) => `${beeId.toLowerCase()}.local.bee_pack`

const isPackFile = (name) => /\.(bee_pack|zip)$/i.test(name)
const exists = (file) =>
    stat(file).then(
        () => true,
        () => false,
    )

/** A .bee_pack/.zip file or a package folder: { path, isFolder, beeId, name } or { path, problem }. */
async function inspect(target, isFolder) {
    try {
        const text = isFolder
            ? await readFile(path.join(target, "info.txt"), "utf8")
            : (await readPack(target)).infoText
        if (text == null) return { path: target, isFolder, problem: "It has no info.txt" }
        const info = readInfoTxt(text)
        return { path: target, isFolder, beeId: info.id, name: info.name }
    } catch (err) {
        const reason = err.problems?.[0] ?? err.message
        return { path: target, isFolder, problem: `It can't be read: ${reason}` }
    }
}

/**
 * The packages in `target`: a .bee_pack/.zip file, a package folder (info.txt at its root), or
 * a folder holding those. Returns [{ path, isFolder, beeId, name } or { path, problem }].
 */
export async function findPackages(target) {
    const info = await stat(target).catch(() => null)
    if (!info) throw new InstallError(`${target} doesn't exist.`)
    if (!info.isDirectory()) {
        if (!isPackFile(target)) throw new InstallError("Choose a .bee_pack or .zip file.")
        return [await inspect(target, false)]
    }
    if (await exists(path.join(target, "info.txt"))) return [await inspect(target, true)]

    const found = []
    const entries = await readdir(target, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
        if (entry.name.startsWith(".")) continue
        const full = path.join(target, entry.name)
        if (entry.isFile() && isPackFile(entry.name)) found.push(await inspect(full, false))
        else if (entry.isDirectory() && (await exists(path.join(full, "info.txt")))) {
            found.push(await inspect(full, true))
        }
    }
    return found
}

/**
 * What importing each found package does, BeePM's packages first:
 *   "beepm"  the registry has a package with its BEE2 ID (`package`): installed from there
 *   "local"  copied in as a local package (`replaces` an older local copy with the same ID)
 *   "skip"   with a `reason`: one of BEE2's own, installed from BeePM already, a second
 *            package with the same BEE2 ID, or it can't be read
 * Returns { items, offline } (offline: the registry couldn't be asked, so nothing is "beepm").
 */
export async function planImport(ctx, found) {
    const { api, paths } = ctx
    const [config, installed] = await Promise.all([loadConfig(paths), loadInstalled(paths)])
    const base = new Set(config.bee2?.basePackages ?? [])
    const fromBeepm = new Map(
        Object.entries(installed.packages).map(([name, entry]) => [entry.beeId, name]),
    )
    const seen = new Set()
    const items = []
    let offline = false
    for (const item of found) {
        const skip = (reason) => items.push({ ...item, action: "skip", reason })
        if (item.problem) {
            skip(item.problem)
            continue
        }
        if (seen.has(item.beeId)) {
            skip("Another package here has the same ID")
            continue
        }
        seen.add(item.beeId)
        if (base.has(item.beeId)) {
            skip("It's one of BEE2's own packages")
            continue
        }
        if (fromBeepm.has(item.beeId)) {
            skip(`${fromBeepm.get(item.beeId)} is installed from BeePM`)
            continue
        }
        let names = []
        if (!offline) {
            try {
                ;({ packages: names } = await api.lookup({ beeId: item.beeId }))
            } catch (err) {
                if (err.status === 0) offline = true
            }
        }
        const parsed = names.length === 1 ? parseName(names[0]) : null
        if (parsed) {
            items.push({ ...item, action: "beepm", package: formatName(parsed.scope, parsed.name) })
        } else {
            items.push({ ...item, action: "local", replaces: Boolean(installed.local[item.beeId]) })
        }
    }
    return { items, offline }
}

/** Copies one package in as a local package (a folder is zipped). Returns its entry. */
export async function importLocal(paths, item) {
    const file = localFileName(item.beeId)
    const destination = path.join(paths.packages, file)
    const temp = path.join(paths.packages, `${file}.${process.pid}.part`)
    await mkdir(paths.packages, { recursive: true })
    try {
        if (item.isFolder) await packFolder(item.path, temp, { allFiles: true })
        else await copyFile(item.path, temp)
        await replaceFile(temp, destination)
    } finally {
        await rm(temp, { force: true })
    }
    const installed = await loadInstalled(paths)
    const entry = {
        name: item.name ?? null,
        file,
        sha256: await hashFile(destination),
        from: item.path,
        importedAt: new Date().toISOString(),
    }
    installed.local[item.beeId] = entry
    await saveInstalled(paths, installed)
    return entry
}

/** Removes a local package. */
export async function removeLocal(paths, beeId) {
    const installed = await loadInstalled(paths)
    const entry = installed.local[beeId]
    if (!entry) throw new InstallError("That local package isn't there anymore.")
    await rm(path.join(paths.packages, entry.file), { force: true })
    delete installed.local[beeId]
    await saveInstalled(paths, installed)
    return entry
}

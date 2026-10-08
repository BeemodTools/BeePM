import path from "node:path"
import { findDuplicates } from "../duplicates.js"
import { formatName, parseName } from "../names.js"
import { freePath, moveFile } from "./files.js"
import { bee2PackagesDir } from "./paths.js"
import { mapLimit, scanPackages } from "./scan.js"
import { loadInstalled, saveInstalled } from "./state.js"

const LOOKUPS_AT_ONCE = 6
const key = (p) => (process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p))
const isInside = (file, folder) => key(file).startsWith(key(folder) + path.sep)

/**
 * The packages in BEE2's packages folder (skipBeepm: not the ones in BeePM's folder there),
 * using the scan cache for files that didn't change. Needs BEE2's folder.
 */
export function scanBee2(paths, { skipBeepm = false } = {}) {
    return scanPackages(bee2PackagesDir(paths.bee2Dir), {
        skip: skipBeepm ? [paths.packages] : [],
        cacheFile: path.join(paths.cache, "packages.json"),
    })
}

/**
 * Looks at BEE2's packages folder (the desktop app does when BEE2 opens):
 *   duplicates  what BEE2 refuses to load together (see duplicates.js). Each copy also has
 *               `file`, where it is in the packages folder, and `managed`: BeePM installed it.
 *   onBeepm     packages the user added themselves that are on BeePM, where BeePM's version
 *               gets updates: [{ id, name, file, package }]. Not the IDs in `keepOwn` (the user
 *               keeps their own copy), and not ones installed from BeePM too (duplicates).
 *   offline     the registry couldn't be asked, so onBeepm is empty
 * Null if BeePM doesn't know where BEE2 is.
 */
export async function checkBee2Packages(ctx, { keepOwn = [] } = {}) {
    const { api, paths } = ctx
    if (!paths.bee2Dir) return null
    const root = bee2PackagesDir(paths.bee2Dir)
    const installed = await loadInstalled(paths)
    const managed = new Set(
        Object.values(installed.packages).map((e) => key(path.join(paths.packages, e.file))),
    )
    const found = (await scanBee2(paths)).map((pkg) => ({
        ...pkg,
        file: path.relative(root, pkg.path),
        managed: managed.has(key(pkg.path)),
    }))
    const duplicates = findDuplicates(found)

    const fromBeepm = new Set(Object.values(installed.packages).map((e) => e.beeId))
    const own = new Map() // BEE2 ID -> the user's newest copy
    for (const pkg of found) {
        if (!pkg.id || isInside(pkg.path, paths.packages) || fromBeepm.has(pkg.id)) continue
        if (keepOwn.includes(pkg.id)) continue
        if (!own.has(pkg.id) || (pkg.modified ?? 0) > (own.get(pkg.id).modified ?? 0)) {
            own.set(pkg.id, pkg)
        }
    }
    let offline = false
    const onBeepm = []
    await mapLimit([...own.values()], LOOKUPS_AT_ONCE, async (pkg) => {
        if (offline) return
        try {
            const { packages } = await api.lookup({ beeId: pkg.id })
            const parsed = packages.length === 1 ? parseName(packages[0]) : null
            if (parsed) {
                onBeepm.push({
                    id: pkg.id,
                    name: pkg.name ?? pkg.id,
                    file: pkg.file,
                    package: formatName(parsed.scope, parsed.name),
                })
            }
        } catch (err) {
            if (err.status === 0) offline = true
        }
    })
    onBeepm.sort((a, b) => a.name.localeCompare(b.name))
    return { duplicates, onBeepm, offline }
}

/**
 * Removes package files from BEE2's packages folder: remove(file) puts each away (e.g. in the
 * Recycle Bin); by default it's moved to BeePM's backups (paths.replaced). Packages BeePM
 * installed are uninstalled with their file. Files outside BEE2's packages folder are left
 * alone. Returns { removed: [file], uninstalled: [package name] }.
 */
export async function removePackageFiles(ctx, files, { remove = null } = {}) {
    const { paths } = ctx
    if (!paths.bee2Dir) return { removed: [], uninstalled: [] }
    const root = bee2PackagesDir(paths.bee2Dir)
    const installed = await loadInstalled(paths)
    const removed = []
    const uninstalled = []
    for (const file of files) {
        if (!isInside(file, root)) continue
        if (remove) await remove(file)
        else await moveFile(file, await freePath(paths.replaced, path.basename(file)))
        removed.push(file)
        const name = Object.entries(installed.packages).find(
            ([, e]) => key(path.join(paths.packages, e.file)) === key(file),
        )?.[0]
        if (name) {
            delete installed.packages[name]
            uninstalled.push(name)
        }
    }
    if (uninstalled.length) await saveInstalled(paths, installed)
    return { removed, uninstalled }
}

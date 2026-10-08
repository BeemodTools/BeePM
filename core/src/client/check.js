import { rm } from "node:fs/promises"
import path from "node:path"
import { findDuplicates } from "../duplicates.js"
import { formatName, parseName } from "../names.js"
import { inspectBee2Zip, repackFolders } from "./bee2zip.js"
import { freePath, moveFile } from "./files.js"
import { bee2PackagesDir } from "./paths.js"
import { mapLimit, readPackageInfo, scanPackages } from "./scan.js"
import { loadInstalled, saveInstalled } from "./state.js"

const LOOKUP_BATCH = 500 // BEE2 IDs per request (the registry takes up to 1000)
const LOOKUPS_AT_ONCE = 6 // one ID per request, from a registry without batches
const key = (p) => (process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p))
const isInside = (file, folder) => key(file).startsWith(key(folder) + path.sep)

/**
 * The packages in BEE2's packages folder (skipBeepm: not the ones in BeePM's folder there),
 * using the scan cache for files that didn't change. deep: every file in the zips is checked
 * (see scanPackages). Needs BEE2's folder.
 */
export function scanBee2(paths, { skipBeepm = false, deep = false } = {}) {
    return scanPackages(bee2PackagesDir(paths.bee2Dir), {
        skip: skipBeepm ? [paths.packages] : [],
        cacheFile: path.join(paths.cache, "packages.json"),
        deep,
    })
}

/**
 * Looks at BEE2's packages folder (the desktop app does when BEE2 opens, and "Check packages"
 * with `deep`: every file in the zips is checked too):
 *   duplicates  what BEE2 refuses to load together (see duplicates.js). Each copy also has
 *               `file`, where it is in the packages folder, and `managed`: BeePM installed it.
 *   onBeepm     packages the user added themselves that are on BeePM, where BeePM's version
 *               gets updates: [{ id, name, file, package }]. Not the IDs in `keepOwn` (the user
 *               keeps their own copy), and not ones installed from BeePM too (duplicates).
 *   damaged     what BEE2 can't load (see bee2zip.js): [{ path, file, kind, message, managed,
 *               folders? }]; folders (packages in folders inside a zip) can be fixed, see
 *               fixPackageFolders
 *   offline     the registry couldn't be asked, so onBeepm is empty
 * Null if BeePM doesn't know where BEE2 is.
 */
export async function checkBee2Packages(ctx, { keepOwn = [], deep = false } = {}) {
    const { api, paths } = ctx
    if (!paths.bee2Dir) return null
    const root = bee2PackagesDir(paths.bee2Dir)
    const installed = await loadInstalled(paths)
    const managed = new Set(
        Object.values(installed.packages).map((e) => key(path.join(paths.packages, e.file))),
    )
    const scanned = (await scanBee2(paths, { deep })).map((pkg) => ({
        ...pkg,
        file: path.relative(root, pkg.path),
        managed: managed.has(key(pkg.path)),
    }))
    const damaged = scanned
        .filter((pkg) => pkg.problem)
        .map(({ path: file, file: rel, managed: ours, problem }) => ({
            path: file,
            file: rel,
            managed: ours,
            ...problem,
        }))
        .sort((a, b) => a.file.localeCompare(b.file))
    const found = scanned.filter((pkg) => !pkg.problem)
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
    const names = await lookupBeeIds(api, [...own.keys()]).catch((err) => {
        if (err.status === 0) offline = true
        return new Map()
    })
    for (const pkg of own.values()) {
        const found = names.get(pkg.id) ?? []
        const parsed = found.length === 1 ? parseName(found[0]) : null
        if (parsed) {
            onBeepm.push({
                id: pkg.id,
                name: pkg.name ?? pkg.id,
                file: pkg.file,
                package: formatName(parsed.scope, parsed.name),
            })
        }
    }
    onBeepm.sort((a, b) => a.name.localeCompare(b.name))
    return { duplicates, onBeepm, damaged, offline }
}

/**
 * Fixes a zip whose packages are in folders inside it (checkBee2Packages' damaged, with
 * folders): each folder becomes a package of its own next to it, and the zip is put away with
 * remove(file) (e.g. to the Recycle Bin), by default moved to BeePM's backups. Only for files in
 * BEE2's packages folder. Returns the new packages' files; nothing's changed if one can't be
 * made into a package BEE2 loads.
 */
export async function fixPackageFolders(ctx, file, folders, { remove = null } = {}) {
    const { paths } = ctx
    if (!paths.bee2Dir || !isInside(file, bee2PackagesDir(paths.bee2Dir))) {
        throw new Error(`${path.basename(file)} isn't in BEE2's packages folder.`)
    }
    const created = await repackFolders(file, folders, path.dirname(file))
    try {
        for (const made of created) {
            const { infoText, problem } = await inspectBee2Zip(made)
            if (problem) throw new Error(problem.message)
            readPackageInfo(infoText) // throws if it isn't a package after all
        }
    } catch (err) {
        for (const made of created) await rm(made, { force: true }).catch(() => {})
        throw new Error(`${path.basename(file)} can't be fixed: ${err.message}`)
    }
    if (remove) await remove(file)
    else await moveFile(file, await freePath(paths.replaced, path.basename(file)))
    return created
}

/**
 * The packages on BeePM for these BEE2 IDs: Map ID -> [names], only IDs that are on it. Asks for
 * them all at once; a registry from before that existed is asked one ID at a time.
 */
async function lookupBeeIds(api, ids) {
    const found = new Map()
    try {
        for (let i = 0; i < ids.length; i += LOOKUP_BATCH) {
            const { packages } = await api.lookupBeeIds(ids.slice(i, i + LOOKUP_BATCH))
            for (const [id, names] of Object.entries(packages ?? {})) found.set(id, names)
        }
        return found
    } catch (err) {
        if (err.status !== 404) throw err
    }
    await mapLimit(ids, LOOKUPS_AT_ONCE, async (id) => {
        // It refuses IDs it wouldn't accept for publishing: those aren't on BeePM
        const { packages } = await api.lookup({ beeId: id }).catch((err) => {
            if (err.status === 0) throw err
            return { packages: [] }
        })
        if (packages.length) found.set(id, packages)
    })
    return found
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

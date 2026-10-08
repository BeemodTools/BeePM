/**
 * Packages BEE2 refuses to load together, from a scan of its packages folder (client/scan.js):
 * the same package ID twice, or the same item ID in more than one package.
 *
 *   { packages: [{ id, name, copies: [package, ...] }],
 *     items: [{ items: [item ID, ...], packages: [{ id, name, copies: [package, ...] }] }] }
 *
 * Newest first everywhere (package.modified). An item conflict is between packages (each with
 * all its copies); the same item in two copies of one package is that package being there twice.
 */

const newest = (list, time) => [...list].sort((a, b) => (time(b) ?? 0) - (time(a) ?? 0))

export function findDuplicates(found) {
    const byId = new Map()
    for (const pkg of found) {
        if (!pkg.id) continue
        if (!byId.has(pkg.id)) byId.set(pkg.id, [])
        byId.get(pkg.id).push(pkg)
    }
    const all = [...byId].map(([id, list]) => {
        const copies = newest(list, (p) => p.modified)
        return { id, name: copies.find((c) => c.name)?.name ?? null, copies }
    })

    // Item ID -> the packages with it (going by their newest copy), grouped by those packages
    const byItem = new Map()
    for (const pkg of all) {
        for (const item of pkg.copies[0].items ?? []) {
            if (!byItem.has(item)) byItem.set(item, [])
            byItem.get(item).push(pkg)
        }
    }
    const conflicts = new Map()
    for (const [item, pkgs] of byItem) {
        if (pkgs.length < 2) continue
        const sorted = newest(pkgs, (p) => p.copies[0].modified)
        const key = sorted.map((p) => p.id).join("|")
        if (!conflicts.has(key)) conflicts.set(key, { items: [], packages: sorted })
        conflicts.get(key).items.push(item)
    }

    return { packages: all.filter((p) => p.copies.length > 1), items: [...conflicts.values()] }
}

export const hasDuplicates = (duplicates) =>
    Boolean(duplicates && (duplicates.packages.length || duplicates.items.length))

/**
 * The files to remove to fix duplicates: every copy of a package but the one kept, and every
 * copy of the packages not kept in an item conflict. choices: { packages: { [id]: path to keep },
 * items: { [index]: ID of the package to keep } }; without a (valid) choice the newest is kept.
 */
export function duplicateRemovals(duplicates, choices = {}) {
    const remove = new Set()
    for (const group of duplicates.packages) {
        const wanted = choices.packages?.[group.id]
        const keep = group.copies.some((c) => c.path === wanted) ? wanted : group.copies[0].path
        for (const copy of group.copies) if (copy.path !== keep) remove.add(copy.path)
    }
    duplicates.items.forEach((group, index) => {
        const wanted = choices.items?.[index]
        const keep = group.packages.some((p) => p.id === wanted) ? wanted : group.packages[0].id
        for (const pkg of group.packages) {
            if (pkg.id === keep) continue
            for (const copy of pkg.copies) remove.add(copy.path)
        }
    })
    return [...remove]
}

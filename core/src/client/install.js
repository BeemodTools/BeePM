import { mkdir, rename, rm } from "node:fs/promises"
import path from "node:path"
import semver from "semver"
import { isCompatible } from "../compat.js"
import { BUILTIN_SCOPE, formatName, normalizeBeeId, parseName, parseSpec } from "../names.js"
import { hashFile } from "../pack.js"
import { scanBee2 } from "./check.js"
import { downloadFile } from "./download.js"
import { exists, freePath, moveFile, readJson } from "./files.js"
import { packageFileName } from "./paths.js"
import { mapLimit } from "./scan.js"
import { loadConfig, loadInstalled, saveInstalled } from "./state.js"

const FETCHES_AT_ONCE = 6

/** An install/uninstall problem with a message meant for the user. */
export class InstallError extends Error {
    constructor(message, { code } = {}) {
        super(message)
        if (code) this.code = code
    }
}

const isBuiltin = (name) => parseName(name)?.scope === BUILTIN_SCOPE

/** Packages go in BEE2's packages folder, so BeePM has to know where BEE2 is. */
function requireBee2(paths) {
    if (!paths.packages) {
        throw new InstallError("Choose where BEE2 is installed first.", { code: "bee2_not_set" })
    }
}

/** Turns what the user typed into { name: "@scope/name", range } (bare names are looked up). */
export async function resolveSpec(api, spec) {
    let parsed
    try {
        parsed = parseSpec(spec)
    } catch (err) {
        throw new InstallError(err.message)
    }
    if (parsed.scope) return { name: formatName(parsed.scope, parsed.name), range: parsed.range }
    const { packages } = await api.lookup({ name: parsed.name })
    if (!packages.length) {
        throw new InstallError(
            `No package is called "${parsed.name}". Search with: beepm search ${parsed.name}`,
        )
    }
    if (packages.length > 1) {
        throw new InstallError(
            `Several packages are called "${parsed.name}": ${packages.join(", ")}. Use the full name.`,
        )
    }
    return { name: packages[0], range: parsed.range }
}

/** Finds an installed package by full name, unique bare name, or BEE2 ID. */
export function findInstalled(installed, spec) {
    const entries = Object.entries(installed.packages)
    let name = null
    try {
        const parsed = parseSpec(spec)
        if (parsed.scope) name = formatName(parsed.scope, parsed.name)
        else {
            const matches = entries
                .filter(([n]) => parseName(n).name === parsed.name)
                .map(([n]) => n)
            if (matches.length > 1) {
                throw new InstallError(
                    `Several installed packages are called "${parsed.name}": ${matches.join(", ")}.`,
                )
            }
            name = matches[0] ?? null
        }
    } catch (err) {
        if (err instanceof InstallError) throw err
    }
    if (!name || !installed.packages[name]) {
        const id = normalizeBeeId(spec)
        name = entries.find(([, e]) => id && e.beeId === id)?.[0] ?? name
    }
    if (!name || !installed.packages[name]) throw new InstallError(`${spec} isn't installed.`)
    return name
}

function describeWants(wants) {
    return wants.map((w) => `${w.range === "*" ? "any version" : w.range} (${w.by})`).join(" and ")
}

/**
 * Works out what installing or updating would do, without changing anything.
 *   specs   what the user asked for; empty with update = true means "update everything"
 *   update  pick the newest allowed versions instead of keeping installed ones
 * Returns { steps, warnings }. Each step is
 *   { name, from, to, range, explicit, sha256, size, beeId, dependencies, compatibleWith,
 *     replaces }
 * in dependency order (dependencies first). `replaces` lists the user's own copies of it in
 * BEE2's packages folder (same BEE2 ID): BEE2 can't load both, so they're moved to BeePM's
 * backups. Throws InstallError on conflicts.
 */
export async function planInstall(ctx, specs, { update = false, force = false } = {}) {
    const { api, paths } = ctx
    requireBee2(paths)
    const config = await loadConfig(paths)
    const installed = await loadInstalled(paths)
    const bee2Version = config.bee2?.version ?? null
    // What BEE2 has besides BeePM's packages: BEE2 ID -> files
    const own = new Map()
    for (const pkg of await scanBee2(paths, { skipBeepm: true })) {
        if (!pkg.id) continue
        if (!own.has(pkg.id)) own.set(pkg.id, [])
        own.get(pkg.id).push(pkg.path)
    }
    const warnings = []

    const docs = new Map()
    async function doc(name) {
        if (!docs.has(name)) {
            try {
                docs.set(name, await api.packument(name))
            } catch (err) {
                if (err.status === 404)
                    throw new InstallError(
                        `${name} isn't in the registry (it may have been removed).`,
                    )
                throw err
            }
        }
        return docs.get(name)
    }

    // Everything that will be installed afterwards: name -> { version, explicit, range }
    const selected = new Map(
        Object.entries(installed.packages).map(([name, e]) => [
            name,
            {
                version: e.version,
                explicit: e.explicit,
                range: e.range ?? "*",
                deps: e.dependencies ?? {},
            },
        ]),
    )
    const refresh = new Set() // packages whose version must be picked again
    const forced = new Set() // reinstalled even if the version doesn't change
    let explicitChanged = false

    if (specs.length) {
        for (const spec of specs) {
            const { name, range } = await resolveSpec(api, spec)
            const current = selected.get(name)
            if (current && !range && !update && !force) {
                warnings.push(
                    `${name}@${current.version} is already installed (beepm update ${name} gets newer versions).`,
                )
                if (!current.explicit) {
                    current.explicit = true
                    explicitChanged = true
                }
                continue
            }
            if (force) forced.add(name)
            selected.set(name, {
                version: current?.version ?? null,
                explicit: true,
                range: range ?? current?.range ?? "*",
                deps: current?.deps ?? {},
            })
            refresh.add(name)
        }
    } else if (update) {
        for (const name of selected.keys()) refresh.add(name)
    }

    /** What every selected package wants from `name`. */
    function wantsFor(name) {
        const wants = []
        const entry = selected.get(name)
        if (entry?.explicit) wants.push({ range: entry.range, by: "you" })
        for (const [other, e] of selected) {
            if (other !== name && e.version && e.deps[name]) {
                wants.push({ range: e.deps[name], by: `${other}@${e.version}` })
            }
        }
        return wants
    }

    const queue = [...refresh]
    const changed = new Set()
    let guard = 0
    while (queue.length) {
        if (++guard > 5000)
            throw new InstallError("Couldn't settle on a set of versions (dependency loop?).")
        const name = queue.shift()

        if (isBuiltin(name)) {
            const id = parseName(name).name
            if (own.size && !own.has(id)) {
                warnings.push(
                    `${name} is one of BEE2's own packages, but it isn't in your BEE2 packages folder.`,
                )
            }
            continue
        }

        const wants = wantsFor(name)
        const entry = selected.get(name) ?? { version: null, explicit: false, range: "*", deps: {} }
        const document = await doc(name)
        const exactPins = wants.map((w) => semver.valid(w.range)).filter(Boolean)
        const fits = (v) =>
            (!v.yanked || exactPins.includes(v.version)) &&
            wants.every((w) => semver.satisfies(v.version, w.range))
        const versions = Object.values(document.versions)
        const candidates = versions.filter(
            (v) => fits(v) && isCompatible(v.compatibleWith, bee2Version),
        )

        // Keep the installed version while it still fits, unless this package is being updated
        let version = null
        const current = entry.version && document.versions[entry.version]
        if (current && !refresh.has(name) && candidates.includes(current)) version = entry.version
        else if (candidates.length) version = semver.rsort(candidates.map((v) => v.version))[0]

        if (!version) {
            const fitting = versions.filter(fits)
            if (fitting.length) {
                const needs = [...new Set(fitting.map((v) => v.compatibleWith))].join(", ")
                throw new InstallError(
                    `${name} has no version for your BEE2 version (${bee2Version}). Its versions need BEE2 ${needs}.`,
                )
            }
            throw new InstallError(
                wants.length > 1
                    ? `${name} can't satisfy everything that needs it: ${describeWants(wants)}. BEE2 can only load one version.`
                    : `No version of ${name} matches ${describeWants(wants)}.`,
            )
        }

        refresh.delete(name)
        if (forced.delete(name)) changed.add(name)
        if (version !== entry.version || !selected.has(name)) {
            const deps = document.versions[version].dependencies ?? {}
            selected.set(name, { ...entry, version, deps })
            changed.add(name)
            // Its dependencies, and anything that depends on it, may need another look
            for (const dep of Object.keys(deps)) queue.push(dep)
            for (const [other, e] of selected) if (e.deps[name] && other !== name) queue.push(other)
        } else {
            for (const dep of Object.keys(entry.deps)) if (!selected.has(dep)) queue.push(dep)
        }
    }

    // Dependencies first
    const steps = []
    const visited = new Set()
    const visit = (name) => {
        if (visited.has(name) || !selected.has(name)) return
        visited.add(name)
        for (const dep of Object.keys(selected.get(name).deps)) visit(dep)
        if (!changed.has(name)) return
        const { version, explicit, range } = selected.get(name)
        const info = docs.get(name).versions[version]
        if (info.deprecated || docs.get(name).deprecated) {
            warnings.push(`${name} is deprecated: ${info.deprecated || docs.get(name).deprecated}`)
        }
        const from = installed.packages[name]?.version ?? null
        steps.push({
            name,
            from,
            to: version,
            change: !from
                ? "install"
                : semver.gt(version, from)
                  ? "upgrade"
                  : semver.lt(version, from)
                    ? "downgrade"
                    : "reinstall",
            range,
            explicit,
            sha256: info.sha256,
            size: info.size,
            beeId: docs.get(name).beeId,
            displayName: docs.get(name).displayName,
            dependencies: info.dependencies ?? {},
            compatibleWith: info.compatibleWith,
            replaces: own.get(docs.get(name).beeId) ?? [],
        })
    }
    for (const name of selected.keys()) visit(name)

    // `beepm install x` on a dependency makes it explicit without downloading anything
    const markExplicit = explicitChanged
        ? [...selected]
              .filter(
                  ([n, e]) =>
                      e.explicit && !installed.packages[n]?.explicit && installed.packages[n],
              )
              .map(([n]) => n)
        : []
    // BeePM's packages come first: BEE2 can't load the user's own copy too
    for (const step of steps) {
        if (!step.replaces.length) continue
        const files = step.replaces.map((file) => path.basename(file)).join(", ")
        warnings.push(
            `${step.name} replaces ${files} in BEE2's packages folder (kept in BeePM's backups).`,
        )
    }
    return { steps, warnings: [...new Set(warnings)], markExplicit }
}

/** Removes packages nothing needs anymore (installed as dependencies only). Returns their names. */
async function pruneOrphans(paths, installed) {
    const removed = []
    for (;;) {
        const needed = new Set()
        for (const entry of Object.values(installed.packages)) {
            for (const dep of Object.keys(entry.dependencies ?? {})) needed.add(dep)
        }
        const orphans = Object.entries(installed.packages).filter(
            ([n, e]) => !e.explicit && !needed.has(n),
        )
        if (!orphans.length) return removed
        for (const [name, entry] of orphans) {
            await rm(path.join(paths.packages, entry.file), { force: true })
            delete installed.packages[name]
            removed.push(name)
        }
    }
}

/**
 * Downloads and installs the steps of a plan into BeePM's folder in BEE2's packages folder.
 * Each file is checked against its SHA-256 before it replaces the old one, and the user's own
 * copies a step replaces are moved to BeePM's backups. Returns { installed, removed, replaced }
 * (replaced: [{ name, files }]).
 * onProgress({ index, count, name, version, received, total })
 */
export async function applyPlan(ctx, plan, { onProgress } = {}) {
    const { api, paths, fetch = globalThis.fetch } = ctx
    requireBee2(paths)
    await mkdir(paths.packages, { recursive: true })
    const installed = await loadInstalled(paths)
    const replaced = []
    for (const name of plan.markExplicit ?? []) {
        if (installed.packages[name]) installed.packages[name].explicit = true
    }
    for (const [index, step] of plan.steps.entries()) {
        const file = packageFileName(step.name)
        await downloadFile(api.downloadUrl(step.name, step.to), path.join(paths.packages, file), {
            fetch,
            expectedSha256: step.sha256,
            expectedSize: step.size,
            onProgress: (received, total) =>
                onProgress?.({
                    index,
                    count: plan.steps.length,
                    name: step.name,
                    version: step.to,
                    received,
                    total,
                }),
        })
        const previous = installed.packages[step.name]
        if (previous?.file && previous.file !== file) {
            await rm(path.join(paths.packages, previous.file), { force: true })
        }
        // The user's own copies give way (BEE2 can't load both), kept in BeePM's backups
        const moved = []
        for (const own of step.replaces ?? []) {
            if (!(await exists(own))) continue
            await moveFile(own, await freePath(paths.replaced, path.basename(own)))
            moved.push(path.basename(own))
        }
        if (moved.length) replaced.push({ name: step.name, files: moved })
        installed.packages[step.name] = {
            version: step.to,
            range: step.range,
            explicit: step.explicit,
            file,
            sha256: step.sha256,
            beeId: step.beeId,
            dependencies: step.dependencies,
            compatibleWith: step.compatibleWith,
            installedAt: new Date().toISOString(),
        }
        await saveInstalled(paths, installed)
    }
    const removed = await pruneOrphans(paths, installed)
    await saveInstalled(paths, installed)
    return { installed: plan.steps, removed, replaced }
}

/** Plans and applies in one go. Returns { installed, removed, warnings }. */
export async function install(ctx, specs, options = {}) {
    const plan = await planInstall(ctx, specs, options)
    const result = await applyPlan(ctx, plan, options)
    return { ...result, warnings: plan.warnings }
}

/**
 * Uninstalls packages and any dependencies nothing else needs.
 * Refuses if another installed package depends on one of them (unless force).
 */
export async function uninstall(ctx, specs, { force = false } = {}) {
    const { paths } = ctx
    requireBee2(paths)
    const installed = await loadInstalled(paths)
    const targets = specs.map((spec) => findInstalled(installed, spec))

    if (!force) {
        for (const target of targets) {
            const needers = Object.entries(installed.packages)
                .filter(([name, e]) => !targets.includes(name) && e.dependencies?.[target])
                .map(([name]) => name)
            if (needers.length) {
                throw new InstallError(
                    `${target} is needed by ${needers.join(", ")}. Uninstall that too, or use --force.`,
                )
            }
        }
    }
    for (const target of targets) {
        await rm(path.join(paths.packages, installed.packages[target].file), { force: true })
        delete installed.packages[target]
    }
    const orphans = await pruneOrphans(paths, installed)
    await saveInstalled(paths, installed)
    return { removed: [...targets, ...orphans] }
}

/** Installed packages with newer versions: [{ name, current, wanted, latest, deprecated, yanked }]. */
export async function outdated(ctx) {
    const { api, paths } = ctx
    const installed = await loadInstalled(paths)
    const bee2Version = (await loadConfig(paths)).bee2?.version ?? null
    const entries = Object.entries(installed.packages)
    const rows = await mapLimit(entries, FETCHES_AT_ONCE, async ([name, entry]) => {
        let document
        try {
            document = await api.packument(name)
        } catch (err) {
            if (err.status === 404) {
                return { name, current: entry.version, wanted: null, latest: null, removed: true }
            }
            throw err
        }
        const usable = Object.values(document.versions).filter(
            (v) => !v.yanked && isCompatible(v.compatibleWith, bee2Version),
        )
        const wanted = semver.maxSatisfying(
            usable.map((v) => v.version),
            entry.range ?? "*",
        )
        return {
            name,
            current: entry.version,
            wanted,
            latest: document.latest,
            deprecated: document.versions[entry.version]?.deprecated || document.deprecated || null,
            yanked: Boolean(document.versions[entry.version]?.yanked),
        }
    })
    return rows.filter(
        (r) =>
            r.removed ||
            r.yanked ||
            (r.wanted && r.wanted !== r.current) ||
            (r.latest && r.latest !== r.current),
    )
}

/**
 * Takes over packages installed by earlier BeePM versions (installed_packages.json, files named
 * <author>_<ID>.bee_pack in the folder BEE2 was hooked to): finds each one in the registry by
 * BEE2 ID, moves the file into BeePM's folder in BEE2's packages folder, and records it. Runs
 * once BeePM knows where BEE2 is; the old list is kept as installed_packages.old.json.
 */
export async function adoptLegacyInstalls(ctx) {
    const { api, paths } = ctx
    const legacy = await readJson(paths.legacyInstalled, null)
    if (!legacy?.packages || !paths.packages) return { adopted: [], unknown: [] }

    const installed = await loadInstalled(paths)
    const adopted = []
    const unknown = []
    for (const [beeId, entry] of Object.entries(legacy.packages)) {
        const oldFile = path.join(paths.hookedPackages, `${entry.author}_${beeId}.bee_pack`)
        if (!(await exists(oldFile))) continue
        let names = []
        try {
            ;({ packages: names } = await api.lookup({ beeId }))
        } catch {
            names = []
        }
        // The registry's answer becomes a file name: only a real package name will do
        const parsed = names.length === 1 ? parseName(names[0]) : null
        const name = parsed && formatName(parsed.scope, parsed.name)
        if (!name || installed.packages[name]) {
            unknown.push(beeId)
            continue
        }
        const file = packageFileName(name)
        const document = await api.packument(name).catch(() => null)
        await moveFile(oldFile, path.join(paths.packages, file))
        installed.packages[name] = {
            version: entry.version,
            range: "*",
            explicit: !entry.installed_as_dependency,
            file,
            sha256: await hashFile(path.join(paths.packages, file)),
            beeId: normalizeBeeId(beeId),
            dependencies: document?.versions?.[entry.version]?.dependencies ?? {},
            compatibleWith: document?.versions?.[entry.version]?.compatibleWith ?? null,
            installedAt: new Date().toISOString(),
            adoptedFromLegacy: true,
        }
        adopted.push(name)
    }
    await saveInstalled(paths, installed)
    await rename(
        paths.legacyInstalled,
        paths.legacyInstalled.replace(/\.json$/, ".old.json"),
    ).catch(() => {})
    return { adopted, unknown }
}

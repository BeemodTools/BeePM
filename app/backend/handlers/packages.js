import { randomUUID } from "node:crypto"
import { access, stat } from "node:fs/promises"
import path from "node:path"
import {
    adoptLegacyInstalls,
    applyPlan,
    findInstalled,
    findPackages,
    importLocal,
    loadConfig,
    loadInstalled,
    outdated,
    planImport,
    planInstall,
    removeLocal,
    uninstall,
} from "@beepm/core/client"
import {
    AppError,
    fileSize,
    isLocalPath,
    listOf,
    optionalText,
    requireText,
    throttle,
} from "../util.js"

const MAX_PLANS = 20

function specList(specs, { allowEmpty = false } = {}) {
    const list = Array.isArray(specs) ? specs : []
    if (!list.every((spec) => typeof spec === "string" && spec.trim())) {
        throw new AppError("Package names must be text.")
    }
    if (!list.length && !allowEmpty) throw new AppError("Say which packages to use.")
    return list.map((spec) => spec.trim())
}

/** A plan's step in the log: "@a/b@1.0.0, 2.1 MB" or "@a/b 1.0.0 -> 1.1.0, 2.1 MB". */
function describeStep({ name, from, to, change, size }) {
    const versions =
        change === "upgrade" || change === "downgrade"
            ? `${name} ${from} -> ${to}`
            : `${name}@${to}${change === "reinstall" ? " again" : ""}`
    return `${versions}, ${fileSize(size)}`
}

/** What a package to import is called: its info.txt name, or its file or folder name. */
const importName = (item) => item.name ?? path.basename(item.path)

const isFolder = (dir) =>
    stat(dir).then(
        (info) => info.isDirectory(),
        () => false,
    )
const normalize = (p) =>
    process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p)
const samePath = (a, b) => normalize(a) === normalize(b)

/**
 * Install, update and uninstall. Installing is two steps so the window can show the plan first:
 * packages:plan returns the steps and a planId, packages:apply(planId) downloads them and sends
 * "packages:progress" events. Importing from this PC works the same way (packages:import-scan,
 * then packages:import-apply; see core's local.js), with "packages:import-progress" events:
 * { phase: "read" | "check" | "copy" | "download", done, total, name?, received?, size? }.
 */
export function packageHandlers(shared) {
    const { ctx, deps, log, step } = shared
    const plans = new Map() // planId -> plan, until it's applied or discarded
    const imports = new Map() // importId -> planImport's items, until they're imported
    const importProgress = () =>
        throttle((progress) => deps.send("packages:import-progress", progress), {
            key: (p) => `${p.phase}:${p.name ?? ""}`,
        })

    return {
        "packages:installed": async () => {
            const installed = await loadInstalled(ctx.paths)
            return { packages: installed.packages, local: installed.local }
        },

        // options: { update: pick the newest allowed versions (no specs = everything), force: reinstall }
        "packages:plan": async (specs, options = {}) => {
            const update = Boolean(options?.update)
            const list = specList(specs, { allowEmpty: update })
            const plan = await planInstall(ctx, list, { update, force: Boolean(options?.force) })
            const planId = randomUUID()
            plans.set(planId, plan)
            while (plans.size > MAX_PLANS) plans.delete(plans.keys().next().value)
            return {
                planId,
                steps: plan.steps,
                warnings: plan.warnings,
                markExplicit: plan.markExplicit ?? [],
            }
        },

        "packages:apply": (planId) =>
            shared.lock(async () => {
                const plan = plans.get(planId)
                if (!plan) throw new AppError("That install plan is out of date. Try again.")
                plans.delete(planId)
                const names = plan.steps.map((s) => `${s.name}@${s.to}`)
                const updating = names.length && plan.steps.every((s) => s.change === "upgrade")
                const title = names.length
                    ? `${updating ? "Updating" : "Installing"} ${listOf(names, "packages")}`
                    : `Installing ${listOf(plan.markExplicit ?? [], "packages")}`
                return step(title, async () => {
                    for (const s of plan.steps) log.info(describeStep(s))
                    for (const warning of plan.warnings) log.warn(warning)
                    const report = throttle(
                        (progress) => deps.send("packages:progress", { planId, ...progress }),
                        { key: (p) => p.index },
                    )
                    try {
                        const result = await applyPlan(ctx, plan, { onProgress: report })
                        for (const name of result.removed) {
                            log.info(`Removed ${name}: nothing needs it anymore`)
                        }
                        for (const name of result.replacedLocal) {
                            log.info(`Replaced the local copy of ${name}`)
                        }
                        return {
                            installed: result.installed.map(
                                ({ name, from, to, change, explicit }) => ({
                                    name,
                                    from,
                                    to,
                                    change,
                                    explicit,
                                }),
                            ),
                            removed: result.removed,
                            replacedLocal: result.replacedLocal,
                            warnings: plan.warnings,
                        }
                    } finally {
                        report.flush()
                    }
                })
            }),

        "packages:discard-plan": async (planId) => {
            plans.delete(planId)
            return {}
        },

        // Refuses (code "has_dependents") if other installed packages need one of them, unless force
        "packages:uninstall": (names, options = {}) =>
            shared.lock(() => {
                const list = specList(names)
                const force = Boolean(options?.force)
                return step(`Uninstalling ${listOf(list, "packages")}`, async () => {
                    if (!force) {
                        const installed = await loadInstalled(ctx.paths)
                        const targets = list.map((spec) => findInstalled(installed, spec))
                        const dependents = targets
                            .map((name) => ({
                                name,
                                neededBy: Object.entries(installed.packages)
                                    .filter(
                                        ([other, e]) =>
                                            !targets.includes(other) && e.dependencies?.[name],
                                    )
                                    .map(([other]) => other),
                            }))
                            .filter((d) => d.neededBy.length)
                        if (dependents.length) {
                            const message = dependents
                                .map((d) => `${d.name} is needed by ${d.neededBy.join(", ")}.`)
                                .join(" ")
                            throw new AppError(message, { code: "has_dependents", dependents })
                        }
                    }
                    const { removed } = await uninstall(ctx, list, { force })
                    for (const name of removed) log.info(`Removed ${name}`)
                    return { removed }
                })
            }),

        "packages:outdated": async () => ({ rows: await outdated(ctx) }),

        // kind: "file" (a .bee_pack or .zip) or "folder" (a package folder, or a folder of them)
        "packages:pick-import": async (kind) => {
            const result = await deps.showOpenDialog(
                kind === "folder"
                    ? { title: "Choose a folder", properties: ["openDirectory"] }
                    : {
                          title: "Choose a package",
                          properties: ["openFile"],
                          filters: [{ name: "BEE2 packages", extensions: ["bee_pack", "zip"] }],
                      },
            )
            if (result.canceled || !result.filePaths?.length) return { canceled: true }
            return { canceled: false, path: result.filePaths[0] }
        },

        /**
         * What importing a file or folder from this PC would do: { importId, offline, items:
         * [{ name, file, action: "beepm" | "local" | "skip", package?, reason?, replaces }] }.
         */
        "packages:import-scan": async (input) => {
            const text = optionalText(input)
            if (!text) throw new AppError("Choose a package or a folder.")
            const target = path.resolve(text)
            if (!isLocalPath(target)) throw new AppError("Choose a file or folder on this PC.")
            const report = importProgress()
            let scanned
            try {
                const found = await findPackages(target, {
                    onProgress: (p) => report({ phase: "read", ...p }),
                })
                scanned = await planImport(ctx, found, {
                    onProgress: (p) => report({ phase: "check", ...p }),
                })
            } finally {
                report.flush()
            }
            const { items, offline } = scanned
            if (!items.length) throw new AppError("There are no packages there.")
            const count = (action) => items.filter((item) => item.action === action).length
            log.info(
                `Import from ${target}: ${count("local")} local, ${count("beepm")} from BeePM, ${count("skip")} skipped${offline ? " (BeePM couldn't be reached)" : ""}`,
            )
            const importId = randomUUID()
            imports.set(importId, items)
            while (imports.size > MAX_PLANS) imports.delete(imports.keys().next().value)
            return {
                importId,
                offline,
                items: items.map((item) => ({
                    name: importName(item),
                    // Where it is in the folder chosen (packages can be in folders inside it)
                    file: path.relative(target, item.path) || path.basename(item.path),
                    action: item.action,
                    package: item.package ?? null,
                    reason: item.reason ?? null,
                    replaces: Boolean(item.replaces),
                })),
            }
        },

        // Copies the local ones in, and installs the ones on BeePM from there
        "packages:import-apply": (importId) =>
            shared.lock(async () => {
                const items = imports.get(importId)
                if (!items) throw new AppError("That import is out of date. Try again.")
                imports.delete(importId)
                const local = items.filter((item) => item.action === "local")
                const fromBeepm = items.filter((i) => i.action === "beepm").map((i) => i.package)
                const names = [...local.map(importName), ...fromBeepm]
                if (!names.length) throw new AppError("There's nothing to import.")
                return step(`Importing ${listOf(names, "packages")}`, async () => {
                    const report = importProgress()
                    try {
                        for (const [index, item] of local.entries()) {
                            const name = importName(item)
                            report({ phase: "copy", done: index, total: local.length, name })
                            await importLocal(ctx.paths, item)
                            log.info(`${name}: copied in from ${item.path}`)
                        }
                        let installed = []
                        if (fromBeepm.length) {
                            const plan = await planInstall(ctx, fromBeepm)
                            for (const s of plan.steps) log.info(`${describeStep(s)}, from BeePM`)
                            const result = await applyPlan(ctx, plan, {
                                onProgress: (p) =>
                                    report({
                                        phase: "download",
                                        done: p.index,
                                        total: p.count,
                                        name: p.name,
                                        received: p.received,
                                        size: p.total,
                                    }),
                            })
                            installed = result.installed.map((s) => `${s.name}@${s.to}`)
                        }
                        return { imported: local.map(importName), installed }
                    } finally {
                        report.flush()
                    }
                })
            }),

        /**
         * The folders BEE2 loaded packages from before BeePM hooked it, if they're still there:
         * { hooked, folders }. BEE2 doesn't load them while it's hooked, so they're offered for
         * importing. A relative one is in BEE2's own folder, known once BeePM has seen BEE2 run.
         */
        "packages:import-sources": async () => {
            const config = await loadConfig(ctx.paths)
            if (!config.hook) return { hooked: false, folders: [] }
            // No setting means BEE2's default: the packages folder next to BEE2.exe
            const setting = config.hook.originalPackageDir || "packages/"
            const program = await shared.bee2Program()
            const folders = []
            for (const part of String(setting).split(";")) {
                const dir = part.trim()
                if (!dir) continue
                const folder = path.isAbsolute(dir)
                    ? dir
                    : program && path.resolve(path.dirname(program), dir)
                if (!folder || samePath(folder, ctx.paths.packages)) continue
                if (await isFolder(folder)) folders.push(path.resolve(folder))
            }
            return { hooked: true, folders }
        },

        "packages:remove-local": (beeId) =>
            shared.lock(async () => {
                const id = requireText(beeId, "Say which package.")
                const { local } = await loadInstalled(ctx.paths)
                return step(`Removing ${local[id]?.name ?? "a local package"}`, async () => {
                    await removeLocal(ctx.paths, id)
                    return {}
                })
            }),
    }
}

/**
 * Takes over packages installed by earlier BeePM versions. Adoption looks every package up in the registry
 * and then retires the old list, so it only runs while the registry can be reached.
 */
export async function adoptOldInstalls({ ctx, deps, lock, log, step }) {
    const exists = await access(ctx.paths.legacyInstalled).then(
        () => true,
        () => false,
    )
    if (!exists) return
    try {
        await ctx.api.info()
    } catch {
        return
    }
    const { adopted, unknown } = await lock(() =>
        step("Taking over packages installed by an earlier BeePM version", async () => {
            const result = await adoptLegacyInstalls(ctx)
            for (const name of result.adopted) log.info(`Took over ${name}`)
            if (result.unknown.length) {
                log.warn(`Not in the registry, left alone: ${result.unknown.join(", ")}`)
            }
            return result
        }),
    )
    if (adopted.length) {
        deps.send("packages:changed", {})
        deps.send("app:notice", {
            severity: "success",
            message: `Took over ${adopted.length} package(s) installed by an earlier BeePM version.`,
        })
    }
    if (unknown.length) {
        deps.send("app:notice", {
            severity: "warning",
            message: `These packages from an earlier BeePM version aren't in the registry and were left alone: ${unknown.join(", ")}`,
        })
    }
}

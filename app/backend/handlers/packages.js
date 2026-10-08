import { randomUUID } from "node:crypto"
import { access } from "node:fs/promises"
import {
    adoptLegacyInstalls,
    applyPlan,
    findInstalled,
    loadInstalled,
    outdated,
    planInstall,
    uninstall,
} from "@beepm/core/client"
import { AppError, fileSize, listOf, throttle } from "../util.js"

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

/**
 * Install, update and uninstall. Installing is two steps so the window can show the plan first:
 * packages:plan returns the steps and a planId, packages:apply(planId) downloads them and sends
 * "packages:progress" events. Packages go in BeePM's folder in BEE2's packages folder; the
 * user's own copy of one goes to BeePM's backups (`replaced`).
 */
export function packageHandlers(shared) {
    const { ctx, deps, log, step } = shared
    const plans = new Map() // planId -> plan, until it's applied or discarded

    /**
     * BEE2 has its packages open while it runs (changing them fails with EBUSY): that's refused,
     * with code "bee2_running". What's left of a BEE2 that crashed is ended instead.
     */
    async function whileBee2IsClosed() {
        if (!ctx.paths.bee2Dir) return
        if (await shared.isLocked()) {
            throw new AppError("BEE2 is open. Close it to install or remove packages.", {
                code: "bee2_running",
            })
        }
        await shared.endLeftoverBee2()
    }

    return {
        "packages:installed": async () => {
            const installed = await loadInstalled(ctx.paths)
            return { packages: installed.packages }
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
                await whileBee2IsClosed()
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
                        for (const { name, files } of result.replaced) {
                            log.info(`${name} replaced ${files.join(", ")} (moved to backups)`)
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
                            replaced: result.replaced,
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
            shared.lock(async () => {
                const list = specList(names)
                const force = Boolean(options?.force)
                await whileBee2IsClosed()
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
    }
}

/**
 * Takes over packages installed by earlier BeePM versions. Adoption looks every package up in the registry
 * and then retires the old list, so it only runs while the registry can be reached.
 */
export async function adoptOldInstalls({ ctx, deps, lock, log, step }) {
    if (!ctx.paths.packages) return // It waits for BeePM to know where BEE2 is
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

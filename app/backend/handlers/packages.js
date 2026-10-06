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
import { AppError, throttle } from "../util.js"

const MAX_PLANS = 20

function specList(specs, { allowEmpty = false } = {}) {
    const list = Array.isArray(specs) ? specs : []
    if (!list.every((spec) => typeof spec === "string" && spec.trim())) {
        throw new AppError("Package names must be text.")
    }
    if (!list.length && !allowEmpty) throw new AppError("Say which packages to use.")
    return list.map((spec) => spec.trim())
}

/**
 * Install, update and uninstall. Installing is two steps so the window can show the plan first:
 * packages:plan returns the steps and a planId, packages:apply(planId) downloads them and sends
 * "packages:progress" events.
 */
export function packageHandlers(shared) {
    const { ctx, deps } = shared
    const plans = new Map() // planId -> plan, until it's applied or discarded

    return {
        "packages:installed": async () => ({ packages: (await loadInstalled(ctx.paths)).packages }),

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
                const report = throttle(
                    (progress) => deps.send("packages:progress", { planId, ...progress }),
                    { key: (p) => p.index },
                )
                try {
                    const result = await applyPlan(ctx, plan, { onProgress: report })
                    return {
                        installed: result.installed.map(({ name, from, to, change, explicit }) => ({
                            name,
                            from,
                            to,
                            change,
                            explicit,
                        })),
                        removed: result.removed,
                        warnings: plan.warnings,
                    }
                } finally {
                    report.flush()
                }
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
                return { removed }
            }),

        "packages:outdated": async () => ({ rows: await outdated(ctx) }),
    }
}

/**
 * Takes over packages installed by earlier BeePM versions. Adoption looks every package up in the registry
 * and then retires the old list, so it only runs while the registry can be reached.
 */
export async function adoptOldInstalls({ ctx, deps, lock }) {
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
    const { adopted, unknown } = await lock(() => adoptLegacyInstalls(ctx))
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

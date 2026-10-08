import { randomUUID } from "node:crypto"
import path from "node:path"
import { duplicateRemovals } from "@beepm/core"
import { bee2Info, findBee2Folder } from "@beepm/core/client"
import { AppError, isLocalPath, optionalText } from "../util.js"

const MAX_REVIEWS = 10
const CLOSE_WAIT_MS = 2 * 60 * 1000

const strings = (list) => (Array.isArray(list) ? list.filter((v) => typeof v === "string") : [])

/** A copy of a package, for the window: where it is, when it changed, BeePM's or not. */
const copyForWindow = ({ path: file, file: rel, name, modified, managed }) => ({
    path: file,
    file: rel,
    name: name ?? null,
    modified: modified ? new Date(modified).toISOString() : null,
    managed: Boolean(managed),
})

/**
 * BEE2's folder (where BeePM installs: a "beepm" folder in its packages folder) and the BEE2
 * check: duplicates, and the user's own packages that are on BeePM (see core's check.js).
 */
export function bee2Handlers(shared) {
    const { ctx, deps, log, step } = shared
    const reviews = new Map() // reviewId -> the check the window shows, until it's acted on

    /** BEE2's folder from the running BEE2 (to suggest it), or null. */
    async function runningFolder() {
        if (!(await shared.bee2Process.isRunning())) return null
        const program = await shared.bee2Program()
        return program ? findBee2Folder(path.dirname(program)).catch(() => null) : null
    }

    /** Waits up to `ms` for BeePM's BEE2 to close (it may ask the user something first). */
    async function waitForExit(ms) {
        for (let waited = 0; await shared.isLocked(); waited += 1000) {
            if (waited >= ms) return false
            await new Promise((resolve) => setTimeout(resolve, 1000))
        }
        return true
    }

    return {
        /**
         * { dir, version, found, packagesDir, suggestion, moving }: BEE2's folder and version
         * (from its log), the running BEE2's folder as a suggestion when BeePM doesn't know one,
         * and what undoing the hook of earlier 1.0 builds waits for ("folder" or "bee2").
         */
        "bee2:status": async () => {
            // A hook BEE2 kept from being undone (it was open) can be undone once it's closed
            if (shared.hookState?.waitingFor === "bee2") {
                await shared.leaveHook().catch((err) => log.warn(err.message))
            }
            const info = await bee2Info(ctx)
            return {
                ...info,
                packagesDir: ctx.paths.packages,
                suggestion: info.dir ? null : await runningFolder(),
                moving: shared.hookState?.waitingFor ?? null,
            }
        },

        "bee2:pick-folder": async () => {
            const result = await deps.showOpenDialog({
                title: "Choose BEE2's folder (the one BEE2.exe is in)",
                properties: ["openDirectory"],
            })
            if (result.canceled || !result.filePaths?.length) return { canceled: true }
            return { canceled: false, path: result.filePaths[0] }
        },

        /**
         * Uses BEE2 from a folder (BEE2's, or one inside it like its packages folder): { dir,
         * version, moved } (moved: BeePM's packages that came along from the BEE2 before).
         */
        "bee2:set-folder": (input) =>
            step("Choosing BEE2's folder", async () => {
                const picked = optionalText(input)
                if (!picked || !isLocalPath(picked))
                    throw new AppError("Choose a folder on this PC.")
                return shared.useBee2Folder(picked)
            }),

        /**
         * What the BEE2 check finds now, for BeePM's window to choose from: { reviewId,
         * duplicates, onBeepm, offline }. Each copy of a package has { path, file, name, modified,
         * managed } (managed: installed from BeePM).
         */
        "bee2:check": async () => {
            const check = await shared.checkBee2()
            if (!check) {
                throw new AppError("Choose where BEE2 is installed first.", {
                    code: "bee2_not_set",
                })
            }
            const reviewId = randomUUID()
            reviews.set(reviewId, check)
            while (reviews.size > MAX_REVIEWS) reviews.delete(reviews.keys().next().value)
            const pkg = (p) => ({ id: p.id, name: p.name, copies: p.copies.map(copyForWindow) })
            return {
                reviewId,
                duplicates: {
                    packages: check.duplicates.packages.map(pkg),
                    items: check.duplicates.items.map((g) => ({
                        items: g.items,
                        packages: g.packages.map(pkg),
                    })),
                },
                onBeepm: check.onBeepm,
                offline: check.offline,
            }
        },

        /**
         * Does what the user chose in BeePM's window for a check: { reviewId, choices (which
         * copy or package to keep, see duplicateRemovals), adopt: [BEE2 IDs to switch to
         * BeePM's version], keep: [BEE2 IDs whose own copy stays, not asked about again],
         * closeBee2 }. BEE2 has the package files open: with closeBee2 it's asked to close (and
         * opened again after); otherwise a running BEE2 is the answer, with code "bee2_running".
         */
        "bee2:resolve": async (request = {}) => {
            const review = reviews.get(request?.reviewId)
            if (!review) throw new AppError("That check is out of date. Check again.")
            const choices = {
                packages: Object(request.choices?.packages),
                items: Object(request.choices?.items),
            }
            const remove = duplicateRemovals(review.duplicates, choices)
            const adoptIds = new Set(strings(request.adopt))
            const keepIds = new Set(strings(request.keep))
            const adopt = review.onBeepm.filter((p) => adoptIds.has(p.id)).map((p) => p.package)
            const keep = review.onBeepm.filter((p) => keepIds.has(p.id)).map((p) => p.id)
            if (keep.length) await shared.keepOwn(keep)
            if (!remove.length && !adopt.length) {
                reviews.delete(request.reviewId)
                return { removed: [], uninstalled: [], installed: [], replaced: [] }
            }

            // Only BeePM's BEE2 has these files open (another BEE2 can stay open)
            let program = null
            if (await shared.isLocked()) {
                if (!request.closeBee2) {
                    throw new AppError("BEE2 is open, and it has the package files open.", {
                        code: "bee2_running",
                    })
                }
                program = await shared.bee2Process.findProgram(ctx.paths.bee2Dir)
                const asked = await shared.bee2Process.askToClose(ctx.paths.bee2Dir)
                if (!(await waitForExit(asked ? CLOSE_WAIT_MS : 0))) {
                    throw new AppError("BEE2 didn't close. Close it, then try again.", {
                        code: "bee2_running",
                    })
                }
            }
            reviews.delete(request.reviewId)
            try {
                return await shared.applyWork({ remove, adopt })
            } finally {
                if (program) deps.openProgram(program)
            }
        },
    }
}

import { stat } from "node:fs/promises"
import path from "node:path"
import { duplicateRemovals } from "@beepm/core"
import { bee2Info, findBee2Folder } from "@beepm/core/client"
import { AppError, isLocalPath, optionalText } from "../util.js"

const CLOSE_WAIT_MS = 2 * 60 * 1000
// "Close BEE2" in the window waits this long for it to close, then says it didn't
const CLOSE_NOW_MS = 20 * 1000

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
    const { reviews } = shared // reviewId -> a check the user is shown, until it's acted on

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

        /**
         * { running }: BeePM's BEE2 is open, so it has its package files open: packages can't be
         * installed, updated or removed until it's closed. (What's left of a BEE2 that crashed
         * isn't BEE2 open.)
         */
        "bee2:running": async () => ({
            running: Boolean(ctx.paths.bee2Dir) && (await shared.isLocked()),
        }),

        /** Opens BeePM's BEE2: { opened } (false when it's open already). */
        "bee2:open": async () => {
            if (!ctx.paths.bee2Dir) {
                throw new AppError("Choose where BEE2 is installed first.", {
                    code: "bee2_not_set",
                })
            }
            if (await shared.isLocked()) return { opened: false }
            let program = null
            for (const name of ["BEE2.exe", "BEE2"]) {
                const file = path.join(ctx.paths.bee2Dir, name)
                if ((await stat(file).catch(() => null))?.isFile()) {
                    program = file
                    break
                }
            }
            if (!program) throw new AppError(`BEE2 isn't in ${ctx.paths.bee2Dir} anymore.`)
            deps.openProgram(program)
            return { opened: true }
        },

        /**
         * Asks BeePM's BEE2 to close the way its close button does (it saves), and waits for it:
         * { closed }. It can't be asked while a window of its own is open in it (code
         * "bee2_busy"), and it may not close (code "bee2_running"). Never forced.
         */
        "bee2:close": async () => {
            if (!ctx.paths.bee2Dir || !(await shared.isLocked())) return { closed: true }
            if (!(await shared.bee2Process.askToClose(ctx.paths.bee2Dir))) {
                throw new AppError(
                    "BEE2 has a window open. Close that window in BEE2, then try again.",
                    { code: "bee2_busy" },
                )
            }
            if (!(await waitForExit(CLOSE_NOW_MS))) {
                throw new AppError("BEE2 didn't close. Check whether it's asking you something.", {
                    code: "bee2_running",
                })
            }
            log.info("Closed BEE2")
            return { closed: true }
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
         * What the BEE2 check finds, to choose from: { reviewId, duplicates, onBeepm, offline }.
         * With { reviewId } it's that check again (the corner window's "Choose": BEE2's packages
         * were just looked at), else a new one. Each copy of a package has { path, file, name,
         * modified, managed } (managed: installed from BeePM).
         */
        "bee2:check": async (request = {}) => {
            let reviewId = typeof request?.reviewId === "string" ? request.reviewId : null
            let check = reviewId ? reviews.get(reviewId) : null
            if (!check) {
                check = await shared.checkBee2()
                if (!check) {
                    throw new AppError("Choose where BEE2 is installed first.", {
                        code: "bee2_not_set",
                    })
                }
                reviewId = shared.rememberReview(check)
            }
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

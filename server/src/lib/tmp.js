import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomId } from "./ids.js"

/**
 * A temporary folder for one request. file() hands out paths inside it;
 * cleanup() deletes everything.
 */
export async function createTemp() {
    const dir = await mkdtemp(path.join(os.tmpdir(), "beepm-"))
    return {
        dir,
        file: async (suffix = "") => path.join(dir, randomId(9) + suffix),
        cleanup: () => rm(dir, { recursive: true, force: true }).catch(() => {}),
    }
}

/** Runs fn(tmp) and always cleans up afterwards. */
export async function withTemp(fn) {
    const tmp = await createTemp()
    try {
        return await fn(tmp)
    } finally {
        await tmp.cleanup()
    }
}

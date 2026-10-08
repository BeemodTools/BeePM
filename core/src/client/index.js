import { createApi, DEFAULT_REGISTRY } from "./api.js"
import { bee2Paths, beepmPaths, useBee2Folder } from "./paths.js"
import { loadConfig } from "./state.js"

export * from "./api.js"
export * from "./auth.js"
export * from "./bee2.js"
export * from "./bee2log.js"
export * from "./check.js"
export * from "./download.js"
export * from "./files.js"
export * from "./github.js"
export * from "./install.js"
export * from "./paths.js"
export * from "./publish.js"
export * from "./scan.js"
export * from "./state.js"

/**
 * Everything the client functions need, in one object:
 *   { paths, bee2, api, fetch, registry }
 * paths points at BEE2's folder from config.json (see useBee2Folder); bee2 is where BEE2's own
 * config.cfg is. The registry is BEEPM_REGISTRY, else config.json's "registry", else the public
 * one.
 */
export async function createClientContext({
    env = process.env,
    fetch = globalThis.fetch,
    token = null,
    userAgent,
} = {}) {
    const paths = beepmPaths(env)
    const config = await loadConfig(paths)
    useBee2Folder(paths, config.bee2?.dir ?? null)
    const registry = env.BEEPM_REGISTRY || config.registry || DEFAULT_REGISTRY
    return {
        paths,
        bee2: bee2Paths(env),
        fetch,
        registry,
        api: createApi({ registry, token, fetch, userAgent }),
    }
}

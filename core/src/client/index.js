import { createApi, DEFAULT_REGISTRY } from "./api.js"
import { bee2Paths, beepmPaths } from "./paths.js"
import { loadConfig } from "./state.js"

export * from "./api.js"
export * from "./auth.js"
export * from "./bee2.js"
export * from "./download.js"
export * from "./files.js"
export * from "./github.js"
export * from "./install.js"
export * from "./paths.js"
export * from "./publish.js"
export * from "./state.js"

/**
 * Everything the client functions need, in one object:
 *   { paths, bee2, api, fetch, registry }
 * The registry is BEEPM_REGISTRY, else config.json's "registry", else the public one.
 */
export async function createClientContext({
    env = process.env,
    fetch = globalThis.fetch,
    token = null,
    userAgent,
} = {}) {
    const paths = beepmPaths(env)
    const config = await loadConfig(paths)
    const registry = env.BEEPM_REGISTRY || config.registry || DEFAULT_REGISTRY
    return {
        paths,
        bee2: bee2Paths(env),
        fetch,
        registry,
        api: createApi({ registry, token, fetch, userAgent }),
    }
}

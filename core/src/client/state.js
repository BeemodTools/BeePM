import { readJson, writeJson } from "./files.js"

/**
 * config.json:
 * {
 *   "registry": "https://..."               optional override
 *   "bee2": { "dir": "C:\\...\\BEE2", "version": "2.4.46.1" }   BEE2's folder, and its version
 *                                            from its log (see bee2.js)
 * }
 * Earlier 1.0 builds also kept "hook" ({ originalPackageDir, hookedAt }) and BEE2's own
 * packages they downloaded (bee2.basePackages, bee2.baseFiles...): see leaveHook.
 */
export async function loadConfig(paths) {
    const config = await readJson(paths.config, null)
    if (config) return config
    // Earlier BeePM versions kept {bee2_version, bee2_version_name, beemod_version} in beepm_config.json
    const legacy = await readJson(paths.legacyConfig, null)
    if (legacy?.bee2_version || legacy?.beemod_version) {
        return {
            bee2: {
                dir: null,
                version: String(legacy.bee2_version || legacy.beemod_version).replace(/^v/i, ""),
            },
        }
    }
    return {}
}

export const saveConfig = (paths, config) => writeJson(paths.config, config)

/**
 * installed.json:
 * { "packages": { "@scope/name": { version, range, explicit, file, sha256, beeId,
 *                                  dependencies, compatibleWith, installedAt } } }
 * `explicit` is false for packages installed only because something depends on them. Earlier
 * 1.0 builds also had "local" (packages imported from this PC): see leaveHook.
 */
export async function loadInstalled(paths) {
    const data = await readJson(paths.installed, null)
    return { packages: data?.packages ?? {}, local: data?.local ?? {} }
}

export const saveInstalled = (paths, installed) =>
    writeJson(paths.installed, {
        packages: installed.packages,
        ...(Object.keys(installed.local ?? {}).length ? { local: installed.local } : {}),
    })

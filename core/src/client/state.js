import { readJson, writeJson } from "./files.js"

/**
 * config.json:
 * {
 *   "registry": "https://..."               optional override
 *   "bee2": { "version": "2.4.46.1", "name": "Version 4.46.1", "itemsTag": "v4.46.0",
 *             "basePackages": ["BEE2_CLEAN_STYLE", ...], "baseFiles": ["clean_style.bee_pack", ...],
 *             "installedAt": "..." }
 *   "hook": { "originalPackageDir": "../packages/" | null, "hookedAt": "..." }
 * }
 */
export async function loadConfig(paths) {
    const config = await readJson(paths.config, null)
    if (config) return config
    // Earlier BeePM versions kept {bee2_version, bee2_version_name, beemod_version} in beepm_config.json
    const legacy = await readJson(paths.legacyConfig, null)
    if (legacy?.bee2_version || legacy?.beemod_version) {
        return {
            bee2: {
                version: String(legacy.bee2_version || legacy.beemod_version).replace(/^v/i, ""),
                name: legacy.bee2_version_name ?? null,
                basePackages: [],
                baseFiles: [],
                fromLegacy: true,
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
 * `explicit` is false for packages installed only because something depends on them.
 */
export async function loadInstalled(paths) {
    const data = await readJson(paths.installed, null)
    return data?.packages ? data : { packages: {} }
}

export const saveInstalled = (paths, installed) =>
    writeJson(paths.installed, { packages: installed.packages })

import os from "node:os"
import path from "node:path"

/** The roaming app-data folder (%APPDATA% on Windows, ~/.config elsewhere). */
function appData(env) {
    if (env.APPDATA) return env.APPDATA
    if (process.platform === "darwin")
        return path.join(os.homedir(), "Library", "Application Support")
    return env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
}

/**
 * Where BeePM keeps its files. BEEPM_HOME overrides the folder (used by tests).
 *   packages/          the folder BEE2 is hooked to (base packages + installed ones)
 *   config/config.json BEE2 version, hook state, registry override
 *   config/installed.json
 *   config/credentials.json  CLI login (the desktop app keeps its own, encrypted)
 */
export function beepmPaths(env = process.env) {
    const root = env.BEEPM_HOME || path.join(appData(env), "beepm")
    const configDir = path.join(root, "config")
    return {
        root,
        packages: path.join(root, "packages"),
        cache: path.join(root, "cache"),
        configDir,
        config: path.join(configDir, "config.json"),
        installed: path.join(configDir, "installed.json"),
        credentials: path.join(configDir, "credentials.json"),
        // BeePM 1 files, adopted on first run
        legacyConfig: path.join(configDir, "beepm_config.json"),
        legacyInstalled: path.join(configDir, "installed_packages.json"),
        legacyAuth: path.join(configDir, "auth.json"),
    }
}

/** BEE2's config. BEE2_CONFIG_DIR overrides the folder that holds config.cfg (used by tests). */
export function bee2Paths(env = process.env) {
    const configDir = env.BEE2_CONFIG_DIR || path.join(appData(env), "BEEMOD2", "config")
    return { configDir, configFile: path.join(configDir, "config.cfg") }
}

/** The file name an installed package gets: @areng14/arengitems -> areng14@arengitems.bee_pack */
export function packageFileName(fullName) {
    return `${fullName.replace(/^@/, "").replace("/", "@")}.bee_pack`
}

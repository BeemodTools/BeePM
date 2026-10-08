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
 *   config/config.json BEE2's folder and version, registry override
 *   config/installed.json
 *   config/credentials.json  CLI login (the desktop app keeps its own, encrypted)
 *   replaced/          packages moved out of BEE2's packages folder (a BeePM one replaced them)
 *   cache/
 * Installed packages are in BEE2's packages folder, in a "beepm" folder (BEE2 loads folders
 * inside its packages folder too): `bee2Dir` and `packages` come from config.json, see
 * useBee2Folder. Earlier 1.0 builds kept them in packages/ here and pointed BEE2 at it
 * (`hookedPackages`, see leaveHook).
 */
export function beepmPaths(env = process.env) {
    const root = env.BEEPM_HOME || path.join(appData(env), "beepm")
    const configDir = path.join(root, "config")
    return {
        root,
        bee2Dir: null,
        packages: null,
        hookedPackages: path.join(root, "packages"),
        replaced: path.join(root, "replaced"),
        cache: path.join(root, "cache"),
        configDir,
        config: path.join(configDir, "config.json"),
        installed: path.join(configDir, "installed.json"),
        credentials: path.join(configDir, "credentials.json"),
        // Files from earlier BeePM versions, adopted on first run
        legacyConfig: path.join(configDir, "beepm_config.json"),
        legacyInstalled: path.join(configDir, "installed_packages.json"),
        legacyAuth: path.join(configDir, "auth.json"),
    }
}

/** BEE2's packages folder, in BEE2's folder (the one with BEE2.exe). */
export const bee2PackagesDir = (bee2Dir) => path.join(bee2Dir, "packages")

/** Where BeePM installs packages: a folder of its own in BEE2's packages folder. */
export const beepmPackagesDir = (bee2Dir) => path.join(bee2Dir, "packages", "beepm")

/** Points `paths` at BEE2 in `bee2Dir` (null: BeePM doesn't know where BEE2 is yet). */
export function useBee2Folder(paths, bee2Dir) {
    paths.bee2Dir = bee2Dir ?? null
    paths.packages = bee2Dir ? beepmPackagesDir(bee2Dir) : null
    return paths
}

/** BEE2's config. BEE2_CONFIG_DIR overrides the folder that holds config.cfg (used by tests). */
export function bee2Paths(env = process.env) {
    const configDir = env.BEE2_CONFIG_DIR || path.join(appData(env), "BEEMOD2", "config")
    return { configDir, configFile: path.join(configDir, "config.cfg") }
}

/** The file name an installed package gets: @areng14/arengitems -> areng14@arengitems.bee_pack */
export function packageFileName(fullName) {
    const file = `${fullName.replace(/^@/, "").replace("/", "@")}.bee_pack`
    // Package names have one slash; anything else could reach outside the packages folder
    if (/[\\/]/.test(file)) throw new Error(`"${fullName}" isn't a package name.`)
    return file
}

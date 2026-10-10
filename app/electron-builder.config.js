/**
 * electron-builder's settings (npm run build passes --config). The app and installer icon is
 * build/icon.ico. Electron's version is read from the installed package: in this npm workspace
 * it's in the repo's root node_modules, where electron-builder doesn't look for it.
 * Not named electron-builder.js: Windows' cmd.exe runs a file in the folder it's in before a
 * program of the same name, so `electron-builder` in this folder opened that file (in whatever
 * .js files open with) instead of running electron-builder.
 */
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)

export default {
    appId: "com.beepm.app",
    productName: "BeePM",
    electronVersion: require("electron/package.json").version,
    files: ["dist/**/*", "backend/**/*", "node_modules/**/*", "package.json"],
    directories: {
        buildResources: "build",
        output: "release",
    },
    win: {
        target: [{ target: "nsis", arch: ["x64"] }],
    },
    // Where the installed app looks for updates (electron-updater): BeePM's GitHub releases. A
    // release needs the installer, its .blockmap and latest.yml from release/ (see README).
    publish: [{ provider: "github", owner: "BeemodTools", repo: "BeePM", releaseType: "release" }],
    nsis: {
        // No spaces: GitHub renames them in release files, and latest.yml has to match
        artifactName: "${productName}-Setup-${version}.${ext}",
        // Starts BeePM again in the tray after installing (when it runs in the background)
        include: "build/installer.nsh",
        oneClick: false,
        allowToChangeInstallationDirectory: true,
        perMachine: false,
        deleteAppDataOnUninstall: false,
    },
    linux: {
        target: [{ target: "AppImage", arch: ["x64"] }],
        category: "Development",
    },
}

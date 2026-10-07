/**
 * electron-builder's settings (npm run build). The app and installer icon is build/icon.ico.
 * Electron's version is read from the installed package: in this npm workspace it's in the
 * repo's root node_modules, where electron-builder doesn't look for it.
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
    nsis: {
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

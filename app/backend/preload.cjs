/**
 * The bridge between the window and the main process (window.beepm). Preloads run sandboxed,
 * so this is CommonJS and can only require "electron". Every call resolves to
 * { ok: true, ...data } or { ok: false, error, code?, problems? }.
 */
const { contextBridge, ipcRenderer } = require("electron")

const EVENTS = [
    "app:notice",
    "app:protocol",
    "auth:changed",
    "auth:login-result",
    "bee2:progress",
    "packages:changed",
    "packages:progress",
    "publish:progress",
]

const call =
    (channel) =>
    (...args) =>
        ipcRenderer.invoke(channel, ...args)

contextBridge.exposeInMainWorld("beepm", {
    app: {
        ready: call("app:ready"),
        info: call("app:info"),
        openExternal: call("app:open-external"),
        openPackagesFolder: call("app:open-packages-folder"),
        openLogsFolder: call("app:open-logs-folder"),
        settings: call("app:settings"),
        updateSettings: call("app:update-settings"),
    },
    auth: {
        status: call("auth:status"),
        login: call("auth:login"),
        link: call("auth:link"),
        cancel: call("auth:cancel"),
        unlink: call("auth:unlink"),
        logout: call("auth:logout"),
        updateProfile: call("auth:update-profile"),
    },
    registry: {
        search: call("registry:search"),
        package: call("registry:package"),
    },
    packages: {
        installed: call("packages:installed"),
        plan: call("packages:plan"),
        apply: call("packages:apply"),
        discardPlan: call("packages:discard-plan"),
        uninstall: call("packages:uninstall"),
        outdated: call("packages:outdated"),
        pickImport: call("packages:pick-import"),
        importScan: call("packages:import-scan"),
        importApply: call("packages:import-apply"),
        removeLocal: call("packages:remove-local"),
    },
    bee2: {
        status: call("bee2:status"),
        releases: call("bee2:releases"),
        setup: call("bee2:setup"),
        hook: call("bee2:hook"),
        unhook: call("bee2:unhook"),
    },
    publish: {
        pick: call("publish:pick"),
        prepare: call("publish:prepare"),
        upload: call("publish:upload"),
        discard: call("publish:discard"),
        prepareGithub: call("publish:prepare-github"),
        githubRepos: call("publish:github-repos"),
        githubReleases: call("publish:github-releases"),
        suggestManifest: call("publish:suggest-manifest"),
        writeManifest: call("publish:write-manifest"),
    },
    manage: {
        yank: call("manage:yank"),
        unyank: call("manage:unyank"),
        deprecate: call("manage:deprecate"),
        unpublish: call("manage:unpublish"),
        owners: call("manage:owners"),
        addOwner: call("manage:add-owner"),
        removeOwner: call("manage:remove-owner"),
        githubWatch: call("manage:github-watch"),
        stopGithubWatch: call("manage:stop-github-watch"),
    },
    admin: {
        removePackage: call("admin:remove-package"),
        restorePackage: call("admin:restore-package"),
    },

    /** The update question's window (src/components/UpdateToast.jsx) answering. */
    toast: {
        answer: call("toast:answer"),
    },

    /** Console output for the log file (src/lib/logForwarding.js). */
    log: (level, text) => ipcRenderer.send("app:log", level, text),

    /** Listens for an event from the main process; returns a function that stops listening. */
    on(event, callback) {
        if (!EVENTS.includes(event)) throw new Error(`Unknown event "${event}"`)
        const listener = (_event, payload) => callback(payload)
        ipcRenderer.on(event, listener)
        return () => ipcRenderer.removeListener(event, listener)
    },
})

const { contextBridge, ipcRenderer } = require("electron")

// Expose electron API
contextBridge.exposeInMainWorld("electron", {
    invoke: (channel, data) => ipcRenderer.invoke(channel, data),
    getAppVersion: () => ipcRenderer.invoke("get-app-version"),
})

// Expose BeePM API
contextBridge.exposeInMainWorld("beepm", {
    fetchRegistry: () => ipcRenderer.invoke("fetch-registry"),
    getInstalledPackages: () => ipcRenderer.invoke("get-installed-packages"),
    getConfig: () => ipcRenderer.invoke("get-config"),
    isInitialized: () => ipcRenderer.invoke("is-initialized"),
    runHook: () => ipcRenderer.invoke("run-hook"),
    runUnhook: () => ipcRenderer.invoke("run-unhook"),
    fetchBee2Versions: () => ipcRenderer.invoke("fetch-bee2-versions"),
    runReinit: (versionTag) => ipcRenderer.invoke("run-reinit", versionTag),
    installPackage: (packageSpec) => ipcRenderer.invoke("run-install", packageSpec),
    uninstallPackage: (packageSpec) => ipcRenderer.invoke("run-uninstall", packageSpec),
    // Publish-related
    checkAuth: () => ipcRenderer.invoke("check-auth"),
    runLogin: () => ipcRenderer.invoke("run-login"),
    showOpenDialog: (options) => ipcRenderer.invoke("show-open-dialog", options),
    validatePackage: (packagePath) => ipcRenderer.invoke("validate-package", packagePath),
    publishPackage: (packagePath) => ipcRenderer.invoke("run-publish", packagePath),
    fetchGithubPackage: (owner, repo) => ipcRenderer.invoke("fetch-github-package", owner, repo),
    publishGithubPackage: (packageData, githubRelease, contentHash) => ipcRenderer.invoke("publish-github-package", packageData, githubRelease, contentHash),
    // Admin functions
    checkAdmin: () => ipcRenderer.invoke("check-admin"),
    removePackage: (packageId, registryType) => ipcRenderer.invoke("remove-package", packageId, registryType),
    // Utility functions
    clearInstalledPackages: () => ipcRenderer.invoke("clear-installed-packages"),
})

// Expose general event API
contextBridge.exposeInMainWorld("api", {
    on: (channel, callback) => {
        const subscription = (event, ...args) => callback(event, ...args)
        ipcRenderer.on(channel, subscription)
        return subscription
    },
    off: (channel, callback) => {
        ipcRenderer.removeListener(channel, callback)
    },
})

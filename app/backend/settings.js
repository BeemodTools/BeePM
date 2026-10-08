import { readJson, writeJson } from "@beepm/core/client"

const DEFAULTS = {
    background: null,
    ignoredUpdates: [],
    keepOwn: [],
    ignoredBee2: [],
    trayHintShown: false,
    bee2Program: null,
}

/**
 * The desktop app's own settings, in config/app-settings.json:
 *   background      run in the background: start with Windows, stay in the tray when the
 *                   window closes, and look at BEE2's packages when it opens (null: default)
 *   ignoredUpdates  packages whose updates aren't offered ("Don't ask again")
 *   keepOwn         BEE2 IDs of the user's own packages that are on BeePM, where they keep
 *                   their copy ("Keep mine": BeePM's version isn't offered again)
 *   ignoredBee2     folders of other BEE2s not to offer switching to ("Don't ask again")
 *   trayHintShown   the "BeePM keeps running here" hint was shown once
 *   bee2Program     BEE2.exe, last seen running (to suggest BEE2's folder)
 */
export function createSettings(file) {
    let current = null
    async function load() {
        current ??= { ...DEFAULTS, ...(await readJson(file, {})) }
        return current
    }
    return {
        load,
        async update(changes) {
            const next = { ...(await load()), ...changes }
            await writeJson(file, next)
            current = next
            return next
        },
    }
}

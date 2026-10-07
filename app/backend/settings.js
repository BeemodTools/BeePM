import { readJson, writeJson } from "@beepm/core/client"

const DEFAULTS = { background: null, ignoredUpdates: [], trayHintShown: false }

/**
 * The desktop app's own settings, in config/app-settings.json:
 *   background      run in the background: start with Windows, stay in the tray when the
 *                   window closes, and offer updates when BEE2 opens (null: the default)
 *   ignoredUpdates  packages whose updates aren't offered ("Don't ask again")
 *   trayHintShown   the "BeePM keeps running here" hint was shown once
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

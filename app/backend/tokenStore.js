import { chmod, rm } from "node:fs/promises"
import { readJson, writeJson } from "@beepm/core/client"

/**
 * The desktop app's login, kept in config/credentials-app.json with the same load/save/clear
 * shape as core's createFileTokenStore: { registry, token, user, savedAt }.
 *
 * The token is encrypted with Electron's safeStorage (DPAPI on Windows, the Keychain on macOS,
 * the secret service on Linux) and stored as base64. If encryption isn't available it's stored
 * as plain text, like the CLI's credentials.json.
 */
export function createAppTokenStore(filePath, safeStorage) {
    const canEncrypt = () => {
        try {
            return Boolean(safeStorage?.isEncryptionAvailable())
        } catch {
            return false
        }
    }

    return {
        async load() {
            const data = await readJson(filePath, null)
            if (!data?.token) return null
            const { encrypted, ...login } = data
            if (!encrypted) return login
            try {
                return {
                    ...login,
                    token: safeStorage.decryptString(Buffer.from(data.token, "base64")),
                }
            } catch {
                // Encrypted by another Windows user or computer: treat it as logged out
                return null
            }
        },

        async save({ registry, token, user }) {
            const encrypted = canEncrypt()
            await writeJson(filePath, {
                registry,
                user,
                token: encrypted ? safeStorage.encryptString(token).toString("base64") : token,
                encrypted,
                savedAt: new Date().toISOString(),
            })
            await chmod(filePath, 0o600).catch(() => {})
        },

        clear: () => rm(filePath, { force: true }),
    }
}

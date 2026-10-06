import { buildApp } from "./app.js"
import { createProviders } from "./auth/providers.js"
import { loadConfig } from "./config.js"
import { createDb } from "./db/index.js"
import { migrate } from "./db/migrate.js"
import { applyBootstrapAdmins } from "./services/users.js"
import { createStorage } from "./storage/index.js"
import { startSweeper } from "./sweeper.js"

const config = loadConfig()
const db = await createDb(config)
const storage = createStorage(config)
const providers = createProviders(config.providers, fetch, {
    devLogin: config.devLogin,
    publicUrl: config.publicUrl,
})

const app = await buildApp({ config, db, storage, providers })
await migrate(db, (message) => app.log.info(message))
const promoted = await applyBootstrapAdmins(db, config.bootstrapAdmins)
if (promoted) app.log.info(`Made ${promoted} bootstrap admin(s)`)

if (!Object.keys(providers).length) {
    app.log.warn(
        "No login providers configured: set DISCORD_CLIENT_ID/SECRET and/or GITHUB_CLIENT_ID/SECRET",
    )
}
if (providers.dev) app.log.warn("Test-account login is on (local development only)")
if (storage.kind === "local") app.log.warn(`Using local file storage in ${config.storage.dir}`)
if (db.kind === "pglite") app.log.warn(`Using the local PGlite database in ${config.pgliteDir}`)

const stopSweeper = startSweeper({ db, storage, log: app.log })
await app.listen({ port: config.port, host: config.host })
app.log.info(`BeePM registry listening on ${config.publicUrl}`)

async function shutdown(signal) {
    app.log.info(`${signal}: shutting down`)
    stopSweeper()
    await app.close()
    await db.close()
    process.exit(0)
}
process.once("SIGTERM", () => shutdown("SIGTERM"))
process.once("SIGINT", () => shutdown("SIGINT"))

/**
 * Copies BeePM 1's packages into the database and storage configured by the environment
 * (the same variables the server uses). Safe to run again.
 *   node scripts/import-legacy.js [registry.json URL]
 * On a running server, admins can do the same with POST /v1/admin/import-legacy.
 */
import { loadConfig } from "../src/config.js"
import { createDb } from "../src/db/index.js"
import { migrate } from "../src/db/migrate.js"
import { importLegacy } from "../src/services/legacy.js"
import { createStorage } from "../src/storage/index.js"

const config = loadConfig()
const db = await createDb(config)
await migrate(db)
const storage = createStorage(config)

const result = await importLegacy(
    { db, config, storage, fetch: globalThis.fetch },
    { registryUrl: process.argv[2] || config.legacyRegistryUrl },
)
console.log(JSON.stringify(result, null, 2))
await db.close()

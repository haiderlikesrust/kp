// Stops or restarts spending on a running server. Needs DATABASE_URL (Postgres).
// Usage: npm run pause   /   npm run unpause
import { loadConfig } from '../server/config.ts'
import { openDb } from '../server/db/index.ts'

const paused = process.argv[2] !== 'off'
const config = loadConfig()
if (!config.databaseUrl) {
  console.error('pause needs DATABASE_URL: the local database can only be used by one process at a time.')
  process.exit(1)
}
const db = await openDb({ url: config.databaseUrl })
await db.query(
  `INSERT INTO settings (key, value) VALUES ('paused', $1) ON CONFLICT (key) DO UPDATE SET value = $1`,
  [paused ? '1' : '0'],
)
console.log(paused ? 'Paused. Purchases, payouts and new rounds have stopped.' : 'Unpaused.')
await db.close()

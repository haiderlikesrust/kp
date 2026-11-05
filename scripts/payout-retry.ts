// Puts stuck payouts back in the queue once the cause is fixed. Needs DATABASE_URL.
import { loadConfig } from '../server/config.ts'
import { openDb } from '../server/db/index.ts'

const config = loadConfig()
if (!config.databaseUrl) {
  console.error('payout:retry needs DATABASE_URL.')
  process.exit(1)
}
const db = await openDb({ url: config.databaseUrl })
const rows = await db.query(
  `UPDATE payouts SET state = 'queued', attempts = 0, signed_tx = NULL, signature = NULL, updated_at = now()
   WHERE state = 'stuck' RETURNING id, recipient, last_error`,
)
for (const row of rows) console.log(`payout ${row.id} to ${row.recipient} requeued (was: ${row.last_error})`)
console.log(`${rows.length} payouts requeued.`)
await db.close()

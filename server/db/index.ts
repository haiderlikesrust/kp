import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import pg from 'pg'

export type Row = Record<string, any>

export interface Queryable {
  query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<T[]>
}

export interface Db extends Queryable {
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>
  /** Returns false when another process already holds the lock. */
  tryProcessLock(): Promise<boolean>
  /** False once the connection holding the lock has gone. */
  lockHealthy(): Promise<boolean>
  close(): Promise<void>
}

type RawDb = Db & { exec(sql: string): Promise<void> }

const LOCK_KEY = 7_402_113

const schemaPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'schema.sql')

export async function openDb(opts: { url?: string; pgliteDir?: string } = {}): Promise<Db> {
  const db = opts.url ? await openPostgres(opts.url) : await openPglite(opts.pgliteDir)
  await db.exec(readFileSync(schemaPath, 'utf8'))
  return db
}

async function openPostgres(url: string): Promise<RawDb> {
  // pg returns BIGINT as a string; slots fit safely in a JS number.
  pg.types.setTypeParser(20, (value) => Number(value))
  const pool = new pg.Pool({ connectionString: url, max: 10 })
  // The lock belongs to this one connection for as long as it stays open.
  let lockClient: pg.PoolClient | null = null
  let lockLost = false
  // An idle connection dropping is normal and must not crash the server.
  pool.on('error', () => {})
  return {
    async query<T extends Row>(sql: string, params: unknown[] = []) {
      return (await pool.query(sql, params as any[])).rows as T[]
    },
    async tx(fn) {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const result = await fn({
          query: async <T extends Row>(sql: string, params: unknown[] = []) =>
            (await client.query(sql, params as any[])).rows as T[],
        })
        await client.query('COMMIT')
        return result
      } catch (err) {
        await client.query('ROLLBACK')
        throw err
      } finally {
        client.release()
      }
    },
    async tryProcessLock() {
      if (!lockClient) {
        const client = await pool.connect()
        client.on('error', () => {
          lockLost = true
        })
        lockClient = client
      }
      const result = await lockClient.query('SELECT pg_try_advisory_lock($1) AS locked', [LOCK_KEY])
      return result.rows[0]?.locked === true
    },
    async lockHealthy() {
      if (lockLost || !lockClient) return false
      try {
        await lockClient.query('SELECT 1')
        return true
      } catch {
        return false
      }
    },
    async exec(sql) {
      await pool.query(sql)
    },
    async close() {
      // Destroying the connection is what releases the lock.
      lockClient?.release(true)
      lockClient = null
      await pool.end()
    },
  }
}

async function openPglite(dir?: string): Promise<RawDb> {
  const { PGlite } = await import('@electric-sql/pglite')
  const lite = dir ? new PGlite(dir) : new PGlite()
  await lite.waitReady
  const normalise = <T extends Row>(rows: T[]): T[] => {
    for (const row of rows) {
      for (const key of Object.keys(row)) {
        if (typeof row[key] === 'bigint') (row as Row)[key] = Number(row[key])
      }
    }
    return rows
  }
  return {
    async query<T extends Row>(sql: string, params: unknown[] = []) {
      return normalise((await lite.query<T>(sql, params as any[])).rows)
    },
    async tx(fn) {
      return (await lite.transaction(async (t) =>
        fn({
          query: async <T extends Row>(sql: string, params: unknown[] = []) =>
            normalise((await t.query<T>(sql, params as any[])).rows),
        }),
      )) as any
    },
    async tryProcessLock() {
      // PGlite already holds its data directory exclusively.
      return true
    },
    async lockHealthy() {
      return true
    },
    async exec(sql) {
      await lite.exec(sql)
    },
    async close() {
      await lite.close()
    },
  }
}

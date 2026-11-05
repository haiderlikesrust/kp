import type { Db } from './db/index.ts'
import type { Log } from './log.ts'

export type Role = 'standby' | 'active' | 'draining'

export interface CoordinatorOptions {
  db: Pick<Db, 'tryProcessLock' | 'lockHealthy'>
  log: Log
  /** How often a standby retries the lock. */
  pollMs?: number
  /** How often the active server checks it still holds the lock. */
  checkMs?: number
  /** Called once this server owns the database. */
  onActive(): void
  /** Called if the lock is lost. Two active servers would risk double spending. */
  onLockLost(): void
}

/**
 * Only one server may run the game and spend money. During an update the new
 * server starts first and waits here as a healthy standby until the old one
 * stops and releases the Postgres lock, so the site never goes down.
 */
export class Coordinator {
  role: Role = 'standby'
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private opts: CoordinatorOptions) {}

  start(): void {
    void this.waitForLock()
  }

  private async waitForLock(): Promise<void> {
    const { db, log, pollMs = 250 } = this.opts
    let announced = false
    while (this.role === 'standby') {
      const locked = await db.tryProcessLock().catch((err) => {
        log.warn('lock attempt failed', err instanceof Error ? err.message : err)
        return false
      })
      if (locked) break
      if (!announced) {
        announced = true
        log.info('standby: waiting for the running server to hand over')
      }
      await new Promise<void>((resolve) => {
        this.timer = setTimeout(resolve, pollMs)
      })
    }
    if (this.role !== 'standby') return
    this.role = 'active'
    log.info('active: this server owns the database')
    this.opts.onActive()
    this.watchLock()
  }

  /** The lock lives on one connection, so losing it means someone else can take over. */
  private watchLock(): void {
    const { db, log, checkMs = 2_000 } = this.opts
    this.timer = setTimeout(() => {
      if (this.role !== 'active') return
      db.lockHealthy()
        .then((healthy) => {
          if (this.role !== 'active') return
          if (healthy) return this.watchLock()
          log.alert('lost the database lock, stopping this server')
          this.opts.onLockLost()
        })
        .catch(() => this.watchLock())
    }, checkMs)
  }

  /** Stops trying to own or keep the database. */
  drain(): void {
    this.role = 'draining'
    if (this.timer) clearTimeout(this.timer)
  }
}

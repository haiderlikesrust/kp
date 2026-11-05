import { describe, expect, it } from 'vitest'
import { Coordinator } from '../server/coordinator.ts'
import { silentLog } from '../server/log.ts'

function fakeLock(free: boolean) {
  const lock = {
    free,
    healthy: true,
    tryProcessLock: async () => {
      if (!lock.free) return false
      lock.free = false
      return true
    },
    lockHealthy: async () => lock.healthy,
  }
  return lock
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function coordinator(db: ReturnType<typeof fakeLock>) {
  const calls = { active: 0, lost: 0 }
  const instance = new Coordinator({
    db,
    log: silentLog,
    pollMs: 5,
    checkMs: 5,
    onActive: () => {
      calls.active += 1
    },
    onLockLost: () => {
      calls.lost += 1
    },
  })
  return { instance, calls }
}

describe('coordinator', () => {
  it('goes active straight away when nobody holds the lock', async () => {
    const { instance, calls } = coordinator(fakeLock(true))
    instance.start()
    await wait(15)
    expect(instance.role).toBe('active')
    expect(calls.active).toBe(1)
    instance.drain()
  })

  it('waits as a standby, doing no work, until the lock is released', async () => {
    const lock = fakeLock(false)
    const { instance, calls } = coordinator(lock)
    instance.start()
    await wait(30)
    expect(instance.role).toBe('standby')
    expect(calls.active).toBe(0)

    lock.free = true
    await wait(30)
    expect(instance.role).toBe('active')
    expect(calls.active).toBe(1)
    instance.drain()
  })

  it('never lets two servers go active on one lock', async () => {
    const lock = fakeLock(true)
    const first = coordinator(lock)
    const second = coordinator(lock)
    first.instance.start()
    second.instance.start()
    await wait(30)
    expect([first.instance.role, second.instance.role].sort()).toEqual(['active', 'standby'])
    first.instance.drain()
    second.instance.drain()
  })

  it('stops if the lock is lost, so two servers can never both spend', async () => {
    const lock = fakeLock(true)
    const { instance, calls } = coordinator(lock)
    instance.start()
    await wait(15)
    lock.healthy = false
    await wait(30)
    expect(calls.lost).toBe(1)
    instance.drain()
  })

  it('stops waiting once it is told to drain', async () => {
    const lock = fakeLock(false)
    const { instance, calls } = coordinator(lock)
    instance.start()
    await wait(10)
    instance.drain()
    lock.free = true
    await wait(30)
    expect(instance.role).toBe('draining')
    expect(calls.active).toBe(0)
  })

  it('keeps trying if a lock attempt errors', async () => {
    const lock = fakeLock(true)
    const real = lock.tryProcessLock
    let failures = 2
    lock.tryProcessLock = async () => {
      if (failures-- > 0) throw new Error('connection refused')
      return real()
    }
    const { instance } = coordinator(lock)
    instance.start()
    await wait(40)
    expect(instance.role).toBe('active')
    instance.drain()
  })
})

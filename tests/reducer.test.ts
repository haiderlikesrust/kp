import { describe, expect, it } from 'vitest'
import { reduceRound, rankBurners, type RipEvent } from '../server/engine/reducer.ts'
import { RULES, minPacksForDrop } from '../shared/rules.ts'

let seq = 0
function rip(wallet: string, slot: number, blockIndex = 0): RipEvent {
  seq += 1
  return { signature: `sig${seq}`, wallet, slot, blockIndex, kind: 'burn' }
}

const FIRST = 1000
const D0 = FIRST + RULES.startSlots

describe('timer', () => {
  it('stays open until the first rip', () => {
    const result = reduceRound({ packsTotal: 25, events: [], currentSlot: 5000 })
    expect(result.status).toBe('open')
    expect(result.deadlineSlot).toBeNull()
    expect(result.nextDropSlot).toBeNull()
  })

  it('starts at about 30s and a lone rip adds about 5s', () => {
    const result = reduceRound({
      packsTotal: 25,
      events: [rip('a', FIRST), rip('b', FIRST + 40), rip('c', FIRST + 80)],
      currentSlot: FIRST + 81,
    })
    expect(result.status).toBe('live')
    expect(result.firstSlot).toBe(FIRST)
    expect(result.deadlineSlot).toBe(D0 + 2 * 13)
    expect(result.lastRipper).toBe('c')
  })

  it('counts a burn in the deadline slot and rejects one a slot later', () => {
    const onTime = reduceRound({
      packsTotal: 25,
      events: [rip('a', FIRST), rip('b', D0)],
      currentSlot: D0 + 1,
    })
    expect(onTime.counted).toHaveLength(2)
    expect(onTime.status).toBe('live')

    const lateRip = rip('b', D0 + 1)
    const tooLate = reduceRound({
      packsTotal: 25,
      events: [rip('a', FIRST), lateRip],
      currentSlot: D0 + 2,
    })
    expect(tooLate.status).toBe('cutoff')
    expect(tooLate.endReason).toBe('timer')
    expect(tooLate.lastRipper).toBe('a')
    expect(tooLate.late).toEqual([lateRip])
  })

  it('is still live during the deadline slot itself', () => {
    const result = reduceRound({ packsTotal: 25, events: [rip('a', FIRST)], currentSlot: D0 })
    expect(result.status).toBe('live')
    expect(reduceRound({ packsTotal: 25, events: [rip('a', FIRST)], currentSlot: D0 + 1 }).status).toBe('cutoff')
  })

  it('reopens if a missed burn turns up after the round looked over', () => {
    const first = rip('a', FIRST)
    const closed = reduceRound({ packsTotal: 25, events: [first], currentSlot: D0 + 10 })
    expect(closed.status).toBe('cutoff')
    const found = reduceRound({ packsTotal: 25, events: [first, rip('b', D0 - 1)], currentSlot: D0 + 10 })
    expect(found.status).toBe('live')
    expect(found.lastRipper).toBe('b')
  })
})

describe('heat', () => {
  /** Rips one slot apart, so all of them share the heat window. */
  const burst = (count: number) => Array.from({ length: count }, (_, i) => rip(`w${i}`, FIRST + i))

  it('adds +5s, then +3s, then +1s, then nothing as ripping speeds up', () => {
    const events = burst(12)
    const result = reduceRound({ packsTotal: 100, events, currentSlot: FIRST + 12 })
    const added = events.slice(1).map((event) => result.added.get(event.signature))
    expect(added).toEqual([13, 8, 8, 8, 3, 3, 3, 3, 0, 0, 0])
    expect(result.deadlineSlot).toBe(D0 + 13 + 8 * 3 + 3 * 4)
  })

  it('cools down once the window empties', () => {
    const events = [...burst(10), rip('late', FIRST + 40)]
    const result = reduceRound({ packsTotal: 100, events, currentSlot: FIRST + 41 })
    expect(result.added.get(events.at(-1)!.signature)).toBe(13)
  })

  it('treats a rip exactly at the edge of the window as gone', () => {
    const first = rip('a', FIRST)
    const edge = rip('b', FIRST + RULES.heatWindowSlots)
    const inside = rip('c', FIRST + RULES.heatWindowSlots + 1)
    const result = reduceRound({ packsTotal: 100, events: [first, edge, inside], currentSlot: FIRST + 30 })
    expect(result.added.get(edge.signature)).toBe(13) // only itself in the window
    expect(result.added.get(inside.signature)).toBe(13) // itself and the one before
  })

  it('stops adding time at peak heat', () => {
    const events = burst(30)
    const result = reduceRound({ packsTotal: 100, events, currentSlot: FIRST + 30 })
    expect(result.deadlineSlot).toBe(D0 + 13 + 8 * 3 + 3 * 4)
    expect(result.heat.nextAddSlots).toBe(0)
  })

  it('reports what the next rip would add', () => {
    const quiet = reduceRound({ packsTotal: 100, events: [], currentSlot: FIRST })
    expect(quiet.heat).toEqual({ recentRips: 0, nextAddSlots: 13 })
    const warm = reduceRound({ packsTotal: 100, events: burst(5), currentSlot: FIRST + 5 })
    expect(warm.heat).toEqual({ recentRips: 5, nextAddSlots: 3 })
    const cooled = reduceRound({ packsTotal: 100, events: burst(5), currentSlot: FIRST + 40 })
    expect(cooled.heat.recentRips).toBe(0)
  })

  it('is decided by chain order alone, so replays agree', () => {
    const events = burst(15)
    const a = reduceRound({ packsTotal: 100, events, currentSlot: FIRST + 20 })
    const b = reduceRound({ packsTotal: 100, events: [...events].reverse(), currentSlot: FIRST + 20 })
    expect(b.deadlineSlot).toBe(a.deadlineSlot)
    expect(b.added).toEqual(a.added)
  })
})

describe('chain order', () => {
  it('breaks same-slot ties by block position', () => {
    const result = reduceRound({
      packsTotal: 25,
      events: [rip('a', FIRST), rip('later', FIRST + 10, 9), rip('earlier', FIRST + 10, 2)],
      currentSlot: FIRST + 11,
    })
    expect(result.lastRipper).toBe('later')
  })

  it('gives the same result whatever order burns are discovered in', () => {
    const events = [
      rip('a', FIRST),
      rip('b', FIRST + 40),
      rip('c', FIRST + 40, 1),
      rip('a', FIRST + 90),
      rip('d', FIRST + 300),
    ]
    const baseline = reduceRound({ packsTotal: 25, events, currentSlot: FIRST + 500 })
    const shuffled = [events[3]!, events[0]!, events[4]!, events[2]!, events[1]!]
    expect(reduceRound({ packsTotal: 25, events: shuffled, currentSlot: FIRST + 500 })).toEqual(baseline)
  })

  it('does not let a posted but unlanded burn exist at all', () => {
    // Only landed burns are events, so a signature held back has no effect.
    const result = reduceRound({ packsTotal: 25, events: [rip('a', FIRST)], currentSlot: D0 + 1 })
    expect(result.status).toBe('cutoff')
    expect(result.lastRipper).toBe('a')
  })
})

describe('sold out', () => {
  it('ends at the last pack and the final ripper wins', () => {
    const events = [rip('a', FIRST), rip('b', FIRST + 1), rip('c', FIRST + 2)]
    const result = reduceRound({ packsTotal: 3, events, currentSlot: FIRST + 3 })
    expect(result.status).toBe('cutoff')
    expect(result.endReason).toBe('sold_out')
    expect(result.lastRipper).toBe('c')
    expect(result.nextDropSlot).toBeNull()
  })

  it('turns burns after the last pack into late burns, even before the deadline', () => {
    const extra = rip('d', FIRST + 2, 5)
    const result = reduceRound({
      packsTotal: 2,
      events: [rip('a', FIRST), rip('b', FIRST + 2), extra],
      currentSlot: FIRST + 3,
    })
    expect(result.counted).toHaveLength(2)
    expect(result.late).toEqual([extra])
  })
})

describe('5-minute drop', () => {
  /** 13 slots apart holds the clock level: each rip adds what the gap used. */
  const STEADY = 13

  /** Rips at a steady pace long enough to reach the first drop. */
  function pacedRips(count: number, gap: number, walletFor: (i: number) => string): RipEvent[] {
    return Array.from({ length: count }, (_, i) => rip(walletFor(i), FIRST + i * gap))
  }

  it('fires at 750 slots after the first rip, while the round is alive', () => {
    const events = pacedRips(58, STEADY, (i) => `w${i % 8}`)
    const dropSlot = FIRST + RULES.dropSlots
    const before = reduceRound({ packsTotal: 100, events, currentSlot: dropSlot })
    expect(before.drops).toHaveLength(0)
    const after = reduceRound({ packsTotal: 100, events, currentSlot: dropSlot + 1 })
    expect(after.drops).toHaveLength(1)
    expect(after.drops[0]!.slot).toBe(dropSlot)
    expect(after.nextDropSlot).toBe(FIRST + 2 * RULES.dropSlots)
  })

  /** k rips, each landing in the last possible slot: the longest a round can run. */
  function slowestRound(k: number): { events: RipEvent[]; deadline: number } {
    const events = [rip('a', FIRST)]
    let deadline = FIRST + RULES.startSlots
    for (let i = 1; i < k; i++) {
      events.push(rip(`w${i}`, deadline))
      deadline += 13
    }
    return { events, deadline }
  }

  it('never fires in a 25-pack round', () => {
    const { events, deadline } = slowestRound(25)
    const result = reduceRound({ packsTotal: 26, events, currentSlot: deadline + 10_000 })
    expect(result.drops).toHaveLength(0)
    expect(result.status).toBe('cutoff')
  })

  it('needs 53 rips: a 52-pack round runs out just before the drop', () => {
    expect(minPacksForDrop()).toBe(53)
    const at52 = slowestRound(52)
    expect(at52.deadline).toBeLessThan(FIRST + RULES.dropSlots)
    expect(reduceRound({ packsTotal: 100, events: at52.events, currentSlot: at52.deadline + 10_000 }).drops).toHaveLength(0)
    const at53 = slowestRound(53)
    expect(reduceRound({ packsTotal: 100, events: at53.events, currentSlot: at53.deadline + 10_000 }).drops).toHaveLength(1)
  })

  it('loses to the winner when the drop lands exactly on the deadline', () => {
    // One rip gives deadline FIRST+75. Shrink the drop timer to land on it.
    const rules = { ...RULES, dropSlots: RULES.startSlots }
    const result = reduceRound({ packsTotal: 25, events: [rip('a', FIRST)], currentSlot: D0 + 5, rules })
    expect(result.drops).toHaveLength(0)
    expect(result.endReason).toBe('timer')
  })

  it('ranks only the window, top 5, most rips first', () => {
    const walletFor = (i: number) =>
      i < 24 ? 'big' : i < 40 ? 'mid' : i < 50 ? 'low' : i < 54 ? 'tiny' : i < 56 ? 'one' : 'two'
    const events = pacedRips(57, STEADY, walletFor)
    const result = reduceRound({ packsTotal: 100, events, currentSlot: FIRST + RULES.dropSlots + 1 })
    expect(result.drops[0]!.ranked).toEqual(['big', 'mid', 'low', 'tiny', 'one'])
  })

  it('resets the window after each drop', () => {
    const early = pacedRips(58, STEADY, () => 'early')
    const late = Array.from({ length: 58 }, (_, i) => rip(i % 2 ? 'late1' : 'late2', FIRST + 754 + i * STEADY))
    const result = reduceRound({
      packsTotal: 200,
      events: [...early, ...late],
      currentSlot: FIRST + 2 * RULES.dropSlots + 1,
    })
    expect(result.drops).toHaveLength(2)
    expect(result.drops[0]!.ranked).toEqual(['early'])
    expect(result.drops[1]!.ranked).toEqual(['late2', 'late1'])
  })

  it('takes earlier picks out of the next pool', () => {
    const events = pacedRips(116, STEADY, (i) => `w${i % 6}`)
    const firstPass = reduceRound({ packsTotal: 200, events, currentSlot: FIRST + 760 })
    const picks = firstPass.drops[0]!.pool.slice(0, 5)
    const result = reduceRound({
      packsTotal: 200,
      events,
      currentSlot: FIRST + 1501,
      dropPicks: new Map([[0, picks]]),
    })
    expect(result.drops).toHaveLength(2)
    for (const pick of picks) expect(result.drops[1]!.pool).not.toContain(pick)
  })

  it('includes a rip that lands in the drop slot itself', () => {
    const events = [...pacedRips(58, STEADY, () => 'a'), rip('last-second', FIRST + RULES.dropSlots)]
    const result = reduceRound({ packsTotal: 100, events, currentSlot: FIRST + RULES.dropSlots + 1 })
    expect(result.drops[0]!.ranked).toContain('last-second')
  })
})

describe('rankBurners', () => {
  it('breaks ties by who reached the count first', () => {
    const rips = [rip('a', 1), rip('b', 2), rip('b', 3), rip('a', 4)]
    expect(rankBurners(rips).map((entry) => entry.wallet)).toEqual(['b', 'a'])
  })

  it('counts each wallet once per rip', () => {
    expect(rankBurners([rip('a', 1), rip('a', 2)])).toEqual([{ wallet: 'a', rips: 2 }])
  })
})

import { RULES, extendSlotsFor, type HeatTier } from '../../shared/rules.ts'

/**
 * The whole game, as a pure function of on-chain events. It takes no clock
 * except the slot it is asked about, so replaying the same burns always gives
 * the same winner, drops and vouchers. Everything else in the server exists to
 * feed this function and carry out what it says.
 */

export interface RipEvent {
  signature: string
  wallet: string
  slot: number
  /** Position inside the block. Decides same-slot ties. */
  blockIndex: number
  kind: 'burn' | 'voucher'
}

export interface FiredDrop {
  index: number
  slot: number
  /** Wallets best first, at most `dropSize`. */
  ranked: string[]
  /** Rip signatures still in the pot at the drop slot, in chain order. */
  pool: string[]
}

export interface Ranked {
  wallet: string
  rips: number
}

export interface RoundResult {
  status: 'open' | 'live' | 'cutoff'
  firstSlot: number | null
  deadlineSlot: number | null
  counted: RipEvent[]
  /** Landed after the round ended, or after the last pack went. */
  late: RipEvent[]
  lastRipper: string | null
  endReason: 'timer' | 'sold_out' | null
  drops: FiredDrop[]
  nextDropSlot: number | null
  /** Live ranking of the current drop window. */
  windowRanking: Ranked[]
  /** Counted rips in the current drop window. */
  windowRips: RipEvent[]
  /** Slots each counted rip added to the clock, by signature. */
  added: Map<string, number>
  /** Rips in the heat window right now, and what the next rip would add. */
  heat: { recentRips: number; nextAddSlots: number }
}

export interface RoundInput {
  packsTotal: number
  events: readonly RipEvent[]
  currentSlot: number
  /** Picks of drops that have already been resolved, by drop index. */
  dropPicks?: ReadonlyMap<number, readonly string[]>
  rules?: {
    startSlots: number
    heatWindowSlots: number
    heatTiers: readonly HeatTier[]
    dropSlots: number
    dropSize: number
  }
}

export function compareEvents(a: RipEvent, b: RipEvent): number {
  return a.slot - b.slot || a.blockIndex - b.blockIndex || a.signature.localeCompare(b.signature)
}

/**
 * Ranks wallets by rips, most first. Ties go to whoever reached that count
 * first, measured by the position of their final rip in the window.
 */
export function rankBurners(rips: readonly RipEvent[]): Ranked[] {
  const tally = new Map<string, { rips: number; reachedAt: number }>()
  rips.forEach((rip, position) => {
    const entry = tally.get(rip.wallet) ?? { rips: 0, reachedAt: 0 }
    entry.rips += 1
    entry.reachedAt = position
    tally.set(rip.wallet, entry)
  })
  return [...tally.entries()]
    .sort(([, a], [, b]) => b.rips - a.rips || a.reachedAt - b.reachedAt)
    .map(([wallet, entry]) => ({ wallet, rips: entry.rips }))
}

export function reduceRound(input: RoundInput): RoundResult {
  const rules = input.rules ?? RULES
  const dropPicks = input.dropPicks ?? new Map<number, readonly string[]>()
  const events = [...input.events].sort(compareEvents)

  const counted: RipEvent[] = []
  const late: RipEvent[] = []
  const drops: FiredDrop[] = []
  let status: RoundResult['status'] = 'open'
  let firstSlot: number | null = null
  let deadlineSlot: number | null = null
  let endReason: RoundResult['endReason'] = null
  let windowStartIndex = 0
  const swept = new Set<string>()
  const added = new Map<string, number>()

  /** Counted rips still inside the heat window as of a slot. */
  const recentAt = (slot: number): number => {
    let count = 0
    for (let i = counted.length - 1; i >= 0; i--) {
      if ((counted[i] as RipEvent).slot <= slot - rules.heatWindowSlots) break
      count += 1
    }
    return count
  }

  const nextDrop = (): number | null =>
    firstSlot === null ? null : firstSlot + rules.dropSlots * (drops.length + 1)

  const fireDrop = (slot: number): void => {
    const index = drops.length
    const window = counted.slice(windowStartIndex)
    const ranked = rankBurners(window)
      .slice(0, rules.dropSize)
      .map((entry) => entry.wallet)
    drops.push({
      index,
      slot,
      ranked,
      pool: counted.filter((rip) => !swept.has(rip.signature)).map((rip) => rip.signature),
    })
    for (const signature of dropPicks.get(index) ?? []) swept.add(signature)
    windowStartIndex = counted.length
  }

  /** Move time forward so that every slot before `slot` has fully passed. */
  const advanceTo = (slot: number): void => {
    if (status !== 'live' || deadlineSlot === null) return
    // A drop needs the round still running after its slot, so one landing
    // exactly on the deadline loses to the winner.
    for (let drop = nextDrop(); drop !== null && drop < slot && drop < deadlineSlot; drop = nextDrop()) {
      fireDrop(drop)
    }
    if (deadlineSlot < slot) {
      status = 'cutoff'
      endReason = 'timer'
    }
  }

  for (const event of events) {
    advanceTo(event.slot)
    if (status === 'cutoff') {
      late.push(event)
      continue
    }
    counted.push(event)
    if (status === 'open') {
      status = 'live'
      firstSlot = event.slot
      deadlineSlot = event.slot + rules.startSlots
      added.set(event.signature, rules.startSlots)
    } else {
      const extra = extendSlotsFor(recentAt(event.slot), rules.heatTiers)
      deadlineSlot = (deadlineSlot as number) + extra
      added.set(event.signature, extra)
    }
    if (counted.length >= input.packsTotal) {
      status = 'cutoff'
      endReason = 'sold_out'
    }
  }
  advanceTo(input.currentSlot)

  const recentRips = recentAt(input.currentSlot)
  const windowRips = counted.slice(windowStartIndex)

  return {
    status,
    firstSlot,
    deadlineSlot,
    counted,
    late,
    lastRipper: counted.at(-1)?.wallet ?? null,
    endReason,
    drops,
    nextDropSlot: status === 'live' ? nextDrop() : null,
    windowRanking: rankBurners(windowRips).slice(0, rules.dropSize),
    windowRips,
    added,
    heat: { recentRips, nextAddSlots: extendSlotsFor(recentRips + 1, rules.heatTiers) },
  }
}

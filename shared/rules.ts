/** Game constants. Timers are Solana slots because chain order is the rule. */
export const RULES = {
  /** Coins burned per rip, in whole tokens. Change between rounds, never during one. */
  burnTokens: 100_000,
  startSlots: 75, // about 30s
  /** How far back "how busy is it" looks, about 10 seconds. */
  heatWindowSlots: 25,
  /**
   * Time each rip adds, by rips in the heat window including this one. The more
   * people ripping, the less each rip buys. Each round saves its own copy.
   */
  heatTiers: [
    { fromRips: 1, slots: 25 }, // about +10s
    { fromRips: 3, slots: 13 }, // about +5s
    { fromRips: 6, slots: 8 }, // about +3s
    { fromRips: 10, slots: 3 }, // about +1s
  ],
  dropSlots: 750, // about 5 minutes
  dropSize: 5,
  /** Blocks to wait past a drop slot before its blockhash may seed the pick. */
  dropSeedDelaySlots: 32,
  /** Slots between one round settling and the next opening. Zero: straight into the next one. */
  roundGapSlots: 0,
  /** How long client hints may still add a missed burn before payout starts. */
  resolveHintMs: 60_000,
  /** Estimated SOL needed per card delivered. Measure on the first payout. */
  solPerCard: 0.006,
  /** SOL kept untouched for claims, swaps and pack purchases. */
  solFloor: 0.05,
} as const

/** Nominal Solana slot time, used only to draw seconds on screen. */
export const SLOT_MS = 400

export type HeatTier = { fromRips: number; slots: number }

/** The timer rounds ran on before each one saved its own. */
const LEGACY_HEAT_TIERS: readonly HeatTier[] = [
  { fromRips: 1, slots: 13 },
  { fromRips: 3, slots: 8 },
  { fromRips: 6, slots: 3 },
  { fromRips: 10, slots: 0 },
]

/** A round keeps the timer it opened with, so a rule change can't move a running clock. */
export function rulesForRound(savedTiers: string | null | undefined) {
  return { ...RULES, heatTiers: savedTiers ? (JSON.parse(savedTiers) as HeatTier[]) : LEGACY_HEAT_TIERS }
}

export const USDC_DECIMALS = 6

export function extendSlotsFor(recentRips: number, tiers: readonly HeatTier[] = RULES.heatTiers): number {
  let slots = tiers[0]?.slots ?? 0
  for (const tier of tiers) {
    if (recentRips >= tier.fromRips) slots = tier.slots
  }
  return slots
}

export const slotsToSeconds = (slots: number): number => Math.round((slots * SLOT_MS) / 1000)

/**
 * Smallest round that can reach a drop: every rip adds the most it can, and the
 * clock must still be running after the drop slot.
 */
export function minPacksForDrop(): number {
  const top = RULES.heatTiers[0].slots
  return Math.floor((RULES.dropSlots - RULES.startSlots) / top) + 2
}

export const MEMO_PREFIX = 'keepripping:v1'

export function burnMemo(roundId: number): string {
  return `${MEMO_PREFIX}:${roundId}`
}

export function voucherMemo(roundId: number, originSig: string): string {
  return `${MEMO_PREFIX}:${roundId}:voucher:${originSig}`
}

export type ParsedMemo =
  | { kind: 'burn'; roundId: number }
  | { kind: 'voucher'; roundId: number; originSig: string }

export function parseMemo(memo: string): ParsedMemo | null {
  const parts = memo.split(':')
  if (parts[0] !== 'keepripping' || parts[1] !== 'v1') return null
  const roundId = Number(parts[2])
  if (!Number.isSafeInteger(roundId) || roundId <= 0 || String(roundId) !== parts[2]) return null
  if (parts.length === 3) return { kind: 'burn', roundId }
  if (parts.length === 5 && parts[3] === 'voucher' && parts[4]) {
    return { kind: 'voucher', roundId, originSig: parts[4] }
  }
  return null
}

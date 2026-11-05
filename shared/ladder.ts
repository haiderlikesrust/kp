/**
 * Treasury pack ladder. The lineup for a round comes straight from this table,
 * so spending can never scale past what is written here. $500 is the ceiling.
 */
export type PackPrice = 25 | 50 | 100 | 250 | 500

export const PACK_TIERS: readonly { price: PackPrice; machine: string; label: string }[] = [
  { price: 25, machine: 'pokemon_25', label: 'Starter' },
  { price: 50, machine: 'pokemon_50', label: 'Elite' },
  { price: 100, machine: 'pokemon_100', label: 'Bronze' },
  { price: 250, machine: 'pokemon_250', label: 'Legendary' },
  { price: 500, machine: 'pokemon_500', label: 'Hyper' },
]

export interface LadderStep {
  minTreasury: number
  packs: Partial<Record<PackPrice, number>>
}

export const LADDER: readonly LadderStep[] = [
  { minTreasury: 100, packs: { 25: 3 } },
  { minTreasury: 250, packs: { 25: 9 } },
  { minTreasury: 650, packs: { 25: 25 } },
  { minTreasury: 1_000, packs: { 25: 18, 50: 6, 100: 2 } },
  { minTreasury: 2_500, packs: { 25: 30, 50: 14, 100: 8 } },
  { minTreasury: 5_000, packs: { 25: 48, 50: 20, 100: 12, 250: 2, 500: 1 } },
  { minTreasury: 10_000, packs: { 25: 60, 50: 30, 100: 15, 250: 6, 500: 3 } },
]

export const MIN_TREASURY = LADDER[0]!.minTreasury

export function machineFor(price: number): string {
  const tier = PACK_TIERS.find((t) => t.price === price)
  if (!tier) throw new Error(`no machine for pack price ${price}`)
  return tier.machine
}

export function tierLabel(price: number): string {
  return PACK_TIERS.find((t) => t.price === price)?.label ?? `$${price}`
}

/** Highest step the available treasury reaches, or null if it can't fund a round. */
export function pickStep(availableUsd: number, ladder: readonly LadderStep[] = LADDER): LadderStep | null {
  let chosen: LadderStep | null = null
  for (const step of ladder) {
    if (availableUsd >= step.minTreasury) chosen = step
  }
  return chosen
}

export function stepCost(step: LadderStep): number {
  return Object.entries(step.packs).reduce((sum, [price, count]) => sum + Number(price) * (count ?? 0), 0)
}

export function stepPackCount(step: LadderStep): number {
  return Object.values(step.packs).reduce((sum, count) => sum + (count ?? 0), 0)
}

/** Flat list of pack prices in the step, cheapest first, before shuffling. */
export function expandStep(step: LadderStep): number[] {
  const prices: number[] = []
  for (const tier of PACK_TIERS) {
    const count = step.packs[tier.price] ?? 0
    for (let i = 0; i < count; i++) prices.push(tier.price)
  }
  return prices
}

/**
 * Swap prices for machines that can't supply them. Each slot falls to the next
 * cheaper tier with stock, so a shortage can only ever reduce spend.
 */
export function fitToStock(prices: readonly number[], stock: ReadonlyMap<number, number>): number[] {
  const left = new Map(stock)
  const tiers = PACK_TIERS.map((t) => t.price as number).sort((a, b) => b - a)
  const out: number[] = []
  // Dearest first so a shortage at the top cascades down instead of starving cheap slots.
  for (const price of [...prices].sort((a, b) => b - a)) {
    const pick = tiers.find((tier) => tier <= price && (left.get(tier) ?? 0) > 0)
    if (pick === undefined) continue
    left.set(pick, (left.get(pick) ?? 0) - 1)
    out.push(pick)
  }
  return out.reverse()
}

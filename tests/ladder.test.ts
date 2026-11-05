import { describe, expect, it } from 'vitest'
import {
  LADDER,
  PACK_TIERS,
  expandStep,
  fitToStock,
  machineFor,
  pickStep,
  stepCost,
  stepPackCount,
} from '../shared/ladder.ts'

describe('ladder', () => {
  it('matches the table in the plan', () => {
    expect(LADDER.map((step) => [step.minTreasury, stepPackCount(step), stepCost(step)])).toEqual([
      [650, 25, 625],
      [1_000, 26, 950],
      [2_500, 52, 2_250],
      [5_000, 83, 4_400],
      [10_000, 114, 7_500],
    ])
  })

  it('always leaves a buffer below the treasury it needs', () => {
    for (const step of LADDER) expect(stepCost(step)).toBeLessThan(step.minTreasury)
  })

  it('never buys above the $500 ceiling, however big the treasury', () => {
    for (const step of LADDER) expect(Math.max(...expandStep(step))).toBeLessThanOrEqual(500)
    expect(pickStep(1_000_000)).toBe(LADDER.at(-1))
  })

  it('stays on small packs at $1,000 and adds big ones at $5,000', () => {
    expect(expandStep(pickStep(1_000)!).every((price) => price <= 100)).toBe(true)
    const big = expandStep(pickStep(5_000)!)
    expect(big.filter((price) => price === 500)).toHaveLength(1)
    expect(big.filter((price) => price === 250)).toHaveLength(2)
  })

  it('picks nothing below the first step', () => {
    expect(pickStep(649.99)).toBeNull()
    expect(pickStep(650)).toBe(LADDER[0])
  })

  it('maps every price to a machine', () => {
    for (const tier of PACK_TIERS) expect(machineFor(tier.price)).toBe(tier.machine)
    expect(() => machineFor(75)).toThrow()
  })
})

describe('fitToStock', () => {
  const full = new Map(PACK_TIERS.map((tier) => [tier.price as number, 10_000]))

  it('leaves the lineup alone when everything is in stock', () => {
    const prices = expandStep(LADDER[3]!)
    expect(fitToStock(prices, full).sort((a, b) => a - b)).toEqual([...prices].sort((a, b) => a - b))
  })

  it('falls to the next cheaper pack when a machine is empty', () => {
    const stock = new Map(full).set(500, 0)
    expect(fitToStock([500, 25], stock).sort((a, b) => a - b)).toEqual([25, 250])
  })

  it('can only ever reduce spend', () => {
    const prices = expandStep(LADDER[4]!)
    const stock = new Map([[25, 40], [50, 5], [100, 0], [250, 1], [500, 0]])
    const fitted = fitToStock(prices, stock)
    const total = (list: number[]) => list.reduce((sum, price) => sum + price, 0)
    expect(total(fitted)).toBeLessThanOrEqual(total(prices))
    expect(fitted.filter((price) => price === 25).length).toBeLessThanOrEqual(40)
  })

  it('drops a slot entirely when nothing cheaper is left', () => {
    expect(fitToStock([25, 25], new Map([[25, 1]]))).toEqual([25])
  })
})

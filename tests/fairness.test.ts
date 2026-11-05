import { describe, expect, it } from 'vitest'
import { commitHash, pickDrop, seededShuffle, shuffleLineup } from '../shared/fairness.ts'

describe('fairness', () => {
  it('commits to the secret', () => {
    expect(commitHash('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('shuffles deterministically and keeps every item', () => {
    const prices = [25, 25, 50, 100, 250, 500]
    const once = shuffleLineup(prices, 'secret', 7)
    expect(shuffleLineup(prices, 'secret', 7)).toEqual(once)
    expect([...once].sort((a, b) => a - b)).toEqual(prices)
  })

  it('changes with the secret and with the round', () => {
    const items = Array.from({ length: 50 }, (_, i) => i)
    expect(shuffleLineup(items, 'a', 1)).not.toEqual(shuffleLineup(items, 'b', 1))
    expect(shuffleLineup(items, 'a', 1)).not.toEqual(shuffleLineup(items, 'a', 2))
  })

  it('picks distinct rips, and the blockhash changes the pick', () => {
    const pool = Array.from({ length: 60 }, (_, i) => `sig${i}`)
    const picks = pickDrop(pool, 5, 'secret', 'hashA', 3, 0)
    expect(new Set(picks).size).toBe(5)
    expect(pickDrop(pool, 5, 'secret', 'hashB', 3, 0)).not.toEqual(picks)
    expect(pickDrop(pool, 5, 'secret', 'hashA', 3, 1)).not.toEqual(picks)
  })

  it('returns what it can when the pool is short', () => {
    expect(pickDrop(['a', 'b'], 5, 's', 'h', 1, 0)).toHaveLength(2)
    expect(pickDrop([], 5, 's', 'h', 1, 0)).toEqual([])
  })

  it('has no visible bias toward any position', () => {
    const counts = [0, 0, 0, 0, 0]
    const trials = 5_000
    for (let i = 0; i < trials; i++) {
      counts[seededShuffle([0, 1, 2, 3, 4], `seed${i}`)[0]!]! += 1
    }
    for (const count of counts) {
      expect(count / trials).toBeGreaterThan(0.17)
      expect(count / trials).toBeLessThan(0.23)
    }
  })
})

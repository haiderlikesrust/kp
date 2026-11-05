import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils'

/**
 * Everything random in a round comes from here. It runs in the browser too, so
 * anyone can recompute a lineup or a drop from the published inputs.
 */

export function commitHash(secret: string): string {
  return bytesToHex(sha256(utf8ToBytes(secret)))
}

/** Deterministic byte stream: SHA-256 of the seed plus a counter. */
function stream(seed: string): () => number {
  let counter = 0
  let block: Uint8Array = new Uint8Array(0)
  let offset = 0
  const nextByte = (): number => {
    if (offset >= block.length) {
      block = sha256(utf8ToBytes(`${seed}|${counter}`))
      counter += 1
      offset = 0
    }
    return block[offset++] as number
  }
  return () => {
    let value = 0
    for (let i = 0; i < 4; i++) value = value * 256 + nextByte()
    return value
  }
}

/** Unbiased integer in [0, bound), using rejection sampling. */
function below(next: () => number, bound: number): number {
  const range = 2 ** 32
  const limit = range - (range % bound)
  for (;;) {
    const value = next()
    if (value < limit) return value % bound
  }
}

export function seededShuffle<T>(items: readonly T[], seed: string): T[] {
  const next = stream(seed)
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = below(next, i + 1)
    ;[out[i], out[j]] = [out[j] as T, out[i] as T]
  }
  return out
}

export function lineupSeed(secret: string, roundId: number): string {
  return `lineup|${secret}|${roundId}`
}

export function dropSeed(secret: string, blockhash: string, roundId: number, dropIndex: number): string {
  return `drop|${secret}|${blockhash}|${roundId}|${dropIndex}`
}

export function shuffleLineup(prices: readonly number[], secret: string, roundId: number): number[] {
  return seededShuffle(prices, lineupSeed(secret, roundId))
}

/** Picks `count` rip signatures from the pool, in the order they are handed out. */
export function pickDrop(
  pool: readonly string[],
  count: number,
  secret: string,
  blockhash: string,
  roundId: number,
  dropIndex: number,
): string[] {
  return seededShuffle(pool, dropSeed(secret, blockhash, roundId, dropIndex)).slice(0, count)
}

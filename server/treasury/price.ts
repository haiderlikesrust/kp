import { jupiterOrder } from './jupiter.ts'

const MAX_AGE_MS = 5 * 60 * 1000

/**
 * What one burn is worth in dollars right now. It is display and record keeping
 * only: nothing in the game rules depends on it, so a stale or missing price can
 * never change who wins.
 */
export class BurnPrice {
  private usd: number | null = null
  private updatedAt = 0

  constructor(private fetchUsd: () => Promise<number | null>) {}

  async refresh(): Promise<void> {
    const usd = await this.fetchUsd()
    if (usd !== null && Number.isFinite(usd) && usd > 0) {
      this.usd = usd
      this.updatedAt = Date.now()
    }
  }

  current(): number | null {
    return Date.now() - this.updatedAt > MAX_AGE_MS ? null : this.usd
  }
}

/** Real market value: what selling one burn's worth of coins would return. */
export function jupiterBurnPrice(args: { coinMint: string; usdcMint: string; burnRaw: bigint; apiKey?: string }): BurnPrice {
  return new BurnPrice(async () => {
    const quote = await jupiterOrder({ input: args.coinMint, output: args.usdcMint, amount: args.burnRaw, apiKey: args.apiKey })
    return quote.outAmount ? Number(quote.outAmount) / 1e6 : null
  })
}

/** Drifts around a level, so the demo shows a moving price. */
export function mockBurnPrice(startUsd = 12): BurnPrice {
  let usd = startUsd
  return new BurnPrice(async () => {
    usd *= 1 + (Math.random() - 0.5) * 0.04
    return usd
  })
}

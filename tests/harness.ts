import { Game } from '../server/game/service.ts'
import { Indexer } from '../server/chain/indexer.ts'
import { MockChain, randomAddress } from '../server/mock/chain.ts'
import { MOCK_GACHA_USDC, MOCK_USDC_MINT, MockProvider } from '../server/mock/provider.ts'
import { PackPipeline } from '../server/packs/pipeline.ts'
import { PayoutPipeline } from '../server/payouts/pipeline.ts'
import { openDb, type Db } from '../server/db/index.ts'
import { silentLog } from '../server/log.ts'
import { RULES } from '../shared/rules.ts'

export const BURN_RAW = 100_000n * 1_000_000n

export function buildProcess(db: Db, chain: MockChain, provider: MockProvider, gapSlots: number) {
  const game = new Game({
    db,
    chain,
    provider,
    log: silentLog,
    burnRaw: BURN_RAW,
    resolveHintMs: 0,
    roundGapSlots: gapSlots,
  })
  const indexer = new Indexer({
    db,
    chain,
    log: silentLog,
    coinMint: chain.coinMint,
    tokenProgram: chain.tokenProgram,
    voucherReference: chain.devAddress,
    burnUsd: () => 12.5,
  })
  const packs = new PackPipeline({
    db,
    chain,
    provider,
    log: silentLog,
    usdcMint: MOCK_USDC_MINT,
    gachaUsdcAccount: MOCK_GACHA_USDC,
    pause: (reason) => game.setPaused(true, reason),
    onOrderFailed: (order) => game.orderFailed(order),
  })
  const payouts = new PayoutPipeline({ db, chain, log: silentLog })
  return { game, indexer, packs, payouts }
}

export interface World extends ReturnType<typeof buildProcess> {
  db: Db
  chain: MockChain
  provider: MockProvider
  /** Advance the chain and run every worker once, like one server cycle. */
  cycle(slots?: number): Promise<void>
  /** Cycle until the condition holds. */
  until(condition: () => Promise<boolean>, limit?: number): Promise<void>
  /** Open a round and return its id. */
  openRound(): Promise<number>
  /** Simulates a restart: new objects, same database and chain. */
  restart(): void
  round(id: number): Promise<Record<string, any>>
  settled(id: number): Promise<boolean>
  count(sql: string, params?: unknown[]): Promise<number>
}

export async function makeWorld(opts: { usdc?: number; gapSlots?: number } = {}): Promise<World> {
  const db = await openDb()
  const chain = new MockChain({ burnRaw: BURN_RAW, usdcMicro: BigInt(opts.usdc ?? 1_000) * 1_000_000n })
  const provider = new MockProvider(chain)
  const gapSlots = opts.gapSlots ?? RULES.roundGapSlots
  let parts = buildProcess(db, chain, provider, gapSlots)

  const world: World = {
    db,
    chain,
    provider,
    get game() {
      return parts.game
    },
    get indexer() {
      return parts.indexer
    },
    get packs() {
      return parts.packs
    },
    get payouts() {
      return parts.payouts
    },
    async cycle(slots = 1) {
      chain.advance(slots)
      await parts.indexer.poll()
      await parts.game.tick()
      if (!(await parts.game.isPaused())) {
        await parts.packs.step()
        await parts.payouts.step()
      }
    },
    async until(condition, limit = 600) {
      for (let i = 0; i < limit; i++) {
        if (await condition()) return
        await world.cycle()
      }
      throw new Error('condition never held')
    },
    async openRound() {
      await world.until(async () => (await world.count(`SELECT count(*)::int AS n FROM rounds WHERE status = 'open'`)) > 0)
      const [row] = await db.query(`SELECT id FROM rounds WHERE status = 'open' ORDER BY id DESC LIMIT 1`)
      // A burn has to land after the opening slot.
      await world.cycle()
      return row?.id as number
    },
    restart() {
      parts = buildProcess(db, chain, provider, gapSlots)
    },
    async round(id) {
      const [row] = await db.query(`SELECT * FROM rounds WHERE id = $1`, [id])
      return row as Record<string, any>
    },
    async settled(id) {
      return (await world.round(id)).status === 'settled'
    },
    async count(sql, params) {
      const [row] = await db.query(sql, params)
      return row?.n as number
    },
  }
  return world
}

export const wallet = randomAddress

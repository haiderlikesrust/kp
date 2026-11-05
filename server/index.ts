import { PublicKey } from '@solana/web3.js'
import type { PublicConfig } from '../shared/api.ts'
import { SLOT_MS } from '../shared/rules.ts'
import { Indexer } from './chain/indexer.ts'
import { SolanaChain } from './chain/solana.ts'
import type { Chain } from './chain/types.ts'
import { loadConfig } from './config.ts'
import { Coordinator, type Role } from './coordinator.ts'
import { openDb } from './db/index.ts'
import { Game } from './game/service.ts'
import { buildState } from './game/views.ts'
import { buildHttp, type HttpOptions } from './http.ts'
import { createLog } from './log.ts'
import { startBots } from './mock/bots.ts'
import { MockChain } from './mock/chain.ts'
import { MOCK_GACHA_USDC, MOCK_USDC_MINT, MockProvider } from './mock/provider.ts'
import { CollectorCrypt } from './packs/collector-crypt.ts'
import { PackPipeline } from './packs/pipeline.ts'
import type { PackProvider } from './packs/provider.ts'
import { PayoutPipeline } from './payouts/pipeline.ts'
import { type BurnPrice, jupiterBurnPrice, mockBurnPrice } from './treasury/price.ts'
import { Treasury } from './treasury/worker.ts'

const COIN_DECIMALS_MOCK = 6
/** Swarm kills a container 10 seconds after asking it to stop. */
const DRAIN_MS = 6_000
const CLOSE_MS = 1_500

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function main(): Promise<void> {
  const config = loadConfig()
  const log = createLog(config.alertWebhook)
  const db = await openDb({ url: config.databaseUrl, pgliteDir: config.pgliteDir })

  let chain: Chain
  let provider: PackProvider
  let coinMint: string
  let tokenProgram: string
  let decimals: number
  let usdcMint: string
  let gachaUsdcAccount: string
  let treasury: Treasury | null = null
  let mockChain: MockChain | null = null

  if (config.mode === 'mock') {
    decimals = COIN_DECIMALS_MOCK
    mockChain = new MockChain({
      burnRaw: BigInt(config.burnTokens) * 10n ** BigInt(decimals),
      usdcMicro: BigInt(config.mockStartUsd) * 1_000_000n,
    })
    const mockProvider = new MockProvider(mockChain)
    const cards = await mockProvider.loadRealCatalog()
    log.info(cards > 0 ? `mock catalog: ${cards} real cards` : 'mock catalog: offline, using sample cards')
    chain = mockChain
    provider = mockProvider
    coinMint = mockChain.coinMint
    tokenProgram = mockChain.tokenProgram
    usdcMint = MOCK_USDC_MINT
    gachaUsdcAccount = MOCK_GACHA_USDC
  } else {
    const solana = new SolanaChain({
      rpcUrl: config.rpcUrl,
      dasRpcUrl: config.dasRpcUrl,
      devPrivateKey: config.devPrivateKey,
      usdcMint: config.usdcMint,
      priorityMicroLamports: config.priorityMicroLamports,
    })
    const mint = await solana.connection.getParsedAccountInfo(new PublicKey(config.coinMint))
    const parsed = mint.value?.data as { parsed?: { info?: { decimals?: number } } } | undefined
    if (!mint.value || parsed?.parsed?.info?.decimals === undefined) throw new Error('COIN_MINT is not a token mint')
    decimals = parsed.parsed.info.decimals
    tokenProgram = mint.value.owner.toBase58()
    chain = solana
    provider = new CollectorCrypt({ base: config.collectorCryptBase, apiKey: config.collectorCryptKey })
    coinMint = config.coinMint
    usdcMint = config.usdcMint
    gachaUsdcAccount = config.gachaUsdcAccount
    // Jupiter has no devnet, so fee conversion only runs on mainnet.
    if (config.mode === 'mainnet') {
      treasury = new Treasury({
        db,
        chain: solana,
        log,
        coinMint: new PublicKey(coinMint),
        usdcMint: new PublicKey(usdcMint),
        jupiterKey: config.jupiterKey,
        minClaimUsd: config.minClaimUsd,
      })
    }
    log.info(`dev wallet ${solana.devAddress}, coin ${coinMint}`)
  }

  const burnRaw = BigInt(config.burnTokens) * 10n ** BigInt(decimals)
  let price: BurnPrice | null = null
  if (config.mode === 'mock') price = mockBurnPrice()
  else if (config.mode === 'mainnet') {
    price = jupiterBurnPrice({ coinMint, usdcMint, burnRaw, apiKey: config.jupiterKey })
  }
  await price?.refresh().catch((err) => log.warn('price', err))
  const burnUsd = () => price?.current() ?? null

  const game = new Game({
    db,
    chain,
    provider,
    log,
    burnRaw,
    resolveHintMs: config.resolveHintMs,
    roundGapSlots: config.roundGapSlots,
  })
  const indexer = new Indexer({
    db,
    chain,
    log,
    coinMint,
    tokenProgram,
    voucherReference: chain.devAddress,
    burnUsd,
  })
  const packs = new PackPipeline({
    db,
    chain,
    provider,
    log,
    usdcMint,
    gachaUsdcAccount,
    pause: (reason) => game.setPaused(true, reason),
    onOrderFailed: (order) => game.orderFailed(order),
  })
  const payouts = new PayoutPipeline({ db, chain, log })

  const stateOptions = { chain, mode: config.mode, roundGapSlots: config.roundGapSlots, decimals, burnUsd }
  let stateJson = JSON.stringify(await buildState(db, game, stateOptions))

  const publicConfig: PublicConfig = {
    mode: config.mode,
    coinMint,
    coinDecimals: decimals,
    tokenProgram,
    burnTokens: config.burnTokens,
    burnRaw: burnRaw.toString(),
    voucherReference: chain.devAddress,
    slotMs: SLOT_MS,
    explorerCluster: config.mode === 'devnet' ? '?cluster=devnet' : '',
  }

  const mock = mockChain
  const mockActions: HttpOptions['mockActions'] = mock
    ? {
        async rip(wallet, roundId) {
          return mock.burn({ wallet, roundId, delaySlots: 3 })
        },
        async redeem(wallet, roundId, originSig) {
          return mock.redeemVoucher({ wallet, roundId, originSig, delaySlots: 3 })
        },
      }
    : undefined

  let stopping = false
  const running: Promise<void>[] = []

  /** Every worker is a loop that survives its own errors and stops on request. */
  const loop = (name: string, everyMs: number, work: () => Promise<void>): void => {
    const body = async (): Promise<void> => {
      while (!stopping) {
        try {
          await work()
        } catch (err) {
          log.warn(`${name} loop`, err instanceof Error ? err.message : err)
        }
        await sleep(everyMs)
      }
    }
    running.push(body())
  }
  const unlessPaused = (work: () => Promise<void>) => async () => {
    if (!(await game.isPaused())) await work()
  }

  const startWorkers = (): void => {
    indexer.start(() => {
      game.tick().then(publish).catch((err) => log.warn('tick after burn', err))
    })
    loop('indexer', mock ? 400 : 1_500, () => indexer.poll())
    loop('game', SLOT_MS, () => game.tick())
    loop('packs', 500, unlessPaused(() => packs.step()))
    loop('payouts', 1_000, unlessPaused(() => payouts.step()))
    if (treasury) {
      const worker = treasury
      loop('treasury', 60_000, unlessPaused(() => worker.step()))
    }
    if (mock) {
      setInterval(() => mock.advance(1), SLOT_MS)
      if (config.mockBots) startBots(mock, game, { tickMs: 400, usdPerTick: 0.6 })
    }
  }

  // Mock mode keeps everything in memory, so each server is its own world and
  // there is nothing to share or hand over.
  const coordinator = config.databaseUrl
    ? new Coordinator({
        db,
        log,
        onActive: startWorkers,
        onLockLost: () => {
          void stop(1)
        },
      })
    : null
  const role = (): Role | 'active' => coordinator?.role ?? 'active'

  const http = await buildHttp({
    db,
    indexer,
    log,
    mode: config.mode,
    publicConfig,
    rpcUrl: config.rpcUrl,
    trustProxyHops: config.trustProxyHops,
    state: () => stateJson,
    role,
    mockActions,
  })

  let lastBroadcast = 0
  async function publish(): Promise<void> {
    const next = await buildState(db, game, stateOptions)
    const json = JSON.stringify(next)
    const changed = json.replace(/"serverSlot":\d+/, '') !== stateJson.replace(/"serverSlot":\d+/, '')
    stateJson = json
    if (changed || Date.now() - lastBroadcast > 2_000) {
      lastBroadcast = Date.now()
      http.broadcast(json)
    }
  }

  async function stop(code: number): Promise<void> {
    if (stopping) return
    stopping = true
    coordinator?.drain()
    log.info('stopping: finishing current work')
    await Promise.race([Promise.all(running), sleep(DRAIN_MS)])
    // Open pages reconnect by themselves, and reach the new server.
    http.endStreams()
    await Promise.race([http.app.close(), sleep(CLOSE_MS)])
    // This releases the lock, which is the moment the standby takes over.
    await db.close().catch(() => {})
    log.info('stopped')
    process.exit(code)
  }
  process.on('SIGINT', () => void stop(0))
  process.on('SIGTERM', () => void stop(0))

  // Serve first: a standby has to answer health checks while it waits.
  await http.app.listen({ port: config.port, host: config.host })
  log.info(`KeepRipping ${config.mode} on http://${config.host}:${config.port}`)

  loop('state', SLOT_MS, publish)
  if (price) {
    const feed = price
    loop('price', mock ? 4_000 : 30_000, () => feed.refresh())
  }
  if (coordinator) coordinator.start()
  else startWorkers()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

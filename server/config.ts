import 'dotenv/config'
import { RULES } from '../shared/rules.ts'

export type Mode = 'mock' | 'devnet' | 'mainnet'

export interface Config {
  mode: Mode
  port: number
  host: string
  /** Proxies in front of this server. Dokploy's Traefik is one. */
  trustProxyHops: number
  databaseUrl?: string
  pgliteDir?: string
  coinMint: string
  rpcUrl: string
  dasRpcUrl: string
  devPrivateKey: string
  usdcMint: string
  gachaUsdcAccount: string
  collectorCryptBase: string
  collectorCryptKey?: string
  jupiterKey?: string
  alertWebhook?: string
  burnTokens: number
  resolveHintMs: number
  roundGapSlots: number
  /** Skip claims and swaps below this many dollars of accrued fees. */
  minClaimUsd: number
  priorityMicroLamports: number
  mockBots: boolean
  mockStartUsd: number
}

const NETWORKS = {
  devnet: {
    usdcMint: 'Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr',
    gachaUsdcAccount: '9ZSgA3PMjeAU8K6CWzgJ8oDnhZwwSgHZu6KP3X95t7Jq',
    collectorCryptBase: 'https://dev-gacha.collectorcrypt.com',
  },
  mainnet: {
    usdcMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    gachaUsdcAccount: 'D9CEogjHA6CpS12F8St9zpSco7pQKJB5uR1RqDsuzQZk',
    collectorCryptBase: 'https://gacha.collectorcrypt.com',
  },
} as const

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]
  if (!value) throw new Error(`${name} is required when MODE is not mock`)
  return value
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const mode = (env.MODE ?? 'mock') as Mode
  if (!['mock', 'devnet', 'mainnet'].includes(mode)) throw new Error(`unknown MODE ${mode}`)
  if (mode === 'mainnet' && env.MAINNET_ENABLED !== 'true') {
    throw new Error('MODE=mainnet also needs MAINNET_ENABLED=true, so real money is never spent by accident')
  }

  const shared = {
    mode,
    port: Number(env.PORT ?? 3000),
    host: env.HOST ?? '127.0.0.1',
    trustProxyHops: Number(env.TRUST_PROXY_HOPS ?? 0),
    // Mock chains live in memory, so a mock database must not outlive them.
    databaseUrl: mode === 'mock' ? undefined : env.DATABASE_URL || undefined,
    pgliteDir: env.PGLITE_DIR || (env.DATABASE_URL || mode === 'mock' ? undefined : './.data/pg'),
    alertWebhook: env.ALERT_WEBHOOK_URL || undefined,
    burnTokens: Number(env.BURN_TOKENS ?? RULES.burnTokens),
    roundGapSlots: Number(env.ROUND_GAP_SLOTS ?? RULES.roundGapSlots),
    minClaimUsd: Number(env.MIN_CLAIM_USD ?? 5),
    priorityMicroLamports: Number(env.PRIORITY_MICROLAMPORTS ?? 50_000),
  }

  if (mode === 'mock') {
    return {
      ...shared,
      coinMint: '',
      rpcUrl: '',
      dasRpcUrl: '',
      devPrivateKey: '',
      usdcMint: '',
      gachaUsdcAccount: '',
      collectorCryptBase: '',
      resolveHintMs: Number(env.RESOLVE_HINT_MS ?? 4_000),
      mockBots: env.MOCK_BOTS !== 'false',
      mockStartUsd: Number(env.MOCK_START_USD ?? 5_200),
    }
  }

  // A container's local files vanish on every update, and with them the game.
  if (env.NODE_ENV === 'production' && !env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required in production')
  }

  const network = NETWORKS[mode]
  const rpcUrl = required(env, 'SOLANA_RPC_URL')
  return {
    ...shared,
    coinMint: required(env, 'COIN_MINT'),
    rpcUrl,
    dasRpcUrl: env.DAS_RPC_URL || rpcUrl,
    devPrivateKey: required(env, 'DEV_WALLET_PRIVATE_KEY'),
    usdcMint: env.USDC_MINT || network.usdcMint,
    gachaUsdcAccount: env.GACHA_USDC_ACCOUNT || network.gachaUsdcAccount,
    collectorCryptBase: env.COLLECTOR_CRYPT_BASE || network.collectorCryptBase,
    collectorCryptKey: env.COLLECTOR_CRYPT_API_KEY || undefined,
    jupiterKey: env.JUPITER_API_KEY || undefined,
    resolveHintMs: Number(env.RESOLVE_HINT_MS ?? RULES.resolveHintMs),
    mockBots: false,
    mockStartUsd: 0,
  }
}

/** Wire types shared by the server and the web client. */

export type RoundStatus = 'sized' | 'open' | 'live' | 'cutoff' | 'resolved' | 'delivering' | 'settled'

export type Rarity = 'Common' | 'Uncommon' | 'Rare' | 'Epic'

export interface CardView {
  nft: string
  name: string
  image: string | null
  rarity: Rarity | null
  insuredValue: number | null
  packPrice: number
  ripper: string
  ripSig: string
  /** Who this card ended up with, once decided. */
  recipient: string | null
  reason: 'win' | 'drop' | null
  delivered: boolean
}

export interface BurnerView {
  wallet: string
  rips: number
  /** Whole coins burned in this window. Voucher rips burn nothing new. */
  tokens: number
  usd: number
}

export interface RipView {
  signature: string
  wallet: string
  slot: number
  voucher: boolean
  packPrice: number | null
  opened: boolean
  /** Seconds this rip put on the clock. */
  addedSeconds: number
}

export interface DropView {
  index: number
  slot: number
  status: 'waiting_seed' | 'picked'
  recipients: { wallet: string; ripSig: string }[]
}

export interface RoundView {
  id: number
  status: RoundStatus
  packsTotal: number
  packsRipped: number
  firstSlot: number | null
  deadlineSlot: number | null
  nextDropSlot: number | null
  lastRipper: string | null
  winner: string | null
  endReason: 'timer' | 'sold_out' | null
  commitHash: string
  potUsd: number
  lineup: { price: number; count: number }[]
  rips: RipView[]
  cards: CardView[]
  drops: DropView[]
  topBurners: BurnerView[]
  undelivered: number
  burnedTokens: number
  burnedUsd: number
  heat: { recentRips: number; nextAddSeconds: number }
}

export interface GameState {
  mode: 'mock' | 'devnet' | 'mainnet'
  paused: boolean
  serverSlot: number
  treasuryUsd: number
  nextRoundSlot: number | null
  neededTreasuryUsd: number
  /** Dollar value of one burn right now, if a price is available. */
  burnUsd: number | null
  burnedAllTime: { tokens: number; usd: number }
  round: RoundView | null
  lastWin: { roundId: number; winner: string; cards: number; potUsd: number } | null
}

export interface PublicConfig {
  mode: 'mock' | 'devnet' | 'mainnet'
  coinMint: string
  coinDecimals: number
  tokenProgram: string
  burnTokens: number
  burnRaw: string
  voucherReference: string
  slotMs: number
  explorerCluster: string
}

export interface WalletView {
  wallet: string
  vouchers: { originSig: string; reason: string; createdAt: string }[]
  rips: number
}

export interface RoundSummary {
  id: number
  status: RoundStatus
  winner: string | null
  endReason: string | null
  packsTotal: number
  packsRipped: number
  potUsd: number
  settledAt: string | null
}

export interface RoundProof extends RoundSummary {
  commitHash: string
  commitSig: string | null
  secret: string | null
  lineup: number[]
  burns: { signature: string; wallet: string; slot: number; blockIndex: number; result: string }[]
  drops: { index: number; slot: number; blockhash: string | null; pool: string[]; picks: string[]; recipients: string[] }[]
  payouts: { nft: string | null; recipient: string; signature: string | null; state: string; reason: string }[]
}

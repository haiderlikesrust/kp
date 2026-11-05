import { randomBytes } from 'node:crypto'
import { Keypair } from '@solana/web3.js'
import bs58 from 'bs58'
import { burnMemo, voucherMemo } from '../../shared/rules.ts'
import { signPartial } from '../chain/sign.ts'
import type { AssetInfo, Chain, Commitment, ParsedTx, SignedTx, TxStatus } from '../chain/types.ts'

const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const MEMO = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'
const FINALITY_SLOTS = 32
const BLOCKHASH_LIFETIME_SLOTS = 150

export const randomAddress = (): string => Keypair.generate().publicKey.toBase58()
export const randomSignature = (): string => bs58.encode(randomBytes(64))

interface Landed {
  tx: ParsedTx
  blockIndex: number
  dropped: boolean
}

interface PendingSigned {
  createdSlot: number
  status: TxStatus
}

interface MockCardTransfer {
  signature: string
  nft: string
  to: string
}

/**
 * An in-memory Solana. Its parsed transactions have the same shape as a real
 * RPC response, so the verifier, indexer and pipelines run unchanged on it.
 * Failure switches below let tests break it on purpose.
 */
export class MockChain implements Chain {
  readonly devKeypair = Keypair.generate()
  readonly coinMint = randomAddress()
  readonly tokenProgram = TOKEN
  readonly burnRaw: bigint

  slotNow = 1_000
  usdc = 0n
  sol = 2_000_000_000n
  assets = new Map<string, AssetInfo>()

  /** Transfers to fail before succeeding, to exercise retries. */
  failNextTransfers = 0
  /** When true, card transfers land but report no status, as if lost. */
  loseTransferStatus = false
  /** Cards delivered per NFT, so tests can prove nothing was sent twice. */
  transferCount = new Map<string, number>()
  usdcSpent = 0n

  private landed = new Map<string, Landed>()
  private blockSizes = new Map<number, number>()
  private byAddress = new Map<string, string[]>()
  private signed = new Map<string, PendingSigned>()
  private queue: { atSlot: number; run: () => void }[] = []
  private watchers = new Map<string, ((signature: string) => void)[]>()

  constructor(opts: { burnRaw: bigint; usdcMicro?: bigint }) {
    this.burnRaw = opts.burnRaw
    this.usdc = opts.usdcMicro ?? 0n
  }

  get devAddress(): string {
    return this.devKeypair.publicKey.toBase58()
  }

  /** Moves the chain forward, landing anything queued for those slots. */
  advance(slots = 1): void {
    for (let i = 0; i < slots; i++) {
      this.slotNow += 1
      const due = this.queue.filter((item) => item.atSlot <= this.slotNow)
      this.queue = this.queue.filter((item) => item.atSlot > this.slotNow)
      for (const item of due) item.run()
    }
  }

  private record(address: string, signature: string): void {
    const list = this.byAddress.get(address) ?? []
    list.push(signature)
    this.byAddress.set(address, list)
    for (const watcher of this.watchers.get(address) ?? []) watcher(signature)
  }

  private land(signature: string, slot: number, build: (slot: number) => ParsedTx, address: string): void {
    const blockIndex = this.blockSizes.get(slot) ?? 0
    this.blockSizes.set(slot, blockIndex + 1)
    this.landed.set(signature, { tx: build(slot), blockIndex, dropped: false })
    this.record(address, signature)
  }

  /** Lands a burn. Wallet-side delay is simulated with `delaySlots`. */
  burn(args: {
    wallet: string
    roundId: number
    delaySlots?: number
    amount?: bigint
    memo?: string
    mint?: string
    delegate?: boolean
    failed?: boolean
  }): string {
    const signature = randomSignature()
    const account = randomAddress()
    const amount = args.amount ?? this.burnRaw
    const mint = args.mint ?? this.coinMint
    const memo = args.memo ?? burnMemo(args.roundId)
    const build = (slot: number): ParsedTx => ({
      slot,
      meta: {
        err: args.failed ? { InstructionError: [0, 'Custom'] } : null,
        preTokenBalances: [
          { accountIndex: 1, mint, owner: args.delegate ? randomAddress() : args.wallet },
        ],
      },
      transaction: {
        signatures: [signature],
        message: {
          accountKeys: [
            { pubkey: args.wallet, signer: true },
            { pubkey: account, signer: false },
          ],
          instructions: [
            {
              programId: TOKEN,
              program: 'spl-token',
              parsed: {
                type: 'burnChecked',
                info: { account, mint, authority: args.wallet, tokenAmount: { amount: amount.toString(), decimals: 6 } },
              },
            },
            { programId: MEMO, program: 'spl-memo', parsed: memo },
          ],
        },
      },
    })
    this.schedule(args.delaySlots ?? 0, () => this.land(signature, this.slotNow, build, this.coinMint))
    return signature
  }

  redeemVoucher(args: { wallet: string; roundId: number; originSig: string; delaySlots?: number }): string {
    const signature = randomSignature()
    const build = (slot: number): ParsedTx => ({
      slot,
      meta: { err: null, preTokenBalances: [] },
      transaction: {
        signatures: [signature],
        message: {
          accountKeys: [{ pubkey: args.wallet, signer: true }],
          instructions: [
            { programId: MEMO, program: 'spl-memo', parsed: voucherMemo(args.roundId, args.originSig) },
          ],
        },
      },
    })
    this.schedule(args.delaySlots ?? 0, () => this.land(signature, this.slotNow, build, this.devAddress))
    return signature
  }

  private schedule(delaySlots: number, run: () => void): void {
    if (delaySlots <= 0) run()
    else this.queue.push({ atSlot: this.slotNow + delaySlots, run })
  }

  /** Simulates a reorg removing a confirmed transaction. */
  dropTx(signature: string): void {
    const entry = this.landed.get(signature)
    if (entry) entry.dropped = true
  }

  async slot(): Promise<number> {
    return this.slotNow
  }

  async finalizedSlot(): Promise<number> {
    return this.slotNow - FINALITY_SLOTS
  }

  async getParsedTx(signature: string, commitment: Commitment): Promise<ParsedTx | null> {
    const entry = this.landed.get(signature)
    if (!entry || entry.dropped) return null
    if (commitment === 'finalized' && entry.tx.slot > this.slotNow - FINALITY_SLOTS) return null
    return entry.tx
  }

  async blockIndexOf(_slot: number, signature: string): Promise<number> {
    return this.landed.get(signature)?.blockIndex ?? 0
  }

  async finalizedBlockhashFrom(slot: number): Promise<{ slot: number; blockhash: string } | null> {
    if (slot > this.slotNow - FINALITY_SLOTS) return null
    return { slot, blockhash: `mockhash${slot}` }
  }

  async memoSignatures(address: string, until: string | null): Promise<string[]> {
    const list = (this.byAddress.get(address) ?? []).filter((signature) => !this.landed.get(signature)?.dropped)
    const start = until ? list.indexOf(until) + 1 : 0
    return list.slice(start)
  }

  watchMemos(address: string, onSignature: (signature: string) => void): void {
    this.watchers.set(address, [...(this.watchers.get(address) ?? []), onSignature])
  }

  async usdcMicro(): Promise<bigint> {
    return this.usdc
  }

  async lamports(): Promise<bigint> {
    return this.sol
  }

  async sendMemo(_text: string): Promise<string> {
    const signature = randomSignature()
    this.signed.set(signature, { createdSlot: this.slotNow, status: 'finalized' })
    return signature
  }

  async signatureStatus(signature: string): Promise<TxStatus> {
    const pending = this.signed.get(signature)
    if (!pending) return null
    if (pending.status === 'confirmed' && this.slotNow - pending.createdSlot > FINALITY_SLOTS) return 'finalized'
    return pending.status
  }

  async blockhashExpired(signedTx: string): Promise<boolean> {
    const signature = this.signatureOf(signedTx)
    const pending = signature ? this.signed.get(signature) : undefined
    return pending ? this.slotNow - pending.createdSlot > BLOCKHASH_LIFETIME_SLOTS : true
  }

  private signatureOf(signedTx: string): string | null {
    try {
      return (JSON.parse(Buffer.from(signedTx, 'base64').toString('utf8')) as MockCardTransfer).signature
    } catch {
      return this.packTxSignatures.get(signedTx) ?? null
    }
  }

  private packTxSignatures = new Map<string, string>()

  signProviderTx(transaction: string): SignedTx {
    const result = signPartial(transaction, this.devKeypair)
    this.packTxSignatures.set(result.signedTx, result.signature)
    this.signed.set(result.signature, { createdSlot: this.slotNow, status: null })
    return result
  }

  /** Called by the mock provider when a pack payment lands. */
  landPayment(signature: string, usdcMicro: bigint): void {
    const entry = this.signed.get(signature)
    if (!entry || entry.status) return
    if (this.usdc < usdcMicro) {
      entry.status = 'failed'
      return
    }
    entry.status = 'confirmed'
    this.usdc -= usdcMicro
    this.usdcSpent += usdcMicro
  }

  async sendRaw(signedTx: string): Promise<string> {
    const transfer = JSON.parse(Buffer.from(signedTx, 'base64').toString('utf8')) as MockCardTransfer
    const entry = this.signed.get(transfer.signature)
    if (entry?.status) return transfer.signature
    if (this.failNextTransfers > 0) {
      this.failNextTransfers -= 1
      throw new Error('mock send failure')
    }
    const asset = this.assets.get(transfer.nft)
    if (!asset || asset.owner !== this.devAddress) {
      this.signed.set(transfer.signature, { createdSlot: this.slotNow, status: 'failed' })
      return transfer.signature
    }
    asset.owner = transfer.to
    this.transferCount.set(transfer.nft, (this.transferCount.get(transfer.nft) ?? 0) + 1)
    this.signed.set(transfer.signature, {
      createdSlot: this.slotNow,
      status: this.loseTransferStatus ? null : 'confirmed',
    })
    return transfer.signature
  }

  async asset(address: string): Promise<AssetInfo | null> {
    const asset = this.assets.get(address)
    return asset ? { ...asset } : null
  }

  async buildCardTransfer(asset: AssetInfo, recipient: string): Promise<SignedTx> {
    const signature = randomSignature()
    const payload: MockCardTransfer = { signature, nft: asset.address, to: recipient }
    this.signed.set(signature, { createdSlot: this.slotNow, status: null })
    return { signature, signedTx: Buffer.from(JSON.stringify(payload)).toString('base64') }
  }
}

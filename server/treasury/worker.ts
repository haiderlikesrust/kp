import { createRequire } from 'node:module'
import type { OnlinePumpSdk as PumpSdk } from '@pump-fun/pump-sdk'
import {
  ComputeBudgetProgram,
  LAMPORTS_PER_SOL,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type TransactionInstruction,
} from '@solana/web3.js'
import { NATIVE_MINT, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { RULES } from '../../shared/rules.ts'
import { signPartial } from '../chain/sign.ts'
import type { SolanaChain } from '../chain/solana.ts'
import type { Db } from '../db/index.ts'
import type { Log } from '../log.ts'
import { JUPITER, jupiterOrder, type JupiterOrder } from './jupiter.ts'

// The SDK's ES module build fails to load under Node (a dependency expects a
// named export anchor only has in CommonJS), so load the CommonJS build.
const { OnlinePumpSdk, feeSharingConfigPda, normalizeQuoteMint } = createRequire(import.meta.url)(
  '@pump-fun/pump-sdk',
) as typeof import('@pump-fun/pump-sdk')

const MAX_PRICE_IMPACT = 0.03
const MAX_SPLITS = 6
/** SOL to keep: the floor plus roughly one mid-sized round of deliveries. */
const SOL_TARGET = RULES.solFloor + 40 * RULES.solPerCard
const GAS_SWAP_USDC = 25n * 1_000_000n
const GAS_DAILY_LIMIT_USD = 100

export type FeeRouting = 'direct' | 'sharing' | 'elsewhere'

export interface TreasuryOptions {
  db: Db
  chain: SolanaChain
  log: Log
  coinMint: PublicKey
  usdcMint: PublicKey
  jupiterKey?: string
  minClaimUsd: number
}

/**
 * Creator fees -> dev wallet -> USDC, plus a little SOL for gas. Each pass reads
 * balances rather than remembering what it did, so a crash between claiming and
 * swapping just means the swap happens on the next pass.
 */
export class Treasury {
  private sdk: PumpSdk
  private warnedRouting = false

  constructor(private opts: TreasuryOptions) {
    this.sdk = new OnlinePumpSdk(opts.chain.connection)
  }

  async step(): Promise<void> {
    const curve = await this.sdk.fetchBondingCurve(this.opts.coinMint)
    const quoteMint = normalizeQuoteMint(curve.quoteMint)
    const quoteProgram = await this.ownerOf(quoteMint)
    await this.claim(curve.creator, quoteMint, quoteProgram)
    await this.sellQuote(quoteMint, quoteProgram)
    await this.topUpGas()
  }

  /** Read-only view of how this coin's fees flow, for the go-live check. */
  async inspect(): Promise<{ quoteMint: string; creator: string; routing: FeeRouting; unclaimedRaw: bigint }> {
    const curve = await this.sdk.fetchBondingCurve(this.opts.coinMint)
    const quoteMint = normalizeQuoteMint(curve.quoteMint)
    const balances = await this.sdk.getCreatorVaultQuoteBalances(curve.creator, [quoteMint])
    const vault = balances.find((entry) => entry.mint.equals(quoteMint))
    return {
      quoteMint: quoteMint.toBase58(),
      creator: curve.creator.toBase58(),
      routing: this.routing(curve.creator),
      unclaimedRaw: BigInt(vault?.total.toString() ?? '0'),
    }
  }

  private routing(creator: PublicKey): FeeRouting {
    if (creator.equals(this.opts.chain.dev.publicKey)) return 'direct'
    return creator.equals(feeSharingConfigPda(this.opts.coinMint)) ? 'sharing' : 'elsewhere'
  }

  private async ownerOf(mint: PublicKey): Promise<PublicKey> {
    if (mint.equals(NATIVE_MINT)) return TOKEN_PROGRAM_ID
    const info = await this.opts.chain.connection.getAccountInfo(mint)
    if (!info) throw new Error(`quote mint ${mint.toBase58()} not found`)
    return info.owner
  }

  private async claim(creator: PublicKey, quoteMint: PublicKey, quoteProgram: PublicKey): Promise<void> {
    const { chain, coinMint, log, minClaimUsd } = this.opts
    const dev = chain.dev.publicKey
    const routing = this.routing(creator)
    const direct = routing === 'direct'
    if (routing === 'elsewhere') {
      if (!this.warnedRouting) {
        this.warnedRouting = true
        log.alert('creator fees do not reach the dev wallet', creator.toBase58())
      }
      return
    }

    const balances = await this.sdk.getCreatorVaultQuoteBalances(creator, [quoteMint])
    const vault = balances.find((entry) => entry.mint.equals(quoteMint))
    const total = BigInt(vault?.total.toString() ?? '0')
    if (total === 0n) return
    const usd = await this.usdValue(quoteMint, total)
    if (usd < minClaimUsd) return

    const instructions = direct
      ? await this.sdk.collectCoinCreatorFeeV2Instructions(dev, quoteMint, quoteProgram, dev)
      : (await this.sdk.buildDistributeCreatorFeesInstructions(coinMint, { quoteMint, quoteTokenProgram: quoteProgram, payer: dev })).instructions
    const signature = await this.send(instructions)
    await this.record(`claim:${signature}`, 'fee_claim', BigInt(Math.round(usd * 1e6)), quoteMint.toBase58())
    log.info(`claimed about $${usd.toFixed(2)} in creator fees`, signature)
  }

  private async sellQuote(quoteMint: PublicKey, quoteProgram: PublicKey): Promise<void> {
    const { chain, usdcMint, minClaimUsd } = this.opts
    if (quoteMint.equals(usdcMint)) return

    let balance: bigint
    if (quoteMint.equals(NATIVE_MINT)) {
      const keep = BigInt(Math.ceil(SOL_TARGET * LAMPORTS_PER_SOL))
      balance = (await chain.lamports()) - keep
    } else {
      const account = getAssociatedTokenAddressSync(quoteMint, chain.dev.publicKey, false, quoteProgram)
      balance = await chain.connection
        .getTokenAccountBalance(account, 'confirmed')
        .then((result) => BigInt(result.value.amount))
        .catch(() => 0n)
    }
    if (balance <= 0n) return
    if ((await this.usdValue(quoteMint, balance)) < minClaimUsd) return
    await this.swap(quoteMint, usdcMint, balance, 'swap')
  }

  private async topUpGas(): Promise<void> {
    const { chain, db, usdcMint, log } = this.opts
    const lamports = await chain.lamports()
    if (lamports >= BigInt(Math.ceil(SOL_TARGET * LAMPORTS_PER_SOL))) return

    const [spent] = await db.query(
      `SELECT coalesce(sum(usd_micro::numeric), 0)::float / 1000000 AS usd FROM ledger
       WHERE kind = 'gas' AND created_at > now() - interval '1 day'`,
    )
    if (Math.abs(spent?.usd ?? 0) >= GAS_DAILY_LIMIT_USD) {
      log.alert('daily SOL top-up limit reached and the dev wallet is still low')
      return
    }
    if ((await chain.usdcMicro()) < GAS_SWAP_USDC) {
      log.alert('dev wallet is low on SOL and has no USDC to swap')
      return
    }
    await this.swap(usdcMint, NATIVE_MINT, GAS_SWAP_USDC, 'gas')
  }

  private order(input: PublicKey, output: PublicKey, amount: bigint, taker?: PublicKey): Promise<JupiterOrder> {
    return jupiterOrder({
      input: input.toBase58(),
      output: output.toBase58(),
      amount,
      taker: taker?.toBase58(),
      apiKey: this.opts.jupiterKey,
    })
  }

  private async usdValue(mint: PublicKey, amount: bigint): Promise<number> {
    const { usdcMint } = this.opts
    if (mint.equals(usdcMint)) return Number(amount) / 1e6
    const quote = await this.order(mint, usdcMint, amount)
    return Number(quote.outAmount ?? 0) / 1e6
  }

  /** Compares the rate for this size against a small sample of the same swap. */
  private async priceImpact(input: PublicKey, output: PublicKey, order: JupiterOrder): Promise<number> {
    const size = BigInt(order.inAmount)
    const sampleSize = size / 32n
    if (sampleSize === 0n) return 0
    const sample = await this.order(input, output, sampleSize)
    const rate = Number(order.outAmount) / Number(size)
    const sampleRate = Number(sample.outAmount) / Number(sampleSize)
    return sampleRate > 0 ? 1 - rate / sampleRate : 1
  }

  private async swap(input: PublicKey, output: PublicKey, amount: bigint, kind: 'swap' | 'gas'): Promise<void> {
    const { chain, log } = this.opts
    let size = amount
    for (let attempt = 0; attempt < MAX_SPLITS && size > 0n; attempt++) {
      const order = await this.order(input, output, size, chain.dev.publicKey)
      if (!order.transaction) throw new Error(`jupiter: ${order.errorMessage ?? order.errorCode ?? 'no route'}`)
      if ((await this.priceImpact(input, output, order)) > MAX_PRICE_IMPACT) {
        size /= 2n // Sell in pieces rather than dump into thin liquidity.
        continue
      }
      const signed = signPartial(order.transaction, chain.dev)
      const signature = await this.execute(signed.signedTx, order.requestId)
      const usd = kind === 'gas' ? -size : BigInt(order.outAmount)
      await this.record(`${kind}:${signature}`, kind, usd, `${input.toBase58()} -> ${output.toBase58()}`)
      log.info(`${kind} complete`, signature)
      return
    }
    log.warn(`${kind} skipped: price impact stays above ${MAX_PRICE_IMPACT * 100}%`)
  }

  private async execute(signedTransaction: string, requestId: string): Promise<string> {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (this.opts.jupiterKey) headers['x-api-key'] = this.opts.jupiterKey
    const res = await fetch(`${JUPITER}/execute`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ signedTransaction, requestId }),
      signal: AbortSignal.timeout(60_000),
    })
    const body = (await res.json()) as { status?: string; signature?: string; error?: string; code?: number }
    if (body.status !== 'Success' || !body.signature) {
      throw new Error(`jupiter execute: ${body.error ?? body.code ?? res.status}`)
    }
    return body.signature
  }

  private async send(instructions: TransactionInstruction[]): Promise<string> {
    const { chain } = this.opts
    const { connection, dev } = chain
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
    const message = new TransactionMessage({
      payerKey: dev.publicKey,
      recentBlockhash: blockhash,
      instructions: [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }), ...instructions],
    }).compileToV0Message()
    const tx = new VersionedTransaction(message)
    tx.sign([dev])
    const signature = await connection.sendTransaction(tx)
    const { value } = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed')
    if (value.err) throw new Error(`claim failed: ${JSON.stringify(value.err)}`)
    return signature
  }

  private async record(ref: string, kind: string, usdMicro: bigint, detail: string): Promise<void> {
    await this.opts.db.query(
      `INSERT INTO ledger (ref, kind, usd_micro, detail) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [ref, kind, usdMicro.toString(), detail],
    )
  }
}

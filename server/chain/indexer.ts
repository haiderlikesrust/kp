import type { Db } from '../db/index.ts'
import type { Log } from '../log.ts'
import { MEMO_PREFIX } from '../../shared/rules.ts'
import { readMemo, verifyBurnTx, verifyVoucherTx } from './verify.ts'
import type { Chain } from './types.ts'

const CLOSED = new Set(['resolved', 'delivering', 'settled'])
/** Slots after which a confirmed burn missing at finalized counts as dropped. */
const DROP_AFTER_SLOTS = 64

export type IngestResult = 'counted' | 'known' | 'pending' | 'rejected'

export interface IndexerOptions {
  db: Db
  chain: Chain
  log: Log
  coinMint: string
  tokenProgram: string
  voucherReference: string
  /** Dollar value of one burn right now, for the record. */
  burnUsd?: () => number | null
}

/**
 * Finds burns and voucher redemptions on-chain and writes the verified ones to
 * the database. It only records facts: the reducer decides what they mean.
 * Client hints arrive here too, but a hint is only a signature to look up.
 */
export class Indexer {
  private sources: string[]

  constructor(private opts: IndexerOptions) {
    this.sources = [opts.coinMint, opts.voucherReference]
  }

  async ingest(signature: string): Promise<IngestResult> {
    const { db, chain } = this.opts
    const known = await db.query(
      `SELECT 1 FROM burns WHERE signature = $1 UNION ALL SELECT 1 FROM rejected_sigs WHERE signature = $1`,
      [signature],
    )
    if (known.length > 0) return 'known'

    const tx = await chain.getParsedTx(signature, 'confirmed')
    if (!tx) return 'pending'

    const memo = readMemo(tx)
    if (!memo) return this.reject(signature, 'no_round_memo')

    const [round] = await db.query(`SELECT id, status, open_slot, burn_raw FROM rounds WHERE id = $1`, [memo.roundId])
    if (!round) return this.reject(signature, 'unknown_round')
    if (round.open_slot === null || tx.slot <= round.open_slot) return this.reject(signature, 'before_round_open')

    const closed = CLOSED.has(round.status)

    if (memo.kind === 'burn') {
      const verdict = verifyBurnTx(tx, {
        mint: this.opts.coinMint,
        tokenProgram: this.opts.tokenProgram,
        burnRaw: BigInt(round.burn_raw),
      })
      if (!verdict.ok) return this.reject(signature, verdict.reason)
      await db.query(
        `INSERT INTO burns (signature, kind, round_id, wallet, slot, block_index, commitment, result, usd_value)
         VALUES ($1, 'burn', $2, $3, $4, $5, 'confirmed', $6, $7) ON CONFLICT DO NOTHING`,
        [
          signature,
          memo.roundId,
          verdict.wallet,
          tx.slot,
          await this.blockIndex(tx.slot, signature),
          closed ? 'late' : 'pending',
          this.opts.burnUsd?.() ?? null,
        ],
      )
      return 'counted'
    }

    // A voucher only spends if the round can still use it.
    if (closed) return this.reject(signature, 'round_closed')
    const verdict = verifyVoucherTx(tx)
    if (!verdict.ok) return this.reject(signature, verdict.reason)

    return db.tx(async (q) => {
      const claimed = await q.query(
        `UPDATE vouchers SET redeemed_sig = $1, redeemed_round = $2
         WHERE origin_sig = $3 AND wallet = $4 AND redeemed_sig IS NULL RETURNING origin_sig`,
        [signature, memo.roundId, memo.originSig, verdict.wallet],
      )
      if (claimed.length === 0) {
        await q.query(`INSERT INTO rejected_sigs (signature, reason) VALUES ($1, 'voucher_unavailable') ON CONFLICT DO NOTHING`, [signature])
        return 'rejected' as const
      }
      await q.query(
        `INSERT INTO burns (signature, kind, round_id, wallet, slot, block_index, origin_sig, commitment)
         VALUES ($1, 'voucher', $2, $3, $4, $5, $6, 'confirmed') ON CONFLICT DO NOTHING`,
        [signature, memo.roundId, verdict.wallet, tx.slot, await this.blockIndex(tx.slot, signature), memo.originSig],
      )
      return 'counted' as const
    })
  }

  private async reject(signature: string, reason: string): Promise<IngestResult> {
    await this.opts.db.query(
      `INSERT INTO rejected_sigs (signature, reason) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [signature, reason],
    )
    return 'rejected'
  }

  private async blockIndex(slot: number, signature: string): Promise<number> {
    try {
      return await this.opts.chain.blockIndexOf(slot, signature)
    } catch {
      return 0 // Corrected when the burn is finalized.
    }
  }

  /**
   * One sweep of the chain. The finalized slot is read first, so everything
   * below it has been seen by the time `indexed_through` is saved. Rounds wait
   * on that value, so a burn can't be missed by a slow poll.
   */
  async poll(): Promise<void> {
    const { db, chain } = this.opts
    const finalizedBefore = await chain.finalizedSlot()

    for (const address of this.sources) {
      const name = `sig:${address}`
      const [saved] = await db.query(`SELECT value FROM checkpoints WHERE name = $1`, [name])
      const signatures = await chain.memoSignatures(address, saved?.value ?? null)
      for (const signature of signatures) await this.ingest(signature)
      const newest = signatures.at(-1)
      if (newest) await this.saveCheckpoint(name, newest)
    }

    await this.settleCommitments(finalizedBefore)
    await this.saveCheckpoint('indexed_through', String(finalizedBefore))
  }

  /** Upgrades burns to finalized, or marks the ones that vanished. */
  private async settleCommitments(finalized: number): Promise<void> {
    const { db, chain, log } = this.opts
    const open = await db.query(
      `SELECT signature, slot, kind, origin_sig FROM burns WHERE commitment = 'confirmed' AND slot <= $1`,
      [finalized],
    )
    for (const burn of open) {
      const tx = await chain.getParsedTx(burn.signature, 'finalized')
      if (tx && !tx.meta?.err) {
        await db.query(`UPDATE burns SET commitment = 'finalized', block_index = $2 WHERE signature = $1`, [
          burn.signature,
          await this.blockIndex(burn.slot, burn.signature),
        ])
      } else if (finalized - burn.slot > DROP_AFTER_SLOTS) {
        log.warn('burn dropped before finalizing', burn.signature)
        await db.tx(async (q) => {
          await q.query(`UPDATE burns SET commitment = 'dropped' WHERE signature = $1`, [burn.signature])
          if (burn.kind === 'voucher') {
            await q.query(`UPDATE vouchers SET redeemed_sig = NULL, redeemed_round = NULL WHERE redeemed_sig = $1`, [burn.signature])
          }
        })
      }
    }
  }

  private async saveCheckpoint(name: string, value: string): Promise<void> {
    await this.opts.db.query(
      `INSERT INTO checkpoints (name, value) VALUES ($1, $2)
       ON CONFLICT (name) DO UPDATE SET value = $2, updated_at = now()`,
      [name, value],
    )
  }

  /** Live stream on top of polling, purely for speed. */
  start(onBurn: () => void): void {
    for (const address of this.sources) {
      this.opts.chain.watchMemos(address, (signature) => {
        this.ingest(signature)
          .then((result) => {
            if (result === 'counted') onBurn()
          })
          .catch((err) => this.opts.log.warn('ingest failed', err))
      })
    }
  }
}

export { MEMO_PREFIX }

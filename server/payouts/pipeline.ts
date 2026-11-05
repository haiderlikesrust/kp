import type { AssetInfo, Chain } from '../chain/types.ts'
import type { Db, Row } from '../db/index.ts'
import type { Log } from '../log.ts'

const BATCH = 4
const MAX_ATTEMPTS = 8

/**
 * Delivers cards one row at a time:
 *
 *   waiting -> queued -> signed -> sent -> delivered   (or stuck)
 *
 * The chain is the source of truth for whether a card has moved. Each pass
 * starts by asking who owns it, so a crash at any point resumes safely: a card
 * already with its recipient is simply marked delivered.
 */
export class PayoutPipeline {
  constructor(private opts: { db: Db; chain: Chain; log: Log }) {}

  async step(): Promise<void> {
    const rows = await this.opts.db.query(
      `SELECT p.*, c.nft FROM payouts p JOIN cards c ON c.rip_sig = p.rip_sig
       WHERE p.state IN ('queued', 'signed', 'sent') ORDER BY p.updated_at LIMIT $1`,
      [BATCH],
    )
    await Promise.allSettled(rows.map((row) => this.advance(row).catch((err) => this.failed(row, err))))
  }

  private async advance(row: Row): Promise<void> {
    const { chain } = this.opts
    const asset = await chain.asset(row.nft)
    if (!asset) throw new Error('asset not found')

    if (asset.owner === row.recipient) return this.mark(row, 'delivered')
    if (asset.owner !== chain.devAddress) {
      // Should be impossible, so treat it as serious and stop on this card.
      this.opts.log.alert('card left the dev wallet unexpectedly', `${row.nft} -> ${asset.owner}`)
      return this.mark(row, 'stuck', 'owner is neither dev wallet nor recipient')
    }

    if (row.state === 'queued') return this.sign(row, asset)

    const status = await chain.signatureStatus(row.signature)
    if (status === 'confirmed' || status === 'finalized') return // Owner check above finishes it.
    if (status === 'failed' || (await chain.blockhashExpired(row.signed_tx))) {
      return this.retry(row, status === 'failed' ? 'transfer failed' : 'transfer expired')
    }
    await chain.sendRaw(row.signed_tx)
    await this.mark(row, 'sent')
  }

  private async sign(row: Row, asset: AssetInfo): Promise<void> {
    const { db, chain } = this.opts
    const { signedTx, signature } = await chain.buildCardTransfer(asset, row.recipient)
    await db.query(
      `UPDATE payouts SET state = 'signed', signed_tx = $2, signature = $3, updated_at = now() WHERE id = $1`,
      [row.id, signedTx, signature],
    )
    await chain.sendRaw(signedTx)
    await this.mark(row, 'sent')
  }

  private async mark(row: Row, state: string, error: string | null = null): Promise<void> {
    await this.opts.db.query(
      `UPDATE payouts SET state = $2, last_error = coalesce($3, last_error), updated_at = now() WHERE id = $1`,
      [row.id, state, error],
    )
  }

  private async retry(row: Row, reason: string): Promise<void> {
    if (row.attempts + 1 >= MAX_ATTEMPTS) {
      this.opts.log.alert('payout stuck', `${row.nft}: ${reason}`)
      await this.opts.db.query(
        `UPDATE payouts SET state = 'stuck', attempts = attempts + 1, last_error = $2, updated_at = now() WHERE id = $1`,
        [row.id, reason],
      )
      return
    }
    // Re-signing is safe: a stale copy fails once the dev wallet no longer owns the card.
    await this.opts.db.query(
      `UPDATE payouts SET state = 'queued', attempts = attempts + 1, signed_tx = NULL, signature = NULL,
       last_error = $2, updated_at = now() WHERE id = $1`,
      [row.id, reason],
    )
  }

  private async failed(row: Row, err: unknown): Promise<void> {
    const message = err instanceof Error ? err.message : String(err)
    this.opts.log.warn(`payout ${row.id}`, message)
    await this.retry(row, message)
  }
}

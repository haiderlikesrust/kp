import { PACK_TIERS, machineFor } from '../../shared/ladder.ts'
import type { Chain } from '../chain/types.ts'
import type { Db, Row } from '../db/index.ts'
import type { Log } from '../log.ts'
import { ProviderError, type PackProvider } from './provider.ts'
import { PackTxRejected, validatePackTx } from './validate.ts'

const WORKERS = 3
/** Their limit is 30 paid but unopened per wallet; stay clear of it. */
const MAX_UNOPENED = 25
const OPEN_ALERT_MS = 60 * 60 * 1000
/** Collector Crypt auto-refunds from 2h10m, on an hourly run. */
const REFUND_WINDOW_MS = 3.25 * 60 * 60 * 1000

export interface PipelineOptions {
  db: Db
  chain: Chain
  provider: PackProvider
  log: Log
  usdcMint: string
  gachaUsdcAccount: string
  /** Stops all spending. Used when something looks wrong. */
  pause(reason: string): Promise<void>
  /** Called when no machine at all can fill a counted rip. */
  onOrderFailed(order: Row): Promise<void>
}

/**
 * Buys and opens one pack per counted rip. Each row is a small state machine,
 * and every step is saved before the next one starts, so a crash can only ever
 * resume, never pay twice:
 *
 *   queued -> generated -> signed -> paid -> opened
 *
 * The rule that protects the money: an order gets a new memo (and so a new
 * payment) only once its old transaction has provably died.
 */
export class PackPipeline {
  private alerted = new Set<string>()

  constructor(private opts: PipelineOptions) {}

  async step(): Promise<void> {
    const { db } = this.opts
    const [{ unopened }] = (await db.query(
      `SELECT count(*)::int AS unopened FROM pack_orders WHERE state IN ('signed', 'paid')`,
    )) as [{ unopened: number }]
    const rows = await db.query(
      `SELECT * FROM pack_orders WHERE state IN ('queued', 'generated', 'signed', 'paid')
       ORDER BY CASE state WHEN 'paid' THEN 0 WHEN 'signed' THEN 1 ELSE 2 END, updated_at
       LIMIT $1`,
      [WORKERS],
    )
    let room = MAX_UNOPENED - unopened
    const work = rows.filter((row) => {
      if (row.state !== 'queued' && row.state !== 'generated') return true
      room -= 1
      return room >= 0
    })
    const results = await Promise.allSettled(work.map((order) => this.advance(order)))
    for (const [index, result] of results.entries()) {
      if (result.status === 'rejected') {
        const order = work[index] as Row
        await this.noteError(order, result.reason)
      }
    }
  }

  private async noteError(order: Row, err: unknown): Promise<void> {
    const message = err instanceof Error ? err.message : String(err)
    this.opts.log.warn(`pack order ${order.rip_sig.slice(0, 8)} ${order.state}`, message)
    await this.opts.db.query(
      `UPDATE pack_orders SET last_error = $2, updated_at = now() WHERE rip_sig = $1`,
      [order.rip_sig, message],
    )
  }

  private advance(order: Row): Promise<void> {
    switch (order.state) {
      case 'queued':
      case 'generated':
        return this.buy(order)
      case 'signed':
        return this.settlePayment(order)
      default:
        return this.open(order)
    }
  }

  private async buy(order: Row): Promise<void> {
    const { db, chain, provider, usdcMint, gachaUsdcAccount } = this.opts
    let pack: { memo: string; transaction: string }
    try {
      pack = await provider.generatePack({ player: chain.devAddress, packType: order.machine })
    } catch (err) {
      if (err instanceof ProviderError && err.machineUnavailable) return this.stepDown(order, err.message)
      throw err
    }
    await db.query(
      `UPDATE pack_orders SET state = 'generated', memo = $2, updated_at = now() WHERE rip_sig = $1`,
      [order.rip_sig, pack.memo],
    )

    try {
      validatePackTx(pack.transaction, {
        player: chain.devAddress,
        price: order.price,
        memo: pack.memo,
        usdcMint,
        gachaUsdcAccount,
      })
    } catch (err) {
      if (!(err instanceof PackTxRejected)) throw err
      // Could be a price change or something worse. Either way, stop paying.
      await this.opts.pause(`pack transaction rejected: ${err.message}`)
      throw err
    }

    const { signedTx, signature } = chain.signProviderTx(pack.transaction)
    await db.query(
      `UPDATE pack_orders SET state = 'signed', signed_tx = $2, pay_sig = $3, updated_at = now() WHERE rip_sig = $1`,
      [order.rip_sig, signedTx, signature],
    )
    // A lost response is fine: settlePayment checks the chain, not this call.
    await provider.submit(signedTx).catch((err) => this.noteError({ ...order, state: 'signed' }, err))
  }

  private async settlePayment(order: Row): Promise<void> {
    const { db, chain, provider } = this.opts
    // Read expiry first. If it was still valid here, a missing status below
    // proves nothing, so we resend rather than buy again.
    const expired = await chain.blockhashExpired(order.signed_tx)
    const status = await chain.signatureStatus(order.pay_sig)

    if (status === 'confirmed' || status === 'finalized') {
      await db.tx(async (q) => {
        await q.query(`UPDATE pack_orders SET state = 'paid', paid_at = now(), updated_at = now() WHERE rip_sig = $1`, [order.rip_sig])
        await q.query(
          `INSERT INTO ledger (ref, kind, usd_micro, detail) VALUES ($1, 'pack', $2, $3) ON CONFLICT DO NOTHING`,
          [`pack:${order.pay_sig}`, String(-BigInt(order.price) * 1_000_000n), order.machine],
        )
      })
      return
    }
    if (status === 'failed' || expired) return this.requeue(order, status === 'failed' ? 'payment failed' : 'payment expired')
    await provider.submit(order.signed_tx)
  }

  private async requeue(order: Row, reason: string): Promise<void> {
    await this.opts.db.query(
      `UPDATE pack_orders SET state = 'queued', attempt = attempt + 1, memo = NULL, signed_tx = NULL,
       pay_sig = NULL, paid_at = NULL, last_error = $2, updated_at = now() WHERE rip_sig = $1`,
      [order.rip_sig, reason],
    )
  }

  private async open(order: Row): Promise<void> {
    const { db, chain, provider, log } = this.opts
    const result = await provider.open(order.memo)
    if (result.kind === 'waiting') {
      const age = Date.now() - new Date(order.paid_at).getTime()
      if (age > OPEN_ALERT_MS && !this.alerted.has(order.rip_sig)) {
        this.alerted.add(order.rip_sig)
        log.alert('paid pack still unopened after an hour', order.memo)
      }
      if (age > REFUND_WINDOW_MS) await this.requeue(order, 'refund window passed')
      return
    }

    const { card } = result
    const asset = await chain.asset(card.nft)
    if (asset?.owner !== chain.devAddress) {
      // DAS can lag the transfer. The memo returns the same card next time.
      throw new Error(`card ${card.nft} not in dev wallet yet`)
    }
    await db.tx(async (q) => {
      await q.query(
        `INSERT INTO cards (nft, round_id, rip_sig, name, image, rarity, insured_value, interface)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING`,
        [
          card.nft,
          order.round_id,
          order.rip_sig,
          card.name ?? asset.name ?? 'Graded card',
          card.image ?? asset.image,
          card.rarity,
          card.insuredValue ?? asset.insuredValue,
          asset.interface,
        ],
      )
      await q.query(`UPDATE pack_orders SET state = 'opened', updated_at = now() WHERE rip_sig = $1`, [order.rip_sig])
    })
  }

  /** The machine can't sell: try the next cheaper pack, or give up on this rip. */
  private async stepDown(order: Row, reason: string): Promise<void> {
    const { db, provider, log } = this.opts
    const machines = await provider.machines()
    const usable = new Set(machines.filter((m) => m.open && m.stock > 0).map((m) => m.price))
    const next = PACK_TIERS.map((tier) => tier.price as number)
      .filter((price) => price < order.price && usable.has(price))
      .pop()

    if (next === undefined) {
      log.alert('no machine can fill a rip', `${order.machine}: ${reason}`)
      await db.query(
        `UPDATE pack_orders SET state = 'failed', last_error = $2, updated_at = now() WHERE rip_sig = $1`,
        [order.rip_sig, reason],
      )
      await this.opts.onOrderFailed(order)
      return
    }
    log.warn(`${order.machine} unavailable, using $${next}`, reason)
    await db.query(
      `UPDATE pack_orders SET state = 'queued', price = $2, machine = $3, memo = NULL, updated_at = now() WHERE rip_sig = $1`,
      [order.rip_sig, next, machineFor(next)],
    )
  }

  /** On boot: anything half done just resumes through step(), nothing to redo. */
  async pendingCount(): Promise<number> {
    const [row] = await this.opts.db.query(
      `SELECT count(*)::int AS pending FROM pack_orders WHERE state NOT IN ('opened', 'failed')`,
    )
    return row?.pending ?? 0
  }
}

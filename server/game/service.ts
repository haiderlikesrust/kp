import { randomBytes } from 'node:crypto'
import { commitHash, pickDrop, shuffleLineup } from '../../shared/fairness.ts'
import { LADDER, MIN_TREASURY, expandStep, fitToStock, machineFor, pickStep } from '../../shared/ladder.ts'
import { RULES } from '../../shared/rules.ts'
import type { Chain } from '../chain/types.ts'
import type { Db, Queryable, Row } from '../db/index.ts'
import { reduceRound, type FiredDrop, type RipEvent, type RoundResult } from '../engine/reducer.ts'
import type { Log } from '../log.ts'
import type { PackProvider } from '../packs/provider.ts'

export interface GameOptions {
  db: Db
  chain: Chain
  provider: PackProvider
  log: Log
  burnRaw: bigint
  resolveHintMs: number
  roundGapSlots: number
}

const ACTIVE = new Set(['open', 'live', 'cutoff'])

export const toUsd = (micro: bigint): number => Number(micro / 10_000n) / 100

/**
 * Carries out what the reducer decides: opens rounds, creates pack orders,
 * resolves drops and hands the pot to the winner. It never decides anything
 * about the game itself.
 */
export class Game {
  constructor(private opts: GameOptions) {}

  async isPaused(): Promise<boolean> {
    const [row] = await this.opts.db.query(`SELECT value FROM settings WHERE key = 'paused'`)
    return row?.value === '1'
  }

  async setPaused(paused: boolean, reason = ''): Promise<void> {
    const { db, log } = this.opts
    await db.query(
      `INSERT INTO settings (key, value) VALUES ('paused', $1) ON CONFLICT (key) DO UPDATE SET value = $1`,
      [paused ? '1' : '0'],
    )
    if (paused) log.alert('game paused', reason)
  }

  async currentRound(): Promise<Row | null> {
    const [round] = await this.opts.db.query(`SELECT * FROM rounds WHERE status <> 'settled' ORDER BY id DESC LIMIT 1`)
    return round ?? null
  }

  async tick(): Promise<void> {
    const { chain } = this.opts
    const slot = await chain.slot()
    await this.issueVouchers()

    const round = await this.currentRound()
    if (!round) return this.maybeOpenRound(slot)
    if (round.status === 'sized') return this.publishCommit(round, slot)
    await this.syncPayouts(round.id)
    if (ACTIVE.has(round.status)) return this.applyChain(round, slot, await chain.finalizedSlot())
    return this.finishDelivery(round, slot)
  }

  // ---- Opening a round ----

  async availableUsd(): Promise<number> {
    const { db, chain } = this.opts
    const [row] = await db.query(`SELECT coalesce(sum(usd_micro::numeric), 0)::text AS reserved FROM reservations`)
    return toUsd((await chain.usdcMicro()) - BigInt(row?.reserved ?? '0'))
  }

  private async maybeOpenRound(slot: number): Promise<void> {
    const { db, chain, provider, log, burnRaw, roundGapSlots } = this.opts
    if (await this.isPaused()) return

    const [last] = await db.query(`SELECT id, settled_slot FROM rounds ORDER BY id DESC LIMIT 1`)
    if (last?.settled_slot && slot < last.settled_slot + roundGapSlots) return

    const step = pickStep(await this.availableUsd())
    if (!step) return

    const machines = await provider.machines()
    const stock = new Map<number, number>()
    for (const machine of machines) {
      if (machine.open) stock.set(machine.price, machine.stock)
    }
    const prices = fitToStock(expandStep(step), stock)
    if (prices.length === 0) {
      log.warn('no machine has stock for a round')
      return
    }

    const neededLamports = BigInt(Math.ceil((RULES.solFloor + prices.length * RULES.solPerCard) * 1e9))
    if ((await chain.lamports()) < neededLamports) {
      log.warn('not enough SOL to deliver a round yet')
      return
    }

    const id = (last?.id ?? 0) + 1
    const secret = randomBytes(32).toString('hex')
    const lineup = shuffleLineup(prices, secret, id)
    const cost = lineup.reduce((sum, price) => sum + BigInt(price) * 1_000_000n, 0n)

    await db.tx(async (q) => {
      await q.query(
        `INSERT INTO rounds (id, status, burn_raw, packs_total, secret, commit_hash) VALUES ($1, 'sized', $2, $3, $4, $5)`,
        [id, burnRaw.toString(), lineup.length, secret, commitHash(secret)],
      )
      for (const [position, price] of lineup.entries()) {
        await q.query(`INSERT INTO lineup_slots (round_id, position, price) VALUES ($1, $2, $3)`, [id, position, price])
      }
      await q.query(`INSERT INTO reservations (round_id, usd_micro) VALUES ($1, $2)`, [id, cost.toString()])
    })
    log.info(`round ${id} sized: ${lineup.length} packs, $${toUsd(cost)}`)
  }

  /** Publishes the secret's hash on-chain before anyone can rip. */
  private async publishCommit(round: Row, slot: number): Promise<void> {
    const { db, chain, log } = this.opts
    const signature = round.commit_sig ?? (await chain.sendMemo(`keepripping:v1:commit:${round.id}:${round.commit_hash}`))
    await db.query(`UPDATE rounds SET status = 'open', commit_sig = $2, open_slot = $3 WHERE id = $1`, [
      round.id,
      signature,
      slot,
    ])
    log.info(`round ${round.id} open`)
  }

  // ---- Running a round ----

  private async dropPicks(roundId: number): Promise<Map<number, string[]>> {
    const rows = await this.opts.db.query(`SELECT idx, picks FROM sweeps WHERE round_id = $1 AND picks IS NOT NULL`, [roundId])
    return new Map(rows.map((row) => [row.idx as number, JSON.parse(row.picks) as string[]]))
  }

  async roundEvents(roundId: number, q: Queryable = this.opts.db): Promise<(RipEvent & { commitment: string })[]> {
    const rows = await q.query(
      `SELECT signature, wallet, slot, block_index, kind, commitment FROM burns
       WHERE round_id = $1 AND commitment <> 'dropped'`,
      [roundId],
    )
    return rows.map((row) => ({
      signature: row.signature,
      wallet: row.wallet,
      slot: row.slot,
      blockIndex: row.block_index,
      kind: row.kind,
      commitment: row.commitment,
    }))
  }

  async computeRound(round: Row, slot: number): Promise<{ result: RoundResult; events: (RipEvent & { commitment: string })[]; picks: Map<number, string[]> }> {
    const [events, picks] = await Promise.all([this.roundEvents(round.id), this.dropPicks(round.id)])
    return {
      events,
      picks,
      result: reduceRound({ packsTotal: round.packs_total, events, currentSlot: slot, dropPicks: picks }),
    }
  }

  private async applyChain(round: Row, slot: number, finalized: number): Promise<void> {
    const { db } = this.opts
    const { result, events, picks } = await this.computeRound(round, slot)

    await db.tx(async (q) => {
      await q.query(
        `UPDATE rounds SET status = $2, first_slot = $3, deadline_slot = $4, end_reason = $5,
         cutoff_at = CASE WHEN $2 = 'cutoff' THEN coalesce(cutoff_at, now()) ELSE NULL END WHERE id = $1`,
        [round.id, result.status, result.firstSlot, result.deadlineSlot, result.endReason],
      )
      await q.query(`UPDATE burns SET result = 'counted' WHERE signature = ANY($1::text[])`, [result.counted.map((rip) => rip.signature)])
      await q.query(`UPDATE burns SET result = 'late' WHERE signature = ANY($1::text[])`, [result.late.map((rip) => rip.signature)])
      await this.createPackOrders(q, round.id, result.counted)
    })

    const nextDrop = result.drops[picks.size]
    if (nextDrop) await this.resolveDrop(round, nextDrop, events, finalized)
    if (result.status === 'cutoff' && result.drops.length === picks.size) {
      await this.maybeResolve(round, result, events, finalized)
    }
  }

  /** Every counted rip gets the next pack in the lineup, once. */
  private async createPackOrders(q: Queryable, roundId: number, counted: RipEvent[]): Promise<void> {
    const rows = await q.query(`SELECT rip_sig FROM pack_orders WHERE round_id = $1`, [roundId])
    const existing = new Set(rows.map((row) => row.rip_sig))
    for (const rip of counted) {
      if (existing.has(rip.signature)) continue
      const [slot] = await q.query(
        `UPDATE lineup_slots SET rip_sig = $1
         WHERE round_id = $2 AND position = (SELECT min(position) FROM lineup_slots WHERE round_id = $2 AND rip_sig IS NULL)
         RETURNING position, price`,
        [rip.signature, roundId],
      )
      if (!slot) continue
      await q.query(
        `INSERT INTO pack_orders (rip_sig, round_id, position, price, machine, state) VALUES ($1, $2, $3, $4, $5, 'queued')`,
        [rip.signature, roundId, slot.position, slot.price, machineFor(slot.price)],
      )
    }
  }

  private async indexedThrough(): Promise<number> {
    const [row] = await this.opts.db.query(`SELECT value FROM checkpoints WHERE name = 'indexed_through'`)
    return row ? Number(row.value) : 0
  }

  private async chainSettled(events: { slot: number; commitment: string }[], throughSlot: number): Promise<boolean> {
    if ((await this.indexedThrough()) < throughSlot) return false
    return events.every((event) => event.slot > throughSlot || event.commitment === 'finalized')
  }

  private async resolveDrop(round: Row, drop: FiredDrop, events: { slot: number; commitment: string }[], finalized: number): Promise<void> {
    const { db, chain, log } = this.opts
    const seedFrom = drop.slot + RULES.dropSeedDelaySlots
    if (finalized < seedFrom || !(await this.chainSettled(events, drop.slot))) return
    const block = await chain.finalizedBlockhashFrom(seedFrom)
    if (!block) return

    const count = Math.min(RULES.dropSize, drop.ranked.length, drop.pool.length)
    const picks = pickDrop(drop.pool, count, round.secret, block.blockhash, round.id, drop.index)

    await db.tx(async (q) => {
      await q.query(
        `INSERT INTO sweeps (round_id, idx, slot, ranked, pool, blockhash, seed_slot, picks)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING`,
        [round.id, drop.index, drop.slot, JSON.stringify(drop.ranked), JSON.stringify(drop.pool), block.blockhash, block.slot, JSON.stringify(picks)],
      )
      for (const [index, ripSig] of picks.entries()) {
        await q.query(
          `INSERT INTO payouts (rip_sig, round_id, recipient, reason, state) VALUES ($1, $2, $3, 'drop', 'waiting')
           ON CONFLICT (rip_sig) DO NOTHING`,
          [ripSig, round.id, drop.ranked[index]],
        )
      }
    })
    log.info(`round ${round.id} drop ${drop.index}: ${picks.length} cards`)
  }

  private async maybeResolve(round: Row, result: RoundResult, events: { slot: number; commitment: string }[], finalized: number): Promise<void> {
    const { db, log, resolveHintMs } = this.opts
    const cutoffSlot = result.endReason === 'sold_out' ? (result.counted.at(-1)?.slot ?? 0) : (result.deadlineSlot ?? 0)
    if (finalized < cutoffSlot || !(await this.chainSettled(events, cutoffSlot))) return

    const [fresh] = await db.query(`SELECT cutoff_at FROM rounds WHERE id = $1`, [round.id])
    const waited = Date.now() - new Date(fresh?.cutoff_at).getTime()
    if (waited < resolveHintMs) return

    await db.tx(async (q) => {
      await q.query(`UPDATE rounds SET status = 'resolved', winner = $2 WHERE id = $1`, [round.id, result.lastRipper])
      // Everything not already dropped goes to the winner, including any pack
      // bought for a rip that a reorg later removed.
      const orders = await q.query(`SELECT rip_sig FROM pack_orders WHERE round_id = $1`, [round.id])
      for (const order of orders) {
        await q.query(
          `INSERT INTO payouts (rip_sig, round_id, recipient, reason, state) VALUES ($1, $2, $3, 'win', 'waiting')
           ON CONFLICT (rip_sig) DO NOTHING`,
          [order.rip_sig, round.id, result.lastRipper],
        )
      }
    })
    log.info(`round ${round.id} won by ${result.lastRipper} (${result.endReason})`)
  }

  // ---- After the round ----

  /** Makes cards deliverable as they arrive, and clears rips that got no card. */
  private async syncPayouts(roundId: number): Promise<void> {
    const { db } = this.opts
    await db.query(
      `UPDATE payouts p SET state = 'queued', updated_at = now() FROM cards c
       WHERE p.round_id = $1 AND p.state = 'waiting' AND c.rip_sig = p.rip_sig`,
      [roundId],
    )
    await db.query(
      `DELETE FROM payouts p USING pack_orders o
       WHERE p.round_id = $1 AND p.state = 'waiting' AND o.rip_sig = p.rip_sig AND o.state = 'failed'`,
      [roundId],
    )
  }

  private async finishDelivery(round: Row, slot: number): Promise<void> {
    const { db, log } = this.opts
    await this.syncPayouts(round.id)
    const [progress] = await db.query(
      `SELECT
         (SELECT count(*)::int FROM pack_orders WHERE round_id = $1 AND state NOT IN ('opened', 'failed')) AS unopened,
         (SELECT count(*)::int FROM payouts WHERE round_id = $1 AND state NOT IN ('delivered', 'stuck')) AS undelivered,
         (SELECT count(*)::int FROM payouts WHERE round_id = $1 AND state = 'stuck') AS stuck`,
      [round.id],
    )
    if ((progress?.unopened ?? 0) > 0 || (progress?.undelivered ?? 0) > 0) {
      if (round.status === 'resolved') await db.query(`UPDATE rounds SET status = 'delivering' WHERE id = $1`, [round.id])
      return
    }
    await db.tx(async (q) => {
      await q.query(`UPDATE rounds SET status = 'settled', settled_slot = $2, settled_at = now() WHERE id = $1`, [round.id, slot])
      await q.query(`DELETE FROM reservations WHERE round_id = $1`, [round.id])
    })
    if ((progress?.stuck ?? 0) > 0) log.alert(`round ${round.id} settled with ${progress?.stuck} stuck cards`)
    log.info(`round ${round.id} settled`)
  }

  /**
   * Late burns become vouchers once they are final and the round is decided.
   * Late redemptions hand the voucher back instead, since nothing was used.
   */
  private async issueVouchers(): Promise<void> {
    const { db } = this.opts
    const late = await db.query(
      `SELECT b.signature, b.wallet, b.round_id, b.kind FROM burns b
       JOIN rounds r ON r.id = b.round_id
       LEFT JOIN vouchers v ON v.origin_sig = b.signature
       WHERE b.result = 'late' AND b.commitment = 'finalized' AND v.origin_sig IS NULL
         AND r.status IN ('resolved', 'delivering', 'settled')`,
    )
    for (const burn of late) {
      if (burn.kind === 'burn') {
        await db.query(
          `INSERT INTO vouchers (origin_sig, wallet, reason, created_round) VALUES ($1, $2, 'late', $3) ON CONFLICT DO NOTHING`,
          [burn.signature, burn.wallet, burn.round_id],
        )
      } else {
        await db.tx(async (q) => {
          await q.query(`UPDATE vouchers SET redeemed_sig = NULL, redeemed_round = NULL WHERE redeemed_sig = $1`, [burn.signature])
          await q.query(`UPDATE burns SET result = 'released' WHERE signature = $1`, [burn.signature])
        })
      }
    }
  }

  /** No machine can fill this rip: its holder gets a voucher and the round ends. */
  async orderFailed(order: Row): Promise<void> {
    await this.opts.db.tx(async (q) => {
      const [burn] = await q.query(`SELECT wallet FROM burns WHERE signature = $1`, [order.rip_sig])
      if (burn) {
        await q.query(
          `INSERT INTO vouchers (origin_sig, wallet, reason, created_round) VALUES ($1, $2, 'no_pack', $3) ON CONFLICT DO NOTHING`,
          [order.rip_sig, burn.wallet, order.round_id],
        )
      }
      // Shrinking supply to what was ripped makes the reducer call it sold out.
      await q.query(
        `UPDATE rounds SET packs_total = (SELECT count(*) FROM pack_orders WHERE round_id = $1)
         WHERE id = $1 AND status IN ('open', 'live', 'cutoff')`,
        [order.round_id],
      )
    })
  }
}

export { LADDER, MIN_TREASURY }

import type {
  CardView,
  DropView,
  GameState,
  Rarity,
  RipView,
  RoundProof,
  RoundStatus,
  RoundSummary,
  RoundView,
  WalletView,
} from '../../shared/api.ts'
import { MIN_TREASURY } from '../../shared/ladder.ts'
import { slotsToSeconds } from '../../shared/rules.ts'
import { reduceRound } from '../engine/reducer.ts'
import type { Db, Row } from '../db/index.ts'
import type { Game } from './service.ts'
import { toUsd } from './service.ts'

const LIVE = new Set(['open', 'live', 'cutoff'])

function cardValue(card: Row): number {
  return Number(card.insured_value ?? card.price ?? 0)
}

async function cardRows(db: Db, roundId: number): Promise<Row[]> {
  return db.query(
    `SELECT c.*, o.price, b.wallet AS ripper, p.recipient, p.reason, p.state AS payout_state
     FROM cards c
     JOIN pack_orders o ON o.rip_sig = c.rip_sig
     LEFT JOIN burns b ON b.signature = c.rip_sig
     LEFT JOIN payouts p ON p.rip_sig = c.rip_sig
     WHERE c.round_id = $1 ORDER BY c.created_at`,
    [roundId],
  )
}

function toCardView(row: Row): CardView {
  return {
    nft: row.nft,
    name: row.name,
    image: row.image,
    rarity: row.rarity as Rarity | null,
    insuredValue: row.insured_value,
    packPrice: row.price,
    ripper: row.ripper ?? '',
    ripSig: row.rip_sig,
    recipient: row.recipient ?? null,
    reason: row.reason ?? null,
    delivered: row.payout_state === 'delivered',
  }
}

async function roundView(db: Db, game: Game, round: Row, slot: number, decimals: number): Promise<RoundView> {
  const [cards, orders, sweeps, lineup, burnRows] = await Promise.all([
    cardRows(db, round.id),
    db.query(`SELECT rip_sig, price, state FROM pack_orders WHERE round_id = $1`, [round.id]),
    db.query(`SELECT * FROM sweeps WHERE round_id = $1 ORDER BY idx`, [round.id]),
    db.query(`SELECT price, count(*)::int AS count FROM lineup_slots WHERE round_id = $1 GROUP BY price ORDER BY price`, [round.id]),
    db.query(`SELECT signature, kind, usd_value FROM burns WHERE round_id = $1 AND commitment <> 'dropped'`, [round.id]),
  ])
  const events = await game.roundEvents(round.id)
  const picks = new Map<number, string[]>(
    sweeps.filter((sweep) => sweep.picks).map((sweep) => [sweep.idx as number, JSON.parse(sweep.picks) as string[]]),
  )
  const result = reduceRound({ packsTotal: round.packs_total, events, currentSlot: slot, dropPicks: picks })
  const orderBySig = new Map(orders.map((order) => [order.rip_sig, order]))
  const tokensPerBurn = Number(BigInt(round.burn_raw) / 10n ** BigInt(decimals))
  const burnBySig = new Map(burnRows.map((burn) => [burn.signature, burn]))
  const realBurns = burnRows.filter((burn) => burn.kind === 'burn')

  const topBurners = result.windowRanking.map((entry) => {
    const mine = result.windowRips.filter((rip) => rip.wallet === entry.wallet && rip.kind === 'burn')
    return {
      ...entry,
      tokens: mine.length * tokensPerBurn,
      usd: mine.reduce((sum, rip) => sum + Number(burnBySig.get(rip.signature)?.usd_value ?? 0), 0),
    }
  })

  const rips: RipView[] = result.counted.map((rip) => {
    const order = orderBySig.get(rip.signature)
    return {
      signature: rip.signature,
      wallet: rip.wallet,
      slot: rip.slot,
      voucher: rip.kind === 'voucher',
      packPrice: order?.price ?? null,
      opened: order?.state === 'opened',
      addedSeconds: slotsToSeconds(result.added.get(rip.signature) ?? 0),
    }
  })

  const drops: DropView[] = result.drops.map((drop) => {
    const chosen = picks.get(drop.index)
    return {
      index: drop.index,
      slot: drop.slot,
      status: chosen ? 'picked' : 'waiting_seed',
      recipients: (chosen ?? []).map((ripSig, index) => ({ wallet: drop.ranked[index] ?? '', ripSig })),
    }
  })

  const live = LIVE.has(round.status)
  const swept = new Set([...picks.values()].flat())
  return {
    id: round.id,
    status: round.status as RoundStatus,
    packsTotal: round.packs_total,
    packsRipped: result.counted.length,
    firstSlot: result.firstSlot,
    deadlineSlot: result.deadlineSlot,
    nextDropSlot: result.nextDropSlot,
    lastRipper: result.lastRipper,
    winner: round.winner ?? null,
    endReason: result.endReason,
    commitHash: round.commit_hash,
    potUsd: cards.filter((card) => !swept.has(card.rip_sig)).reduce((sum, card) => sum + cardValue(card), 0),
    lineup: lineup.map((row) => ({ price: row.price, count: row.count })),
    rips,
    cards: cards.map(toCardView),
    drops,
    topBurners: live ? topBurners : [],
    undelivered: live ? 0 : cards.filter((card) => card.payout_state !== 'delivered').length,
    burnedTokens: realBurns.length * tokensPerBurn,
    burnedUsd: realBurns.reduce((sum, burn) => sum + Number(burn.usd_value ?? 0), 0),
    heat: { recentRips: result.heat.recentRips, nextAddSeconds: slotsToSeconds(result.heat.nextAddSlots) },
  }
}

export interface StateOptions {
  chain: { slot(): Promise<number>; usdcMicro(): Promise<bigint> }
  mode: GameState['mode']
  roundGapSlots: number
  decimals: number
  burnUsd(): number | null
}

export async function buildState(db: Db, game: Game, opts: StateOptions): Promise<GameState> {
  const { chain, mode, roundGapSlots, decimals } = opts
  const [slot, usdc, paused, current] = await Promise.all([chain.slot(), chain.usdcMicro(), game.isPaused(), game.currentRound()])

  const [burned] = await db.query(
    `SELECT coalesce(sum(r.burn_raw::numeric), 0)::text AS raw, coalesce(sum(b.usd_value), 0)::float AS usd
     FROM burns b JOIN rounds r ON r.id = b.round_id
     WHERE b.kind = 'burn' AND b.commitment <> 'dropped'`,
  )

  const [latest] = await db.query(`SELECT * FROM rounds WHERE status = 'settled' ORDER BY id DESC LIMIT 1`)
  let lastWin: GameState['lastWin'] = null
  if (latest?.winner) {
    const [totals] = await db.query(
      `SELECT count(*)::int AS cards, coalesce(sum(c.insured_value), 0)::float AS total
       FROM payouts p JOIN cards c ON c.rip_sig = p.rip_sig WHERE p.round_id = $1 AND p.reason = 'win'`,
      [latest.id],
    )
    lastWin = { roundId: latest.id, winner: latest.winner, cards: totals?.cards ?? 0, potUsd: totals?.total ?? 0 }
  }

  return {
    mode,
    paused,
    serverSlot: slot,
    treasuryUsd: toUsd(usdc),
    nextRoundSlot: !current && latest?.settled_slot ? Number(latest.settled_slot) + roundGapSlots : null,
    neededTreasuryUsd: MIN_TREASURY,
    burnUsd: opts.burnUsd(),
    burnedAllTime: {
      tokens: Number(BigInt(burned?.raw ?? '0') / 10n ** BigInt(decimals)),
      usd: burned?.usd ?? 0,
    },
    round: current ? await roundView(db, game, current, slot, decimals) : null,
    lastWin,
  }
}

export async function walletView(db: Db, wallet: string): Promise<WalletView> {
  const [vouchers, rips] = await Promise.all([
    db.query(
      `SELECT origin_sig, reason, created_at FROM vouchers WHERE wallet = $1 AND redeemed_sig IS NULL ORDER BY created_at`,
      [wallet],
    ),
    db.query(`SELECT count(*)::int AS n FROM burns WHERE wallet = $1 AND result = 'counted'`, [wallet]),
  ])
  return {
    wallet,
    vouchers: vouchers.map((row) => ({
      originSig: row.origin_sig,
      reason: row.reason,
      createdAt: new Date(row.created_at).toISOString(),
    })),
    rips: rips[0]?.n ?? 0,
  }
}

const SUMMARY = `
  SELECT r.id, r.status, r.winner, r.end_reason, r.packs_total, r.settled_at, r.commit_hash, r.commit_sig, r.secret,
    (SELECT count(*)::int FROM burns b WHERE b.round_id = r.id AND b.result = 'counted') AS ripped,
    (SELECT coalesce(sum(c.insured_value), 0)::float FROM cards c WHERE c.round_id = r.id) AS pot
  FROM rounds r`

function toSummary(row: Row): RoundSummary {
  return {
    id: row.id,
    status: row.status,
    winner: row.winner,
    endReason: row.end_reason,
    packsTotal: row.packs_total,
    packsRipped: row.ripped,
    potUsd: row.pot,
    settledAt: row.settled_at ? new Date(row.settled_at).toISOString() : null,
  }
}

export async function roundHistory(db: Db, limit = 50): Promise<RoundSummary[]> {
  const rows = await db.query(`${SUMMARY} WHERE r.status = 'settled' ORDER BY r.id DESC LIMIT $1`, [limit])
  return rows.map(toSummary)
}

/** Everything needed to re-check a round. The secret only appears once it's over. */
export async function roundProof(db: Db, id: number): Promise<RoundProof | null> {
  const [row] = await db.query(`${SUMMARY} WHERE r.id = $1`, [id])
  if (!row) return null
  const settled = row.status === 'settled'
  const [lineup, burns, sweeps, payouts] = await Promise.all([
    db.query(`SELECT price FROM lineup_slots WHERE round_id = $1 ORDER BY position`, [id]),
    db.query(
      `SELECT signature, wallet, slot, block_index, result FROM burns WHERE round_id = $1 AND commitment <> 'dropped'
       ORDER BY slot, block_index`,
      [id],
    ),
    db.query(`SELECT * FROM sweeps WHERE round_id = $1 ORDER BY idx`, [id]),
    db.query(
      `SELECT c.nft, p.recipient, p.signature, p.state, p.reason FROM payouts p
       LEFT JOIN cards c ON c.rip_sig = p.rip_sig WHERE p.round_id = $1 ORDER BY p.id`,
      [id],
    ),
  ])
  return {
    ...toSummary(row),
    commitHash: row.commit_hash,
    commitSig: row.commit_sig,
    secret: settled ? row.secret : null,
    lineup: settled ? lineup.map((slot) => slot.price) : [],
    burns: burns.map((burn) => ({
      signature: burn.signature,
      wallet: burn.wallet,
      slot: burn.slot,
      blockIndex: burn.block_index,
      result: burn.result,
    })),
    drops: sweeps.map((sweep) => ({
      index: sweep.idx,
      slot: sweep.slot,
      blockhash: sweep.blockhash,
      pool: JSON.parse(sweep.pool),
      picks: sweep.picks ? JSON.parse(sweep.picks) : [],
      recipients: JSON.parse(sweep.ranked),
    })),
    payouts: payouts.map((payout) => ({
      nft: payout.nft ?? null,
      recipient: payout.recipient,
      signature: payout.signature,
      state: payout.state,
      reason: payout.reason,
    })),
  }
}

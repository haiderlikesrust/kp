import { afterEach, describe, expect, it } from 'vitest'
import { commitHash, pickDrop, shuffleLineup } from '../shared/fairness.ts'
import { RULES } from '../shared/rules.ts'
import { makeWorld, wallet, type World } from './harness.ts'

let world: World
afterEach(async () => {
  await world?.db.close()
})

const usdc = (w: World) => Number(w.chain.usdc / 1_000_000n)

/** Rips with room between them, then cycles the indexer over each. */
async function rip(w: World, who: string, roundId: number, gap = 2) {
  const signature = w.chain.burn({ wallet: who, roundId })
  await w.cycle(gap)
  return signature
}

/** Runs the workers n times, one slot apart. `cycle(n)` jumps n slots in a single pass. */
async function passes(w: World, n: number) {
  for (let i = 0; i < n; i++) await w.cycle()
}

async function ownedBy(w: World, who: string) {
  return [...w.chain.assets.values()].filter((asset) => asset.owner === who)
}

function assertNoDoubleSends(w: World) {
  for (const count of w.chain.transferCount.values()) expect(count).toBe(1)
}

describe('a whole round', () => {
  it('pays the last ripper everything, then settles', async () => {
    world = await makeWorld({ usdc: 700 })
    const id = await world.openRound()
    const [a, b, c] = [wallet(), wallet(), wallet()]
    await rip(world, a, id)
    await rip(world, b, id)
    await rip(world, c, id)
    await world.cycle(150)
    await world.until(() => world.settled(id))

    const round = await world.round(id)
    expect(round.winner).toBe(c)
    expect(round.end_reason).toBe('timer')
    expect(await ownedBy(world, c)).toHaveLength(3)
    expect(await ownedBy(world, world.chain.devAddress)).toHaveLength(0)
    assertNoDoubleSends(world)
  })

  it('spends exactly the packs that were ripped and keeps the rest', async () => {
    world = await makeWorld({ usdc: 700 })
    const id = await world.openRound()
    for (let i = 0; i < 4; i++) await rip(world, wallet(), id)
    await world.cycle(150)
    await world.until(() => world.settled(id))
    expect(usdc(world)).toBe(700 - 4 * 25)
    const [{ total }] = (await world.db.query(`SELECT sum(usd_micro::numeric)::text AS total FROM ledger WHERE kind = 'pack'`)) as [{ total: string }]
    expect(BigInt(total)).toBe(-100n * 1_000_000n)
  })

  it('never buys a pack before someone rips', async () => {
    world = await makeWorld({ usdc: 700 })
    await world.openRound()
    await world.cycle(500)
    expect(world.chain.usdcSpent).toBe(0n)
  })

  it('sizes the round from the treasury ladder', async () => {
    world = await makeWorld({ usdc: 5_200 })
    const id = await world.openRound()
    expect((await world.round(id)).packs_total).toBe(83)
    expect(await world.count(`SELECT count(*)::int AS n FROM lineup_slots WHERE round_id = $1 AND price = 500`, [id])).toBe(1)
    expect(await world.count(`SELECT count(*)::int AS n FROM lineup_slots WHERE round_id = $1 AND price = 250`, [id])).toBe(2)
  })

  it('waits for funding below the lowest step', async () => {
    world = await makeWorld({ usdc: 90 })
    await world.cycle(50)
    expect(await world.count(`SELECT count(*)::int AS n FROM rounds`)).toBe(0)
    world.chain.usdc = 100n * 1_000_000n
    const id = await world.openRound()
    expect((await world.round(id)).packs_total).toBe(3)
  })

  it('waits for SOL to deliver the round', async () => {
    world = await makeWorld({ usdc: 700 })
    world.chain.sol = 10_000_000n
    await world.cycle(20)
    expect(await world.count(`SELECT count(*)::int AS n FROM rounds`)).toBe(0)
  })

  it('opens the next round straight after settling', async () => {
    world = await makeWorld({ usdc: 1_400 })
    const id = await world.openRound()
    await rip(world, wallet(), id)
    await world.cycle(150)
    await world.until(() => world.settled(id))
    const settledSlot = (await world.round(id)).settled_slot
    await world.cycle()
    await world.cycle()
    const [next] = await world.db.query(`SELECT id, status, open_slot FROM rounds ORDER BY id DESC LIMIT 1`)
    expect(next?.id).toBe(id + 1)
    expect(next?.status).toBe('open')
    expect(next?.open_slot - settledSlot).toBeLessThan(5)
  })

  it('still respects a gap when one is configured', async () => {
    world = await makeWorld({ usdc: 1_400, gapSlots: 100 })
    const id = await world.openRound()
    await rip(world, wallet(), id)
    await world.cycle(150)
    await world.until(() => world.settled(id))
    await world.cycle(50)
    expect(await world.count(`SELECT count(*)::int AS n FROM rounds`)).toBe(1)
    expect(await world.openRound()).toBe(id + 1)
  })

  it('publishes a commitment that matches the secret and lineup', async () => {
    world = await makeWorld({ usdc: 1_100 })
    const id = await world.openRound()
    const round = await world.round(id)
    expect(round.commit_sig).toBeTruthy()
    expect(commitHash(round.secret)).toBe(round.commit_hash)
    const rows = await world.db.query(`SELECT price FROM lineup_slots WHERE round_id = $1 ORDER BY position`, [id])
    const lineup = rows.map((row) => row.price)
    const unshuffled = [...lineup].sort((x, y) => x - y)
    expect(shuffleLineup(unshuffled, round.secret, id)).toEqual(lineup)
  })
})

describe('sold out', () => {
  it('ends at the last pack and pays that ripper', async () => {
    world = await makeWorld({ usdc: 700 })
    const id = await world.openRound()
    const last = wallet()
    for (let i = 0; i < 24; i++) await rip(world, wallet(), id, 1)
    await rip(world, last, id, 1)
    await world.cycle(40)
    await world.until(() => world.settled(id))
    const round = await world.round(id)
    expect(round.end_reason).toBe('sold_out')
    expect(round.winner).toBe(last)
    expect(await ownedBy(world, last)).toHaveLength(25)
    expect(usdc(world)).toBe(75)
  })
})

describe('vouchers', () => {
  it('turns a late burn into a free rip for a later round', async () => {
    world = await makeWorld({ usdc: 1_400 })
    const id = await world.openRound()
    const [early, unlucky] = [wallet(), wallet()]
    await rip(world, early, id)
    await world.cycle(RULES.startSlots + 2)
    const lateSig = world.chain.burn({ wallet: unlucky, roundId: id })
    await world.cycle(60)
    await world.until(() => world.settled(id))
    expect((await world.round(id)).winner).toBe(early)
    await world.cycle(40)

    const vouchers = await world.db.query(`SELECT * FROM vouchers WHERE wallet = $1`, [unlucky])
    expect(vouchers).toHaveLength(1)
    expect(vouchers[0]!.origin_sig).toBe(lateSig)

    const next = await world.openRound()
    world.chain.redeemVoucher({ wallet: unlucky, roundId: next, originSig: lateSig })
    await world.cycle(150)
    await world.until(() => world.settled(next))
    expect((await world.round(next)).winner).toBe(unlucky)
    const [voucher] = await world.db.query(`SELECT * FROM vouchers WHERE origin_sig = $1`, [lateSig])
    expect(voucher?.redeemed_round).toBe(next)
  })

  it('gives a voucher to a burn after sell-out', async () => {
    world = await makeWorld({ usdc: 700 })
    const id = await world.openRound()
    for (let i = 0; i < 25; i++) await rip(world, wallet(), id, 1)
    const extra = wallet()
    await rip(world, extra, id, 1)
    await world.cycle(40)
    await world.until(() => world.settled(id))
    await world.cycle(40)
    expect(await world.count(`SELECT count(*)::int AS n FROM vouchers WHERE wallet = $1`, [extra])).toBe(1)
    expect(usdc(world)).toBe(75)
  })

  it('stops a voucher being spent twice or by someone else', async () => {
    world = await makeWorld({ usdc: 1_400 })
    const id = await world.openRound()
    const holder = wallet()
    await rip(world, wallet(), id)
    await world.cycle(RULES.startSlots + 2)
    const origin = world.chain.burn({ wallet: holder, roundId: id })
    await world.cycle(60)
    await world.until(() => world.settled(id))
    await world.cycle(40)

    const next = await world.openRound()
    const thief = world.chain.redeemVoucher({ wallet: wallet(), roundId: next, originSig: origin })
    await world.cycle(2)
    expect(await world.count(`SELECT count(*)::int AS n FROM rejected_sigs WHERE signature = $1`, [thief])).toBe(1)

    world.chain.redeemVoucher({ wallet: holder, roundId: next, originSig: origin })
    await world.cycle(2)
    const again = world.chain.redeemVoucher({ wallet: holder, roundId: next, originSig: origin })
    await world.cycle(2)
    expect(await world.count(`SELECT count(*)::int AS n FROM rejected_sigs WHERE signature = $1`, [again])).toBe(1)
    expect(await world.count(`SELECT count(*)::int AS n FROM burns WHERE round_id = $1`, [next])).toBe(1)
  })

  it('gives a voucher back if its redemption lands too late', async () => {
    world = await makeWorld({ usdc: 2_000 })
    const id = await world.openRound()
    const holder = wallet()
    await rip(world, wallet(), id)
    await world.cycle(RULES.startSlots + 2)
    const origin = world.chain.burn({ wallet: holder, roundId: id })
    await world.cycle(60)
    await world.until(() => world.settled(id))
    await world.cycle(40)

    const next = await world.openRound()
    await rip(world, wallet(), next)
    await world.cycle(RULES.startSlots + 2)
    world.chain.redeemVoucher({ wallet: holder, roundId: next, originSig: origin })
    await world.cycle(60)
    await world.until(() => world.settled(next))
    await world.cycle(10)
    const [voucher] = await world.db.query(`SELECT redeemed_sig FROM vouchers WHERE origin_sig = $1`, [origin])
    expect(voucher?.redeemed_sig).toBeNull()
  })
})

describe('bad burns', () => {
  it('ignores spoofed burns entirely', async () => {
    world = await makeWorld({ usdc: 700 })
    const id = await world.openRound()
    const attacker = wallet()
    world.chain.burn({ wallet: attacker, roundId: id, amount: 1n })
    world.chain.burn({ wallet: attacker, roundId: id, mint: wallet() })
    world.chain.burn({ wallet: attacker, roundId: id, delegate: true })
    world.chain.burn({ wallet: attacker, roundId: id, failed: true })
    world.chain.burn({ wallet: attacker, roundId: id, memo: 'hello' })
    world.chain.burn({ wallet: attacker, roundId: 99 })
    await world.cycle(3)
    expect(await world.count(`SELECT count(*)::int AS n FROM burns`)).toBe(0)
    expect(await world.count(`SELECT count(*)::int AS n FROM rejected_sigs`)).toBe(6)
    expect((await world.round(id)).status).toBe('open')
    expect(world.chain.usdcSpent).toBe(0n)
  })

  it('counts a burn once, however many times it is posted', async () => {
    world = await makeWorld({ usdc: 700 })
    const id = await world.openRound()
    const signature = world.chain.burn({ wallet: wallet(), roundId: id })
    await Promise.all([world.indexer.ingest(signature), world.indexer.ingest(signature)])
    await world.indexer.ingest(signature)
    await world.cycle(2)
    expect(await world.count(`SELECT count(*)::int AS n FROM burns`)).toBe(1)
    expect(await world.count(`SELECT count(*)::int AS n FROM pack_orders`)).toBe(1)
  })

  it('does nothing for a signature that never landed', async () => {
    world = await makeWorld({ usdc: 700 })
    const id = await world.openRound()
    const first = wallet()
    await rip(world, first, id)
    expect(await world.indexer.ingest('neverLandedSignature')).toBe('pending')
    await world.cycle(RULES.startSlots + 1)
    expect((await world.round(id)).status).toBe('cutoff')
  })

  it('finds burns with no client hint, as if the tab was closed', async () => {
    world = await makeWorld({ usdc: 700 })
    const id = await world.openRound()
    const quiet = wallet()
    world.chain.burn({ wallet: quiet, roundId: id, delaySlots: 2 })
    await world.cycle(5)
    expect(await world.count(`SELECT count(*)::int AS n FROM burns WHERE wallet = $1`, [quiet])).toBe(1)
  })
})

describe('reorgs', () => {
  it('drops a confirmed burn that never finalized and picks the real winner', async () => {
    world = await makeWorld({ usdc: 700 })
    const id = await world.openRound()
    const real = wallet()
    await rip(world, real, id)
    const ghost = await rip(world, wallet(), id)
    world.chain.dropTx(ghost)
    await world.cycle(RULES.startSlots + 40)
    await world.cycle(80)
    await world.until(() => world.settled(id))
    expect((await world.round(id)).winner).toBe(real)
    // The pack already bought for the dropped burn stays in the pot.
    expect(await ownedBy(world, real)).toHaveLength(2)
  })
})

describe('5-minute drop', () => {
  /** A long round: 8 wallets ripping at the pace that holds the clock level. */
  async function longRound(w: World, id: number, rips: number) {
    const players = Array.from({ length: 8 }, () => wallet())
    for (let i = 0; i < rips; i++) {
      const who = players[Math.min(i % 12, 7)] as string
      w.chain.burn({ wallet: who, roundId: id })
      await w.cycle(13)
    }
    return players
  }

  it('sends 5 random cards to the top 5, and the rest to the winner', async () => {
    world = await makeWorld({ usdc: 5_200 })
    const id = await world.openRound()
    const players = await longRound(world, id, 62)
    await world.cycle(600)
    await world.until(() => world.settled(id))

    const [sweep] = await world.db.query(`SELECT * FROM sweeps WHERE round_id = $1`, [id])
    expect(sweep).toBeTruthy()
    const ranked = JSON.parse(sweep!.ranked) as string[]
    const picks = JSON.parse(sweep!.picks) as string[]
    expect(ranked).toHaveLength(5)
    expect(picks).toHaveLength(5)

    // Anyone can recompute the pick from what gets published.
    const round = await world.round(id)
    expect(pickDrop(JSON.parse(sweep!.pool), 5, round.secret, sweep!.blockhash, id, 0)).toEqual(picks)

    const drops = await world.db.query(`SELECT * FROM payouts WHERE round_id = $1 AND reason = 'drop'`, [id])
    expect(drops).toHaveLength(5)
    expect(new Set(drops.map((row) => row.recipient)).size).toBe(5)
    expect(drops.every((row) => row.state === 'delivered')).toBe(true)

    const wins = await world.db.query(`SELECT * FROM payouts WHERE round_id = $1 AND reason = 'win'`, [id])
    expect(wins).toHaveLength(57)
    expect(new Set(wins.map((row) => row.recipient))).toEqual(new Set([round.winner]))
    expect(players).toContain(round.winner)
    assertNoDoubleSends(world)
  })

  it('never pays a card twice when the drop winner also wins the round', async () => {
    world = await makeWorld({ usdc: 5_200 })
    const id = await world.openRound()
    const solo = wallet()
    for (let i = 0; i < 62; i++) {
      world.chain.burn({ wallet: solo, roundId: id })
      await world.cycle(13)
    }
    await world.cycle(600)
    await world.until(() => world.settled(id))
    expect(await ownedBy(world, solo)).toHaveLength(62)
    assertNoDoubleSends(world)
    expect(await world.count(`SELECT count(*)::int AS n FROM payouts WHERE reason = 'drop'`)).toBe(1)
  })
})

describe('crashes and bad responses', () => {
  it('does not pay twice when the submit response is lost', async () => {
    world = await makeWorld({ usdc: 700 })
    const id = await world.openRound()
    world.provider.dropSubmitResponses = 1
    world.chain.burn({ wallet: wallet(), roundId: id })
    await passes(world, 10)
    expect(world.provider.dropSubmitResponses).toBe(0)
    expect(world.chain.usdcSpent).toBe(25_000_000n)
    expect(world.provider.generateCalls).toBe(1)
    expect(await world.count(`SELECT count(*)::int AS n FROM cards`)).toBe(1)
  })

  it('resumes after a crash at every pack state without paying twice', async () => {
    world = await makeWorld({ usdc: 700 })
    const id = await world.openRound()
    world.chain.burn({ wallet: wallet(), roundId: id })
    for (let i = 0; i < 20; i++) {
      world.restart()
      await world.cycle()
    }
    expect(world.chain.usdcSpent).toBe(25_000_000n)
    expect(await world.count(`SELECT count(*)::int AS n FROM cards`)).toBe(1)
  })

  it('crashes between signing and sending, then resends the same bytes', async () => {
    world = await makeWorld({ usdc: 700 })
    const id = await world.openRound()
    world.provider.dropSubmitResponses = 1
    world.chain.burn({ wallet: wallet(), roundId: id })
    await world.cycle()
    const [order] = await world.db.query(`SELECT * FROM pack_orders`)
    expect(order?.state).toBe('signed')
    world.restart()
    await world.cycle(4)
    const [after] = await world.db.query(`SELECT * FROM pack_orders`)
    expect(after?.pay_sig).toBe(order?.pay_sig)
    expect(world.chain.usdcSpent).toBe(25_000_000n)
  })

  it('buys again only after an unsent payment has expired', async () => {
    world = await makeWorld({ usdc: 700 })
    const id = await world.openRound()
    world.chain.burn({ wallet: wallet(), roundId: id })
    const submit = world.provider.submit.bind(world.provider)
    world.provider.submit = async () => {
      throw new Error('provider is down')
    }
    await world.cycle(5)
    expect(world.provider.generateCalls).toBe(1)
    await world.cycle(100)
    expect(world.provider.generateCalls).toBe(1)

    world.provider.submit = submit
    world.chain.advance(100)
    await world.until(() => world.count(`SELECT count(*)::int AS n FROM cards`).then((n) => n === 1))
    expect(world.provider.generateCalls).toBe(2)
    expect(world.chain.usdcSpent).toBe(25_000_000n)
  })

  it('refuses to sign an overcharge and pauses all spending', async () => {
    world = await makeWorld({ usdc: 700 })
    const id = await world.openRound()
    world.provider.overchargeNext = 1_000
    await rip(world, wallet(), id, 4)
    expect(world.chain.usdcSpent).toBe(0n)
    expect(await world.game.isPaused()).toBe(true)
    const [order] = await world.db.query(`SELECT * FROM pack_orders`)
    expect(order?.signed_tx).toBeNull()
  })

  it('recovers a payout whose status was lost, without sending it twice', async () => {
    world = await makeWorld({ usdc: 700 })
    const id = await world.openRound()
    const winner = wallet()
    world.chain.burn({ wallet: winner, roundId: id })
    await passes(world, 6)
    world.chain.loseTransferStatus = true
    await world.cycle(150)
    world.restart()
    await world.until(() => world.settled(id))
    expect(await ownedBy(world, winner)).toHaveLength(1)
    assertNoDoubleSends(world)
  })

  it('retries a failed payout and still delivers', async () => {
    world = await makeWorld({ usdc: 700 })
    const id = await world.openRound()
    const winner = wallet()
    world.chain.burn({ wallet: winner, roundId: id })
    await passes(world, 6)
    world.chain.failNextTransfers = 3
    await world.cycle(150)
    await world.until(() => world.settled(id))
    expect(await ownedBy(world, winner)).toHaveLength(1)
    assertNoDoubleSends(world)
  })

  it('marks a payout stuck after repeated failure, and still settles', async () => {
    world = await makeWorld({ usdc: 700 })
    const id = await world.openRound()
    world.chain.burn({ wallet: wallet(), roundId: id })
    await passes(world, 6)
    world.chain.failNextTransfers = 1_000
    await world.cycle(150)
    await world.until(() => world.settled(id))
    expect(await world.count(`SELECT count(*)::int AS n FROM payouts WHERE state = 'stuck'`)).toBe(1)
  })

  it('halts on a card that left the dev wallet unexpectedly', async () => {
    world = await makeWorld({ usdc: 700 })
    const id = await world.openRound()
    world.chain.burn({ wallet: wallet(), roundId: id })
    await world.until(() => world.count(`SELECT count(*)::int AS n FROM cards`).then((n) => n === 1))
    for (const asset of world.chain.assets.values()) asset.owner = wallet()
    await world.cycle(150)
    await world.until(() => world.settled(id))
    expect(await world.count(`SELECT count(*)::int AS n FROM payouts WHERE state = 'stuck'`)).toBe(1)
    expect(world.chain.transferCount.size).toBe(0)
  })
})

describe('machine shortages', () => {
  it('falls to a cheaper pack and spends less', async () => {
    world = await makeWorld({ usdc: 1_100 })
    const id = await world.openRound()
    world.provider.stock.set('pokemon_50', 0)
    world.provider.stock.set('pokemon_100', 0)
    for (let i = 0; i < 26; i++) await rip(world, wallet(), id, 1)
    await world.cycle(60)
    await world.until(() => world.settled(id))
    expect(world.chain.usdcSpent).toBe(650_000_000n)
  })

  it('ends the round and gives a voucher when nothing can be bought', async () => {
    world = await makeWorld({ usdc: 700 })
    const id = await world.openRound()
    const first = wallet()
    world.chain.burn({ wallet: first, roundId: id })
    await passes(world, 6)
    world.provider.stock.set('pokemon_25', 0)
    const second = wallet()
    world.chain.burn({ wallet: second, roundId: id })
    await passes(world, 6)
    await world.cycle(60)
    await world.until(() => world.settled(id))
    const round = await world.round(id)
    expect(round.end_reason).toBe('sold_out')
    expect(round.winner).toBe(second)
    expect(await world.count(`SELECT count(*)::int AS n FROM vouchers WHERE wallet = $1 AND reason = 'no_pack'`, [second])).toBe(1)
    expect(await ownedBy(world, second)).toHaveLength(1)
  })
})

describe('burn totals', () => {
  it('reports tokens burned and their dollar value', async () => {
    world = await makeWorld({ usdc: 700 })
    const id = await world.openRound()
    const [big, small] = [wallet(), wallet()]
    await rip(world, big, id)
    await rip(world, big, id)
    await rip(world, small, id)
    const { buildState } = await import('../server/game/views.ts')
    const state = await buildState(world.db, world.game, {
      chain: world.chain,
      mode: 'mock',
      roundGapSlots: RULES.roundGapSlots,
      decimals: 6,
      burnUsd: () => 12.5,
    })
    expect(state.round?.burnedTokens).toBe(300_000)
    expect(state.round?.burnedUsd).toBe(37.5)
    expect(state.burnedAllTime).toEqual({ tokens: 300_000, usd: 37.5 })
    expect(state.burnUsd).toBe(12.5)
    expect(state.round?.topBurners[0]).toEqual({ wallet: big, rips: 2, tokens: 200_000, usd: 25 })
    expect(state.round?.rips.map((entry) => entry.addedSeconds)).toEqual([30, 5, 3])
  })

  it('counts late burns, since those coins are gone too, but not vouchers', async () => {
    world = await makeWorld({ usdc: 1_400 })
    const id = await world.openRound()
    await rip(world, wallet(), id)
    await world.cycle(RULES.startSlots + 2)
    const holder = wallet()
    const origin = world.chain.burn({ wallet: holder, roundId: id })
    await world.cycle(60)
    await world.until(() => world.settled(id))
    await world.cycle(40)
    const next = await world.openRound()
    world.chain.redeemVoucher({ wallet: holder, roundId: next, originSig: origin })
    await world.cycle(2)
    const { buildState } = await import('../server/game/views.ts')
    const state = await buildState(world.db, world.game, {
      chain: world.chain,
      mode: 'mock',
      roundGapSlots: RULES.roundGapSlots,
      decimals: 6,
      burnUsd: () => 12.5,
    })
    expect(state.burnedAllTime.tokens).toBe(200_000)
    expect(state.round?.burnedTokens).toBe(0)
    expect(state.round?.packsRipped).toBe(1)
    expect(state.round?.topBurners[0]).toMatchObject({ wallet: holder, rips: 1, tokens: 0, usd: 0 })
  })
})

describe('restart', () => {
  it('replays to the same result after a restart mid-round', async () => {
    world = await makeWorld({ usdc: 700 })
    const id = await world.openRound()
    const last = wallet()
    await rip(world, wallet(), id)
    await rip(world, last, id)
    const before = (await world.round(id)).deadline_slot
    world.restart()
    await world.cycle()
    expect((await world.round(id)).deadline_slot).toBe(before)
    await world.cycle(150)
    await world.until(() => world.settled(id))
    expect((await world.round(id)).winner).toBe(last)
  })
})

describe('pause', () => {
  it('stops new rounds and spending, then resumes', async () => {
    world = await makeWorld({ usdc: 700 })
    await world.game.setPaused(true)
    await world.cycle(20)
    expect(await world.count(`SELECT count(*)::int AS n FROM rounds`)).toBe(0)
    await world.game.setPaused(false)
    const id = await world.openRound()
    await world.game.setPaused(true)
    world.chain.burn({ wallet: wallet(), roundId: id })
    await world.cycle(5)
    expect(world.chain.usdcSpent).toBe(0n)
    await world.game.setPaused(false)
    await passes(world, 4)
    expect(world.chain.usdcSpent).toBe(25_000_000n)
  })
})

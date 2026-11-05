// Plays full rounds with bot wallets against the mock chain and checks the books.
// Covers the 25, 83 and 114-pack ladder steps, last-slot races and the 5-minute drop.
// Usage: npm run sim
import { makeWorld, wallet } from '../tests/harness.ts'
import { RULES } from '../shared/rules.ts'

interface Scenario {
  name: string
  usdc: number
  /** Rips, as [wallet index, slots to wait first]. */
  plan(packs: number): [number, number][]
  players: number
}

const steady = (rips: number, gap: number, players: number): [number, number][] =>
  Array.from({ length: rips }, (_, i) => [Math.floor(Math.random() ** 1.6 * players), gap])

const scenarios: Scenario[] = [
  { name: '25 packs, quiet round, timer ends it', usdc: 700, players: 6, plan: () => steady(12, 14, 6) },
  { name: '25 packs, sells out', usdc: 700, players: 10, plan: (packs) => steady(packs, 4, 10) },
  { name: '83 packs, long round with a drop', usdc: 5_200, players: 14, plan: () => steady(70, 13, 14) },
  { name: '114 packs, marathon with several drops', usdc: 10_500, players: 20, plan: () => steady(114, 13, 20) },
  {
    name: 'last-slot race: every rip in the final slot',
    usdc: 700,
    players: 8,
    plan: () => Array.from({ length: 20 }, (_, i) => [i % 8, i === 0 ? 1 : 13] as [number, number]),
  },
]

let failures = 0
const check = (ok: boolean, label: string) => {
  if (!ok) failures += 1
  console.log(`   ${ok ? 'ok ' : 'FAIL'} ${label}`)
}

for (const scenario of scenarios) {
  console.log(`\n${scenario.name}`)
  const world = await makeWorld({ usdc: scenario.usdc })
  const startUsdc = world.chain.usdc
  const id = await world.openRound()
  const packs = (await world.round(id)).packs_total as number
  const players = Array.from({ length: scenario.players }, () => wallet())

  let burned = 0
  for (const [player, wait] of scenario.plan(packs)) {
    for (let i = 0; i < wait; i += 4) await world.cycle(Math.min(4, wait - i))
    world.chain.burn({ wallet: players[player] as string, roundId: id })
    burned += 1
  }
  await world.cycle(RULES.startSlots + 40)
  await world.cycle(RULES.startSlots + 40)
  await world.until(() => world.settled(id), 3_000)

  const round = await world.round(id)
  const counted = await world.count(`SELECT count(*)::int AS n FROM burns WHERE round_id = $1 AND result = 'counted'`, [id])
  const cards = await world.count(`SELECT count(*)::int AS n FROM cards WHERE round_id = $1`, [id])
  const wins = await world.count(`SELECT count(*)::int AS n FROM payouts WHERE round_id = $1 AND reason = 'win' AND state = 'delivered'`, [id])
  const drops = await world.count(`SELECT count(*)::int AS n FROM payouts WHERE round_id = $1 AND reason = 'drop' AND state = 'delivered'`, [id])
  const sweeps = await world.count(`SELECT count(*)::int AS n FROM sweeps WHERE round_id = $1`, [id])
  const spent = Number((startUsdc - world.chain.usdc) / 1_000_000n)
  const [{ cost }] = (await world.db.query(
    `SELECT coalesce(sum(price), 0)::int AS cost FROM pack_orders WHERE round_id = $1`,
    [id],
  )) as [{ cost: number }]
  const doubles = [...world.chain.transferCount.values()].filter((count) => count !== 1).length
  const left = [...world.chain.assets.values()].filter((asset) => asset.owner === world.chain.devAddress).length

  console.log(`   ${packs} packs, ${burned} burns, ${counted} counted, ended by ${round.end_reason}, ${sweeps} drops`)
  console.log(`   winner ${String(round.winner).slice(0, 8)}, ${wins} cards won, ${drops} dropped, $${spent} spent`)
  check(cards === counted, `every counted rip produced a card (${cards})`)
  check(wins + drops === cards, 'every card was delivered')
  check(left === 0, 'nothing left in the dev wallet')
  check(doubles === 0, 'no card was sent twice')
  check(spent === cost, `USDC spent matches packs opened ($${cost})`)
  check(spent <= scenario.usdc, 'never spent more than the treasury held')
  await world.db.close()
}

console.log(failures === 0 ? '\nAll scenarios passed.' : `\n${failures} checks failed.`)
process.exit(failures === 0 ? 0 : 1)

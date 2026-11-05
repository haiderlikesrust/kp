import { RULES } from '../../shared/rules.ts'
import type { Game } from '../game/service.ts'
import { randomAddress, type MockChain } from './chain.ts'

const BOT_COUNT = 12

/**
 * Keeps a local demo looking alive: a handful of wallets rip at a human pace,
 * speed up near zero, and eventually stop so someone wins. Mock mode only.
 */
export function startBots(chain: MockChain, game: Game, opts: { tickMs: number; usdPerTick: number }): () => void {
  const bots = Array.from({ length: BOT_COUNT }, () => ({ wallet: randomAddress(), appetite: Math.random() }))
  let roundId = 0
  let energy = 0
  let frenzy = 0

  const timer = setInterval(async () => {
    // Fees keep flowing in, so the demo funds its next round.
    chain.usdc += BigInt(Math.round(opts.usdPerTick * 1_000_000))

    const round = await game.currentRound().catch(() => null)
    if (!round || !['open', 'live'].includes(round.status)) return
    if (round.id !== roundId) {
      roundId = round.id
      // Decide up front how hard this crowd will fight for the round.
      energy = 8 + Math.floor(Math.random() * (round.packs_total * 0.9))
    }
    if (energy <= 0) return

    const left = round.deadline_slot ? round.deadline_slot - chain.slotNow : RULES.startSlots
    // Occasional pile-ons, so the heat meter gets to climb in a demo.
    if (Math.random() < 0.012) frenzy = 10
    if (frenzy > 0) frenzy -= 1
    const urgency = frenzy > 0 ? 0.75 : left < 30 ? 0.3 : left < 60 ? 0.14 : 0.05
    if (round.status === 'live' ? Math.random() > urgency : Math.random() > 0.02) return

    const bot = bots[Math.floor(Math.random() ** 2 * bots.length)]
    if (!bot) return
    energy -= 1
    chain.burn({ wallet: bot.wallet, roundId: round.id, delaySlots: 2 + Math.floor(Math.random() * 3) })
  }, opts.tickMs)

  return () => clearInterval(timer)
}

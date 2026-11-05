import { Link } from 'react-router-dom'
import { LADDER, PACK_TIERS, stepCost, stepPackCount } from '../../../shared/ladder.ts'
import { minPacksForDrop } from '../../../shared/rules.ts'
import { usd } from '../lib/format.ts'

const STEPS: [string, string][] = [
  ['Trading funds the treasury', 'Creator fees from the coin are converted to USDC. The bigger the treasury, the bigger the packs in the next round.'],
  ['Burn to rip', 'Burn 100,000 coins to rip one pack. That is all you pay. The treasury buys the pack, and the card goes into the shared pot.'],
  ['Beat the clock', 'The first rip starts a 30-second timer. A rip adds 5 seconds, but the busier it gets the less each rip buys: 3 seconds once a few people are ripping, 1 second when it gets hectic, and nothing at peak heat.'],
  ['Last rip takes it all', 'When the timer hits zero, the last ripper wins every card left in the pot. If the last pack goes first, whoever ripped it wins right then.'],
  ['The 5-minute drop', `A second clock starts on the first rip. If nobody has won when it hits zero, 5 random cards from the pot go to that window’s 5 biggest burners, one each. Then it resets. Only bigger rounds last that long: at least ${minPacksForDrop()} packs.`],
]

export function HowPage() {
  return (
    <article className="mx-auto max-w-3xl pt-8">
      <h1 className="text-5xl leading-none sm:text-6xl">How it <span className="marker">works</span></h1>
      <ol className="panel mt-7 flex flex-col gap-6 p-6 sm:p-8">
        {STEPS.map(([title, body], index) => (
          <li key={title} className="flex gap-4">
            <span className="grid size-9 shrink-0 place-items-center rounded-lg border-2 border-[var(--edge)] bg-gold font-display font-extrabold text-night">{index + 1}</span>
            <div>
              <h2 className="text-lg">{title}</h2>
              <p className="mt-1 text-sm leading-relaxed text-mute">{body}</p>
            </div>
          </li>
        ))}
      </ol>

      <h2 className="mt-10 text-2xl">What counts as a rip</h2>
      <p className="mt-2 text-sm leading-relaxed text-mute">
        Solana decides, not our server. A rip counts if it lands on-chain at or before the deadline, in the order the
        chain recorded it. The timer on screen is a close estimate of those slots. Signing a transaction is not
        landing it, so leave yourself a few seconds. Wallet popups take time.
      </p>

      <h2 className="mt-8 text-2xl">If you land too late</h2>
      <p className="mt-2 text-sm leading-relaxed text-mute">
        Burned coins can’t come back, so a burn that lands after the round ends, or after the last pack, becomes a
        voucher for one free rip in a later round. A voucher is only worth something if another round opens.
      </p>

      <h2 className="mt-8 text-2xl">How big rounds get</h2>
      <p className="mt-2 text-sm leading-relaxed text-mute">
        Each round’s packs come from this table. They are shuffled, and packs are bought only when ripped, so anything
        unopened stays in the treasury.
      </p>
      <div className="panel mt-3 overflow-x-auto">
        <table className="w-full min-w-[460px] text-sm tabular-nums">
          <thead>
            <tr className="border-b border-line text-left text-xs text-mute">
              <th className="px-3 py-2 font-medium">Treasury</th>
              {PACK_TIERS.map((tier) => (
                <th key={tier.price} className="px-3 py-2 font-medium">
                  ${tier.price}
                </th>
              ))}
              <th className="px-3 py-2 font-medium">Packs</th>
              <th className="px-3 py-2 font-medium">Cost</th>
            </tr>
          </thead>
          <tbody>
            {LADDER.map((step) => (
              <tr key={step.minTreasury} className="border-b border-line last:border-0">
                <td className="px-3 py-2 font-medium">{usd(step.minTreasury)}+</td>
                {PACK_TIERS.map((tier) => (
                  <td key={tier.price} className="px-3 py-2">
                    {step.packs[tier.price] ?? '–'}
                  </td>
                ))}
                <td className="px-3 py-2">{stepPackCount(step)}</td>
                <td className="px-3 py-2">{usd(stepCost(step))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className="mt-8 text-2xl">Check it yourself</h2>
      <p className="mt-2 text-sm leading-relaxed text-mute">
        Before a round opens, we publish a hash of a secret on-chain. That secret sets the pack order, and it seeds
        drops together with a block that didn’t exist yet. When the round ends we reveal the secret, and{' '}
        <Link to="/history" className="font-medium text-ink underline">
          History
        </Link>{' '}
        can recheck every round in your browser.
      </p>
    </article>
  )
}

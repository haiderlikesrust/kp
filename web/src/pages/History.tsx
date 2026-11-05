import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import type { RoundProof, RoundSummary } from '../../../shared/api.ts'
import { commitHash, pickDrop, shuffleLineup } from '../../../shared/fairness.ts'
import { explorerTx, short, usd } from '../lib/format.ts'
import { useGame } from '../lib/game.tsx'

export function HistoryPage() {
  const [rounds, setRounds] = useState<RoundSummary[] | null>(null)
  useEffect(() => {
    fetch('/api/rounds')
      .then((res) => res.json())
      .then(setRounds)
      .catch(() => setRounds([]))
  }, [])

  return (
    <section className="mx-auto max-w-3xl pt-8">
      <h1 className="text-5xl leading-none sm:text-6xl">Past <span className="marker">rounds</span></h1>
      <p className="mt-3 text-mute">Every finished round, with everything you need to recheck it.</p>
      {rounds === null ? (
        <p className="mt-8 text-sm text-mute">Loading…</p>
      ) : rounds.length === 0 ? (
        <p className="panel mt-8 px-4 py-10 text-center font-semibold text-mute">
          No finished rounds yet.
        </p>
      ) : (
        <ul className="panel mt-6 divide-y divide-line overflow-hidden">
          {rounds.map((round) => (
            <li key={round.id}>
              <Link to={`/history/${round.id}`} className="flex items-center justify-between gap-3 px-5 py-4 hover:bg-soft">
                <span className="min-w-0">
                  <span className="font-display font-bold">Round {round.id}</span>
                  <span className="ml-2 text-sm tabular-nums text-mute">{short(round.winner)}</span>
                </span>
                <span className="shrink-0 text-right text-sm tabular-nums">
                  {usd(round.potUsd)}
                  <span className="ml-3 text-mute">
                    {round.packsRipped}/{round.packsTotal} packs
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

interface Check {
  label: string
  ok: boolean
}

/** Recomputes the round's randomness here in the browser, from published inputs. */
function verify(proof: RoundProof): Check[] {
  if (!proof.secret) return []
  const secret = proof.secret
  const sorted = [...proof.lineup].sort((a, b) => a - b)
  const checks: Check[] = [
    { label: 'The secret matches the hash published before the round', ok: commitHash(secret) === proof.commitHash },
    {
      label: 'The pack order comes from that secret',
      ok: shuffleLineup(sorted, secret, proof.id).join() === proof.lineup.join(),
    },
  ]
  for (const drop of proof.drops) {
    if (!drop.blockhash) continue
    const expected = pickDrop(drop.pool, drop.picks.length, secret, drop.blockhash, proof.id, drop.index)
    checks.push({ label: `Drop ${drop.index + 1} picks match its seed`, ok: expected.join() === drop.picks.join() })
  }
  return checks
}

export function RoundPage() {
  const { id } = useParams()
  const { config } = useGame()
  const [proof, setProof] = useState<RoundProof | null | undefined>(undefined)
  const [checks, setChecks] = useState<Check[] | null>(null)
  const cluster = config?.explorerCluster ?? ''

  useEffect(() => {
    fetch(`/api/rounds/${id}`)
      .then((res) => (res.ok ? res.json() : null))
      .then(setProof)
      .catch(() => setProof(null))
  }, [id])

  if (proof === undefined) return <p className="py-16 text-center text-sm text-mute">Loading…</p>
  if (proof === null) return <p className="py-16 text-center text-sm text-mute">No such round.</p>

  const counted = proof.burns.filter((burn) => burn.result === 'counted')
  return (
    <section className="mx-auto max-w-3xl pt-8">
      <Link to="/history" className="text-sm text-mute hover:text-ink">
        ← History
      </Link>
      <h1 className="mt-2 text-5xl leading-none">Round {proof.id}</h1>
      <p className="mt-2 text-sm text-mute">
        Won by <span className="font-medium tabular-nums text-ink">{short(proof.winner)}</span>
        {proof.endReason === 'sold_out' ? ' with the final pack' : ' when the timer ran out'}. {usd(proof.potUsd)} across{' '}
        {proof.packsRipped} of {proof.packsTotal} packs.
      </p>

      <div className="panel mt-6 p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-bold">Fairness check</h2>
          <button
            type="button"
            disabled={!proof.secret}
            onClick={() => setChecks(verify(proof))}
            className="pill pill-ink h-10 px-4 text-sm"
          >
            Recheck in my browser
          </button>
        </div>
        {!proof.secret ? <p className="mt-2 text-sm text-mute">The secret is revealed when the round settles.</p> : null}
        {checks ? (
          <ul className="mt-3 flex flex-col gap-1 text-sm">
            {checks.map((check) => (
              <li key={check.label} className={check.ok ? 'text-uncommon' : 'text-signal'}>
                {check.ok ? '✓' : '✗'} {check.label}
              </li>
            ))}
          </ul>
        ) : null}
        <dl className="mt-3 grid gap-1 text-xs text-mute">
          <div className="break-all">
            <dt className="inline font-medium">Commitment: </dt>
            <dd className="inline">{proof.commitHash}</dd>
          </div>
          {proof.secret ? (
            <div className="break-all">
              <dt className="inline font-medium">Secret: </dt>
              <dd className="inline">{proof.secret}</dd>
            </div>
          ) : null}
        </dl>
      </div>

      <h2 className="mt-8 font-bold">Rips in chain order</h2>
      <ol className="panel mt-2 divide-y divide-line overflow-hidden text-sm tabular-nums">
        {counted.map((burn, index) => (
          <li key={burn.signature} className="flex items-center justify-between gap-3 px-4 py-2">
            <span>
              <span className="mr-3 text-xs text-mute">{index + 1}</span>
              {short(burn.wallet)}
            </span>
            <a href={explorerTx(burn.signature, cluster)} target="_blank" rel="noreferrer" className="text-xs text-mute underline hover:text-ink">
              slot {burn.slot}
            </a>
          </li>
        ))}
      </ol>

      {proof.drops.length > 0 ? (
        <>
          <h2 className="mt-8 font-bold">Drops</h2>
          <ul className="mt-2 flex flex-col gap-2 text-sm">
            {proof.drops.map((drop) => (
              <li key={drop.index} className="panel px-5 py-4">
                <p className="font-medium">
                  Drop {drop.index + 1} at slot {drop.slot}
                </p>
                <p className="mt-1 text-xs text-mute">To {drop.recipients.slice(0, drop.picks.length).map(short).join(', ')}</p>
                <p className="mt-1 text-xs break-all text-mute">Blockhash {drop.blockhash}</p>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <h2 className="mt-8 font-bold">Deliveries</h2>
      <ul className="panel mt-2 divide-y divide-line overflow-hidden text-sm tabular-nums">
        {proof.payouts.map((payout) => (
          <li key={payout.nft ?? payout.recipient} className="flex items-center justify-between gap-3 px-4 py-2">
            <span>
              {short(payout.nft)} → {short(payout.recipient)}
            </span>
            <span className="text-xs text-mute">
              {payout.reason} ·{' '}
              {payout.signature ? (
                <a href={explorerTx(payout.signature, cluster)} target="_blank" rel="noreferrer" className="underline hover:text-ink">
                  {payout.state}
                </a>
              ) : (
                payout.state
              )}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

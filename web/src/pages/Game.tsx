import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, Clock, Crown, Flame, Package, Sparkles, Ticket, X } from 'lucide-react'
import type { CardView, GameState, RoundView } from '../../../shared/api.ts'
import { MIN_TREASURY } from '../../../shared/ladder.ts'
import { RULES, minPacksForDrop, slotsToSeconds } from '../../../shared/rules.ts'
import { Avatar } from '../components/Avatar.tsx'
import { Card, CardCaption, RARITY_COLOR } from '../components/Card.tsx'
import { ContractAddress } from '../components/ContractAddress.tsx'
import { Pack } from '../components/Pack.tsx'
import { clock, compact, short, usd } from '../lib/format.ts'
import { useGame, useSecondsUntil } from '../lib/game.tsx'
import { useRipper, type MyRip, type Ripper } from '../lib/ripper.ts'
import { useWallet } from '../lib/wallet.tsx'

const START_SECONDS = 30
const LATE_WARNING_SECONDS = 5
const DROP_SECONDS = (RULES.dropSlots * 400) / 1000
const HEAT_SECONDS = RULES.heatTiers.map((tier) => slotsToSeconds(tier.slots))
const CONFETTI = ['#ff4438', '#ff8f2e', '#ffc02e', '#10b981', '#2f6dff', '#7d5cff']

/** Relative gauge widths: wider zones take more rips to cross. */
const HEAT_ZONES = [2, 3, 4, 1.4]

const heatLevel = (seconds: number): number => Math.max(0, HEAT_SECONDS.indexOf(seconds))

/** Eases a number toward its latest value, so totals tick up as they change. */
function useCountUp(target: number): number {
  const [shown, setShown] = useState(target)
  const current = useRef(target)
  useEffect(() => {
    const from = current.current
    const started = performance.now()
    let frame = 0
    const step = (now: number) => {
      const progress = Math.min(1, (now - started) / 700)
      const value = from + (target - from) * (1 - (1 - progress) ** 3)
      current.current = value
      setShown(value)
      if (progress < 1) frame = requestAnimationFrame(step)
    }
    frame = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frame)
  }, [target])
  return shown
}

/** Where the next rip sits on the gauge, as a share of its width. */
function needlePosition(recentRips: number): number {
  const next = Math.min(recentRips + 1, RULES.heatTiers.at(-1)?.fromRips ?? 10)
  const widths = HEAT_ZONES
  const total = widths.reduce((sum, width) => sum + width, 0)
  let passed = 0
  for (const [index, tier] of RULES.heatTiers.entries()) {
    const after = RULES.heatTiers[index + 1]?.fromRips
    const width = widths[index] ?? 1
    if (after === undefined || next < after) {
      const span = after === undefined ? 1 : after - tier.fromRips
      return ((passed + (width * (next - tier.fromRips + 0.5)) / span) / total) * 100
    }
    passed += width
  }
  return 100
}

function HeatGauge({ round, level, ended }: { round: RoundView; level: number; ended: boolean }) {
  const columns = HEAT_ZONES.map((width) => `${width}fr`).join(' ')
  return (
    <div className="mt-4 px-1" role="img" aria-label={ended ? 'Round over' : `Heat: the next rip adds ${round.heat.nextAddSeconds} seconds`}>
      <div className="relative">
        <div className="heat-bar" style={{ gridTemplateColumns: columns }}>
          {HEAT_SECONDS.map((value, index) => (
            <span key={value} data-level={index} data-on={!ended && index === level} />
          ))}
        </div>
        {ended ? null : <span className="heat-needle" style={{ left: `${needlePosition(round.heat.recentRips)}%` }} />}
      </div>
      <div className="mt-1 grid text-center text-xs" style={{ gridTemplateColumns: columns }}>
        {HEAT_SECONDS.map((value, index) => (
          <span key={value} className={!ended && index === level ? 'font-extrabold text-ink' : 'font-medium text-faint'}>
            +{value}s
          </span>
        ))}
      </div>
    </div>
  )
}

function TimerPanel({ round }: { round: RoundView }) {
  const seconds = useSecondsUntil(round.status === 'live' ? round.deadlineSlot : null)
  const ended = round.status === 'cutoff'
  const idle = round.status === 'open'
  const last = round.rips.at(-1)
  const level = heatLevel(round.heat.nextAddSeconds)
  const urgent = ended || (seconds !== null && seconds < 10)

  return (
    <div className="panel relative p-3 sm:p-4">
      <div className="scoreboard flex items-center justify-between gap-3">
        <p
          className={`clock text-[clamp(3.6rem,15vw,5.4rem)] ${idle ? 'opacity-35' : ''}`}
          data-urgent={urgent}
          role="timer"
        >
          {ended ? '00.0' : idle ? clock(START_SECONDS) : clock(seconds ?? 0)}
        </p>
        {last && !ended && round.rips.length > 1 ? (
          <span key={last.signature} className="added-chip">
            +{last.addedSeconds}s
          </span>
        ) : null}
        <div className="shrink-0 text-right">
          <p className="eyebrow !text-white/60">Next rip</p>
          <p className="font-display text-3xl leading-tight font-extrabold text-white">{ended ? '—' : `+${round.heat.nextAddSeconds}s`}</p>
        </div>
      </div>
      <HeatGauge round={round} level={level} ended={ended} />
      <p className="mt-2 text-center text-xs font-semibold text-mute">
        {ended
          ? 'Confirming the last rip on-chain…'
          : idle
            ? 'The first rip starts the clock.'
            : `${round.heat.recentRips} ${round.heat.recentRips === 1 ? 'rip' : 'rips'} in the last 10 seconds. The busier it gets, the less each rip adds.`}
      </p>
    </div>
  )
}

function RipButton({ round, state, ripper }: { round: RoundView; state: GameState; ripper: Ripper }) {
  const { config } = useGame()
  const { address, openPicker } = useWallet()
  const seconds = useSecondsUntil(round.status === 'live' ? round.deadlineSlot : null)
  const burn = compact(config?.burnTokens ?? RULES.burnTokens)
  const canRip = ['open', 'live'].includes(round.status) && round.packsRipped < round.packsTotal
  const late = canRip && seconds !== null && seconds < LATE_WARNING_SECONDS
  const voucher = ripper.vouchers[0]

  return (
    <div className="mt-4">
      <div className="flex flex-wrap gap-3">
        {address ? (
          <button
            type="button"
            className="pill pill-rip h-14 flex-1 px-8 text-lg"
            disabled={!canRip || ripper.signing || state.paused}
            onClick={ripper.rip}
          >
            <Flame size={20} />
            {ripper.signing ? 'Check your wallet…' : `Rip it · burn ${burn}`}
          </button>
        ) : (
          <button type="button" className="pill pill-rip h-14 flex-1 px-8 text-lg" onClick={openPicker}>
            Connect to rip
            <ArrowRight size={19} />
          </button>
        )}
        {voucher ? (
          <button
            type="button"
            className="pill pill-ghost h-14 px-5"
            disabled={!canRip || ripper.signing}
            onClick={() => ripper.ripWithVoucher(voucher.originSig)}
          >
            <Ticket size={18} />
            Free rip ({ripper.vouchers.length})
          </button>
        ) : null}
      </div>
      <p className={`mt-3 min-h-5 text-center text-sm ${ripper.error || late ? 'font-extrabold text-gold' : 'font-semibold text-white/85'}`} aria-live="polite">
        {ripper.error ??
          (late ? 'Close call. A rip that lands late becomes a free voucher.' : 'You pay only the burn. The treasury buys the pack.')}
      </p>
    </div>
  )
}

function Bubble({ className, tone, children, delay }: { className: string; tone: string; children: React.ReactNode; delay: string }) {
  return (
    <div className={`absolute z-10 ${className}`}>
      <div className={`bob chip h-9 px-3 text-sm shadow-[3px_3px_0_var(--edge)] ${tone}`} style={{ animationDelay: delay }}>
        {children}
      </div>
    </div>
  )
}

function PackFan({ state, round, ripper }: { state: GameState; round: RoundView; ripper: Ripper }) {
  const { address, openPicker } = useWallet()
  const canRip = ['open', 'live'].includes(round.status) && round.packsRipped < round.packsTotal
  const best = useMemo(
    () => [...round.cards].sort((a, b) => (b.insuredValue ?? 0) - (a.insuredValue ?? 0)).slice(0, 2),
    [round.cards],
  )

  return (
    <div className="relative mx-auto h-[360px] w-full max-w-[440px] sm:h-[430px]">
      {best[0] ? (
        <div className="absolute top-12 left-[2%] w-[128px] sm:w-[156px]">
          <div className="bob" style={{ '--tilt': '-13deg', animationDelay: '-2s' } as React.CSSProperties}>
            <Card card={best[0]} />
          </div>
        </div>
      ) : null}
      {best[1] ? (
        <div className="absolute top-12 right-[2%] w-[128px] sm:w-[156px]">
          <div className="bob" style={{ '--tilt': '13deg', animationDelay: '-4s' } as React.CSSProperties}>
            <Card card={best[1]} />
          </div>
        </div>
      ) : null}
      <div className="absolute top-2 left-1/2 z-[5] -translate-x-1/2">
        <div className="bob">
          <button
            type="button"
            className="pack-button"
            aria-label="Rip a pack"
            disabled={address ? !canRip || ripper.signing || state.paused : false}
            onClick={address ? ripper.rip : openPicker}
          >
            <Pack width={236} />
          </button>
        </div>
      </div>
      <Bubble className="top-[70%] left-0" tone="!bg-signal text-white" delay="-1s">
        <Flame size={15} />
        {compact(round.burnedTokens)} burned
      </Bubble>
      <Bubble className="top-[6%] right-0" tone="!bg-gold text-night" delay="-3s">
        <Sparkles size={15} />
        {usd(round.potUsd)} pot
      </Bubble>
    </div>
  )
}

function Hero({ state, round, ripper }: { state: GameState; round: RoundView; ripper: Ripper }) {
  const left = round.packsTotal - round.packsRipped
  return (
    <section className="hero-band grid items-center gap-8 lg:grid-cols-[1fr_1.1fr] lg:gap-12">
      <div className="rise-in lg:order-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="chip">
            <span className="live-dot" />
            Round {round.id}
          </span>
          <span className="chip">
            <Package size={14} />
            <span className="tnum">
              {left} of {round.packsTotal} packs left
            </span>
          </span>
          {round.lastRipper ? (
            <span className="chip">
              <Crown size={14} />
              <Avatar wallet={round.lastRipper} size={15} />
              <span className="tnum">{short(round.lastRipper)}</span>
            </span>
          ) : null}
        </div>
        <ContractAddress className="mt-2" />
        <h1 className="mt-4 text-[2.8rem] leading-[1.02] text-white sm:text-[3.7rem]">
          Keep ripping.
          <br />
          <span className="marker">Last rip wins.</span>
        </h1>
        <div className="mt-5">
          <TimerPanel round={round} />
          <RipButton round={round} state={state} ripper={ripper} />
        </div>
      </div>
      <PackFan state={state} round={round} ripper={ripper} />
    </section>
  )
}

function CardTicker({ cards }: { cards: CardView[] }) {
  const items = useMemo(() => {
    const recent = [...cards].reverse().slice(0, 14)
    const filled = recent.length >= 7 ? recent : [...recent, ...recent, ...recent]
    return [...filled, ...filled]
  }, [cards])
  if (cards.length === 0) return null
  return (
    <div className="-mx-4 mt-12 overflow-hidden sm:-mx-6" aria-hidden="true">
      <div className="ticker gap-3 py-1">
        {items.map((card, index) => (
          <div key={`${card.nft}-${index}`} className="flex w-56 shrink-0 items-center gap-2.5 rounded-xl border-2 border-[var(--edge)] bg-sheet py-1 pr-3 pl-1">
            <div className="h-10 w-7 shrink-0 overflow-hidden rounded-md bg-soft">
              {card.image ? <img src={card.image} alt="" className="h-full w-full object-cover" /> : null}
            </div>
            <div className="min-w-0">
              <p className="truncate text-xs font-bold">{card.name}</p>
              <p className="tnum font-display text-xs font-semibold text-mute">{card.insuredValue != null ? usd(card.insuredValue) : '…'}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function Counter({ icon, tone, label, value, sub, format }: { icon: React.ReactNode; tone: string; label: string; value: number; sub?: string; format(n: number): string }) {
  const shown = useCountUp(value)
  return (
    <div className={`panel min-w-0 p-4 text-night sm:p-5 ${tone}`}>
      <p className="flex items-center gap-1.5">
        {icon}
        <span className="eyebrow !text-night/70">{label}</span>
      </p>
      <p className="tnum mt-1 truncate font-display text-3xl font-extrabold sm:text-4xl">{format(shown)}</p>
      {sub ? <p className="tnum text-sm font-bold text-night/65">{sub}</p> : null}
    </div>
  )
}

const roundedCompact = (value: number): string => compact(Math.round(value / 1000) * 1000)

function Counters({ state, round }: { state: GameState; round: RoundView }) {
  return (
    <section className="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-4" aria-label="Totals">
      <Counter tone="!bg-gold" icon={<Sparkles size={17} />} label="In the pot" value={round.potUsd} format={(n) => usd(Math.round(n))} sub={`${round.cards.length} cards`} />
      <Counter tone="!bg-[#ffb4a8]" icon={<Flame size={17} />} label="Burned this round" value={round.burnedTokens} format={roundedCompact} sub={usd(round.burnedUsd)} />
      <Counter tone="!bg-[#ffd0a3]" icon={<Flame size={17} />} label="Burned all time" value={state.burnedAllTime.tokens} format={roundedCompact} sub={usd(state.burnedAllTime.usd)} />
      <Counter tone="!bg-[#b9c6ff]" icon={<Package size={17} />} label="Treasury" value={state.treasuryUsd} format={(n) => usd(Math.round(n))} sub="Buys every pack" />
    </section>
  )
}

function DropRing({ seconds }: { seconds: number | null }) {
  const size = 76
  const radius = 32
  const circle = 2 * Math.PI * radius
  const share = seconds === null ? 0 : Math.min(1, seconds / DROP_SECONDS)
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90" aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--color-soft)" strokeWidth="8" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--color-sky)"
          strokeWidth="8"
          strokeDasharray={circle}
          strokeDashoffset={circle * (1 - share)}
        />
      </svg>
      <p className="tnum absolute inset-0 grid place-items-center font-display text-sm font-bold">{seconds === null ? '--:--' : clock(seconds)}</p>
    </div>
  )
}

function TopBurners({ round }: { round: RoundView }) {
  const seconds = useSecondsUntil(round.status === 'live' ? round.nextDropSlot : null)
  const needed = minPacksForDrop()
  const tooShort = round.packsTotal < needed
  const pending = round.drops.some((drop) => drop.status === 'waiting_seed')
  const latest = [...round.drops].reverse().find((drop) => drop.status === 'picked')
  const top = round.topBurners[0]?.rips ?? 1

  return (
    <section className="panel p-6 sm:p-7" aria-label="Top burners">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl">Top burners</h2>
          <p className="mt-1 text-sm text-mute">
            {tooShort
              ? `5-minute drops need ${needed}+ packs. This round has ${round.packsTotal}.`
              : pending
                ? 'Drawing 5 cards from a finalized block now.'
                : 'No winner by zero? 5 random pot cards go to this top 5.'}
          </p>
        </div>
        <DropRing seconds={seconds} />
      </div>

      {round.topBurners.length === 0 ? (
        <p className="mt-5 rounded-xl bg-soft px-4 py-7 text-center text-sm font-semibold text-mute">Nobody has burned yet.</p>
      ) : (
        <ol className="mt-5 grid gap-2">
          {round.topBurners.map((burner, index) => (
            <li key={burner.wallet} className="flex items-center gap-3 rounded-xl bg-soft px-3 py-2">
              <span className={`tnum grid size-6 shrink-0 place-items-center rounded-md font-display text-sm font-extrabold ${index === 0 ? 'bg-gold text-night' : 'text-mute'}`}>{index + 1}</span>
              <Avatar wallet={burner.wallet} size={30} />
              <div className="min-w-0 flex-1">
                <p className="tnum truncate text-sm font-bold">{short(burner.wallet)}</p>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-line">
                  <div className="h-full rounded-full bg-signal transition-[width] duration-300" style={{ width: `${(burner.rips / top) * 100}%` }} />
                </div>
              </div>
              <div className="shrink-0 text-right">
                <p className="tnum flex items-center justify-end gap-1 font-display font-bold">
                  <Flame size={13} className="text-signal" />
                  {compact(burner.tokens)}
                </p>
                <p className="tnum text-xs font-bold text-mute">{usd(burner.usd)}</p>
              </div>
            </li>
          ))}
        </ol>
      )}

      {latest && latest.recipients.length > 0 ? (
        <p className="mt-3 text-sm font-semibold text-mute">
          Last drop sent {latest.recipients.length} {latest.recipients.length === 1 ? 'card' : 'cards'}.
        </p>
      ) : null}
    </section>
  )
}

function LiveRips({ round }: { round: RoundView }) {
  const recent = useMemo(() => [...round.rips].reverse().slice(0, 7), [round.rips])
  return (
    <section className="panel p-6 sm:p-7" aria-label="Live rips">
      <h2 className="flex items-center gap-2.5 text-2xl">
        <span className="live-dot" />
        Live rips
      </h2>
      {recent.length === 0 ? (
        <p className="mt-5 rounded-xl bg-soft px-4 py-7 text-center text-sm font-semibold text-mute">Be the first. It starts the clock.</p>
      ) : (
        <ul className="mt-4 grid gap-1">
          {recent.map((rip) => (
            <li key={rip.signature} className="slide-in flex items-center gap-2.5 rounded-xl px-2 py-1.5">
              <Avatar wallet={rip.wallet} size={26} />
              <span className="tnum flex-1 truncate text-sm font-bold">{short(rip.wallet)}</span>
              {rip.packPrice ? (
                <span className="tier-tag tnum" data-tier={rip.packPrice}>
                  ${rip.packPrice}
                </span>
              ) : null}
              <span className="tnum w-10 text-right font-display text-sm font-extrabold">+{rip.addedSeconds}s</span>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-4 border-t border-line pt-4">
        <p className="eyebrow mb-2">Packs in this round</p>
        <div className="flex flex-wrap gap-1.5">
          {round.lineup.map((tier) => (
            <span key={tier.price} className="tier-tag tnum" data-tier={tier.price}>
              {tier.count} × ${tier.price}
            </span>
          ))}
        </div>
      </div>
    </section>
  )
}

function Pot({ round }: { round: RoundView }) {
  const cards = useMemo(() => [...round.cards].reverse(), [round.cards])
  return (
    <section className="pt-14" aria-label="The pot">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-3xl sm:text-4xl">The pot</h2>
          <p className="mt-1 text-mute">Every rip lands here. The last ripper takes the lot.</p>
        </div>
        <p className="tnum marker font-display text-xl font-extrabold">{usd(round.potUsd)}</p>
      </div>
      {cards.length === 0 ? (
        <p className="panel px-5 py-10 text-center font-semibold text-mute">Rip the first pack to fill it.</p>
      ) : (
        <div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
          {cards.slice(0, 18).map((card) => (
            <div key={card.nft} className="card-lift rise-in min-w-0">
              <div className="relative">
                <Card card={card} tilt />
                {card.reason === 'drop' ? <span className="chip absolute top-2 left-2 h-6 !bg-gold px-1.5 text-xs text-night">Dropped</span> : null}
              </div>
              <CardCaption card={card} />
            </div>
          ))}
        </div>
      )}
      {cards.length > 18 ? <p className="mt-5 text-center font-semibold text-mute">and {cards.length - 18} more</p> : null}
    </section>
  )
}

function Steps() {
  const steps = [
    { icon: Flame, tone: 'bg-[#ffb4a8] text-night', title: 'Burn to rip', text: 'Burn 100K coins and we open a real graded pack from the treasury. That is all you pay.' },
    { icon: Clock, tone: 'bg-[#b9c6ff] text-night', title: 'Keep the clock alive', text: 'Each rip adds 5 seconds, then 3, then 1, then nothing as the crowd piles in.' },
    { icon: Crown, tone: 'bg-gold text-night', title: 'Last rip takes it all', text: 'When the clock hits zero, the last ripper wins every card in the pot.' },
  ]
  return (
    <section className="grid gap-5 pt-14 md:grid-cols-3" aria-label="How it works">
      {steps.map(({ icon: Icon, tone, title, text }) => (
        <div key={title} className="panel card-lift p-7">
          <span className={`grid size-13 place-items-center rounded-xl border-2 border-[var(--edge)] ${tone}`}>
            <Icon size={26} />
          </span>
          <h3 className="mt-5 text-xl">{title}</h3>
          <p className="mt-2 text-mute">{text}</p>
        </div>
      ))}
    </section>
  )
}

function RipStage({ rip, onClose }: { rip: MyRip; onClose(): void }) {
  const { config } = useGame()
  const { card, phase } = rip
  const burn = compact(config?.burnTokens ?? RULES.burnTokens)

  useEffect(() => {
    if (!card && phase !== 'late') return
    const timer = setTimeout(onClose, phase === 'late' ? 9_000 : 6_000)
    return () => clearTimeout(timer)
  }, [card, onClose, phase])

  const color = card?.rarity ? RARITY_COLOR[card.rarity] : undefined
  const hit = card?.rarity === 'Rare' || card?.rarity === 'Epic'

  return (
    <div className="stage" role="dialog" aria-modal="true" aria-label="Ripping your pack">
      {card?.rarity === 'Epic'
        ? Array.from({ length: 32 }, (_, index) => (
            <i
              key={index}
              className="confetti"
              style={{
                left: `${(index * 29) % 100}%`,
                background: CONFETTI[index % CONFETTI.length],
                animationDuration: `${2.4 + (index % 5) * 0.5}s`,
                animationDelay: `${-(index % 8) * 0.5}s`,
              }}
            />
          ))
        : null}
      <button type="button" onClick={onClose} aria-label="Close" className="stage-close">
        <X size={20} />
      </button>

      <div className="flex min-h-full flex-col items-center justify-center overflow-hidden px-6 py-14 [perspective:1100px]">
        {phase === 'late' ? (
          <div className="rise-in max-w-xs text-center">
            <Ticket size={44} className="mx-auto text-gold" />
            <h2 className="mt-4 text-3xl">That one landed late</h2>
            <p className="mt-2 text-white/70">Your burn is safe as a voucher. It gives you a free rip in a later round.</p>
          </div>
        ) : card ? (
          <>
            <div className="relative grid place-items-center">
              {hit ? <div className="beams" /> : null}
              <div className="flash" />
              <div className="flip-in relative w-[min(62vw,250px)]" style={{ transformStyle: 'preserve-3d' }}>
                <Card card={card} tilt foil={hit ? 0.6 : 0.25} />
              </div>
            </div>
            <div className="rise-in mt-7 max-w-[22rem] text-center [animation-delay:900ms]">
              <p className="text-lg leading-snug font-bold">{card.name}</p>
              <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
                <span className="chip text-night">
                  <span className="size-2.5 rounded-sm" style={{ background: color }} />
                  {card.rarity ?? 'Graded'}
                </span>
                <span className="chip text-night">${card.packPrice} pack</span>
                {card.insuredValue != null ? <span className="chip !bg-gold text-night">{usd(card.insuredValue)}</span> : null}
              </div>
              <p className="mt-4 font-medium text-white/80">In the pot. Keep ripping to keep it.</p>
            </div>
          </>
        ) : (
          <div className="flex flex-col items-center">
            <div className={phase === 'landing' ? 'pack-shake' : 'pack-turn'}>
              <Pack width={210} torn={false} />
            </div>
            <p className="mt-9 font-display text-2xl font-extrabold">{phase === 'landing' ? `Burning ${burn}…` : 'Ripping your pack…'}</p>
          </div>
        )}
      </div>
    </div>
  )
}

function WinStage({ round, settled, onClose }: { round: RoundView; settled: boolean; onClose(): void }) {
  const { address } = useWallet()
  const won = round.cards.filter((card) => card.reason === 'win')
  // The next round starts as soon as this one settles, which ends live updates for it.
  const delivered = settled ? won.length : won.filter((card) => card.delivered).length
  const total = won.reduce((sum, card) => sum + (card.insuredValue ?? 0), 0)
  const mine = address === round.winner
  return (
    <div className="stage" data-tone="win" role="dialog" aria-modal="true" aria-label="Round result">
      {Array.from({ length: 36 }, (_, index) => (
        <i
          key={index}
          className="confetti"
          style={{
            left: `${(index * 29) % 100}%`,
            background: CONFETTI[index % CONFETTI.length],
            animationDuration: `${2.6 + (index % 5) * 0.5}s`,
            animationDelay: `${-(index % 8) * 0.6}s`,
          }}
        />
      ))}
      <button type="button" onClick={onClose} aria-label="Close" className="stage-close">
        <X size={20} />
      </button>
      <div className="relative mx-auto flex min-h-full w-full max-w-3xl flex-col items-center justify-center px-5 py-12 text-center">
        <span className="chip text-night">Round {round.id}</span>
        <h1 className="mt-5 text-5xl leading-[0.98] sm:text-7xl">
          {mine ? 'You took it all' : 'Last rip took it all'}
        </h1>
        <p className="mt-5 flex items-center justify-center gap-2 font-semibold">
          {round.endReason === 'sold_out' ? 'Final pack:' : 'Last ripper:'}
          {round.winner ? <Avatar wallet={round.winner} size={22} /> : null}
          <span className="tnum font-extrabold">{short(round.winner)}</span>
        </p>
        <p className="tnum mt-6 font-display text-6xl font-extrabold sm:text-8xl">{usd(total)}</p>
        <p className="mt-2 font-semibold">
          {won.length} {won.length === 1 ? 'card' : 'cards'} · {delivered} of {won.length} delivered
        </p>
        <div className="mt-7 flex max-w-full flex-wrap justify-center gap-2.5">
          {won.slice(0, 14).map((card) => (
            <div key={card.nft} className={`w-[68px] transition-opacity sm:w-[84px] ${settled || card.delivered ? '' : 'opacity-50'}`}>
              <Card card={card} />
            </div>
          ))}
        </div>
        {won.length > 14 ? <p className="mt-3 text-sm font-semibold">and {won.length - 14} more</p> : null}
        <button type="button" onClick={onClose} className="pill pill-ink mt-8 h-14 px-9 text-lg">
          Keep ripping
          <ArrowRight size={19} />
        </button>
      </div>
    </div>
  )
}

function Waiting({ state }: { state: GameState }) {
  const seconds = useSecondsUntil(state.nextRoundSlot)
  const filling = state.treasuryUsd < MIN_TREASURY
  const percent = Math.min(100, (state.treasuryUsd / MIN_TREASURY) * 100)
  return (
    <section className="hero-band grid items-center gap-10 lg:grid-cols-2">
      <div className="rise-in text-center lg:text-left">
        <ContractAddress className="mb-5 justify-center lg:justify-start" />
        <h1 className="text-5xl leading-[1.02] text-white sm:text-6xl">
          {filling ? 'Filling the treasury.' : 'Next round soon.'}
          <br />
          <span className="marker">Keep ripping.</span>
        </h1>
        {filling ? (
          <div className="panel mt-7 p-6 text-left text-ink">
            <div className="flex items-baseline justify-between gap-3">
              <p className="eyebrow">Next round opens at {usd(MIN_TREASURY)}</p>
              <p className="tnum font-display text-xl font-bold">{usd(state.treasuryUsd)}</p>
            </div>
            <div className="mt-3 h-4 overflow-hidden rounded-md border-2 border-[var(--edge)] bg-soft" role="progressbar" aria-valuenow={Math.round(percent)} aria-valuemin={0} aria-valuemax={100}>
              <div className="h-full rounded-full bg-sky transition-[width] duration-700" style={{ width: `${percent}%` }} />
            </div>
            <p className="mt-3 text-sm text-mute">Trading fees fund every pack.</p>
          </div>
        ) : (
          <div className="scoreboard mt-7 inline-block">
            <p className="clock text-7xl">{seconds === null ? '--:--' : clock(seconds)}</p>
          </div>
        )}
      </div>
      <div className="flex justify-center">
        <div className="bob">
          <Pack width={230} />
        </div>
      </div>
    </section>
  )
}

export function GamePage() {
  const { state } = useGame()
  const ripper = useRipper()
  const [closedRound, setClosedRound] = useState<number | null>(null)
  const [winRound, setWinRound] = useState<RoundView | null>(null)
  const round = state?.round ?? null
  const active = ripper.rips[0]
  const winnerKnown = round?.winner && ['resolved', 'delivering'].includes(round.status)

  // Hold on to the result: the next round replaces this one as soon as it settles.
  useEffect(() => {
    if (round && winnerKnown && round.id !== closedRound) setWinRound(round)
  }, [round, winnerKnown, closedRound])

  const winSettled = winRound !== null && round?.id !== winRound.id
  useEffect(() => {
    if (!winSettled) return
    const timer = setTimeout(() => setWinRound(null), 12_000)
    return () => clearTimeout(timer)
  }, [winSettled])

  const closeWin = () => {
    if (winRound) setClosedRound(winRound.id)
    setWinRound(null)
  }

  if (!state) {
    return <p className="py-24 text-center font-display text-xl font-semibold text-mute">Shuffling the deck…</p>
  }

  return (
    <>
      {round && round.status !== 'sized' ? (
        <>
          <Hero state={state} round={round} ripper={ripper} />
          <CardTicker cards={round.cards} />
          <Counters state={state} round={round} />
          <div className="grid gap-5 pt-6 lg:grid-cols-[1.15fr_1fr]">
            <TopBurners round={round} />
            <LiveRips round={round} />
          </div>
          <Pot round={round} />
          <Steps />
        </>
      ) : (
        <Waiting state={state} />
      )}
      {active ? <RipStage key={active.signature} rip={active} onClose={() => ripper.dismiss(active.signature)} /> : null}
      {winRound ? <WinStage round={winRound} settled={winSettled} onClose={closeWin} /> : null}
    </>
  )
}

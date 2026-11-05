import { useRef } from 'react'
import type { CardView } from '../../../shared/api.ts'
import { usd } from '../lib/format.ts'
import { Mark } from './Logo.tsx'

export const RARITY_COLOR: Record<string, string> = {
  Common: 'var(--color-common)',
  Uncommon: 'var(--color-uncommon)',
  Rare: 'var(--color-rare)',
  Epic: 'var(--color-epic)',
}

type CardArt = Pick<CardView, 'name' | 'image' | 'rarity'>

/** Shown when a card has no image. Original art, not a real card. */
function Placeholder({ name }: { name: string }) {
  const seed = [...name].reduce((sum, char) => sum + char.charCodeAt(0), 0)
  const hue = seed % 360
  return (
    <div
      className="flex h-full w-full flex-col justify-between p-[8%]"
      style={{ background: `linear-gradient(150deg, hsl(${hue} 75% 66%), hsl(${(hue + 50) % 360} 70% 48%))` }}
    >
      <span className="font-display text-[0.6rem] font-semibold text-white/85">Sample</span>
      <div className="aspect-square w-full rounded-full bg-white/20" />
      <span className="truncate font-display text-[0.62rem] font-medium text-white/90">{name}</span>
    </div>
  )
}

/** A trading card. With `tilt` it leans toward the pointer and the foil follows. */
export function Card({ card, tilt = false, foil, className = '' }: { card: CardArt; tilt?: boolean; foil?: number; className?: string }) {
  const element = useRef<HTMLDivElement>(null)
  const strength = foil ?? (card.rarity === 'Epic' ? 0.55 : card.rarity === 'Rare' ? 0.35 : 0.14)

  const follow = (event: React.PointerEvent) => {
    const node = element.current
    if (!tilt || !node) return
    const box = node.getBoundingClientRect()
    const x = (event.clientX - box.left) / box.width
    const y = (event.clientY - box.top) / box.height
    node.style.setProperty('--mx', `${x * 100}%`)
    node.style.setProperty('--my', `${y * 100}%`)
    node.style.transform = `perspective(700px) rotateX(${(0.5 - y) * 16}deg) rotateY(${(x - 0.5) * 16}deg)`
  }
  const rest = () => {
    if (element.current) element.current.style.transform = ''
  }

  return (
    <div
      ref={element}
      className={`tcard ${className}`}
      data-rarity={card.rarity ?? undefined}
      style={{ '--foil': strength } as React.CSSProperties}
      onPointerMove={follow}
      onPointerLeave={rest}
    >
      <div className="tcard-face">
        {card.image ? (
          <img
            src={card.image}
            alt={card.name}
            loading="lazy"
            className="h-full w-full object-contain"
            onError={(event) => {
              event.currentTarget.style.display = 'none'
            }}
          />
        ) : (
          <Placeholder name={card.name} />
        )}
        <div className="foil" />
      </div>
      <div className="tcard-back">
        <Mark size={54} className="opacity-90" />
      </div>
    </div>
  )
}

export function CardCaption({ card }: { card: CardView }) {
  return (
    <div className="mt-2.5 min-w-0 px-0.5">
      <p className="truncate text-xs font-bold leading-tight">{card.name}</p>
      <p className="mt-0.5 flex items-center gap-1.5 text-xs">
        <span className="tnum font-display font-semibold">{card.insuredValue != null ? usd(card.insuredValue) : '…'}</span>
        {card.rarity ? (
          <span className="font-bold" style={{ color: RARITY_COLOR[card.rarity] }}>
            {card.rarity}
          </span>
        ) : null}
      </p>
    </div>
  )
}

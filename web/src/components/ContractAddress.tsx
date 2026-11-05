import { useState } from 'react'
import { Check, Copy, ExternalLink } from 'lucide-react'
import { useGame } from '../lib/game.tsx'

/** The coin's contract address, ready to copy. Shows nothing fake before launch. */
export function ContractAddress({ className = '' }: { className?: string }) {
  const { config } = useGame()
  const [copied, setCopied] = useState(false)
  const address = config?.contractAddress

  if (!config) return null
  if (!address) {
    return (
      <div className={`chip w-fit text-night ${className}`}>
        <span className="font-extrabold">CA</span>
        <span className="text-night/60">coming soon</span>
      </div>
    )
  }

  const copy = () => {
    void navigator.clipboard.writeText(address).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1_500)
    })
  }

  return (
    <div className={`flex max-w-full items-center gap-1.5 ${className}`}>
      <button
        type="button"
        onClick={copy}
        title="Copy contract address"
        className="flex min-w-0 items-center gap-2 rounded-lg border-2 border-night bg-white px-2 py-1 text-left text-night hover:bg-gold"
      >
        <span className="text-xs font-extrabold">CA</span>
        <span className="min-w-0 font-mono text-[0.68rem] font-medium break-all sm:text-xs">{address}</span>
        {copied ? <Check size={15} className="shrink-0" /> : <Copy size={15} className="shrink-0" />}
        <span className="sr-only" aria-live="polite">
          {copied ? 'Copied' : ''}
        </span>
      </button>
      <a
        href={`https://pump.fun/coin/${address}`}
        target="_blank"
        rel="noreferrer"
        title="View on pump.fun"
        aria-label="View on pump.fun"
        className="grid size-9 shrink-0 place-items-center rounded-lg border-2 border-night bg-white text-night hover:bg-gold"
      >
        <ExternalLink size={15} />
      </a>
    </div>
  )
}

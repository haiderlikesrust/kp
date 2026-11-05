import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { GameState, PublicConfig } from '../../../shared/api.ts'
import { SLOT_MS } from '../../../shared/rules.ts'

interface GameContextValue {
  state: GameState | null
  config: PublicConfig | null
  connected: boolean
  /** Best guess at the chain's slot right now, between server updates. */
  estimatedSlot(): number
}

const GameContext = createContext<GameContextValue | null>(null)

export function GameProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<GameState | null>(null)
  const [config, setConfig] = useState<PublicConfig | null>(null)
  const [connected, setConnected] = useState(false)
  const anchor = useRef({ slot: 0, at: 0 })

  useEffect(() => {
    fetch('/api/config')
      .then((res) => res.json())
      .then(setConfig)
      .catch(() => {})
  }, [])

  useEffect(() => {
    const stream = new EventSource('/api/stream')
    let lost: ReturnType<typeof setTimeout> | undefined
    const reconnected = () => {
      clearTimeout(lost)
      lost = undefined
      setConnected(true)
    }
    stream.onopen = reconnected
    stream.onerror = () => {
      // A deploy drops the stream for a moment. Only say so if it lasts.
      lost ??= setTimeout(() => setConnected(false), 4_000)
    }
    stream.onmessage = (event) => {
      reconnected()
      const next = JSON.parse(event.data) as GameState
      anchor.current = { slot: next.serverSlot, at: Date.now() }
      setState(next)
    }
    return () => {
      clearTimeout(lost)
      stream.close()
    }
  }, [])

  const value: GameContextValue = {
    state,
    config,
    connected,
    estimatedSlot: () => anchor.current.slot + (Date.now() - anchor.current.at) / SLOT_MS,
  }
  return <GameContext.Provider value={value}>{children}</GameContext.Provider>
}

export function useGame(): GameContextValue {
  const value = useContext(GameContext)
  if (!value) throw new Error('useGame outside GameProvider')
  return value
}

/** Seconds until a slot, redrawn often enough for a smooth countdown. */
export function useSecondsUntil(slot: number | null | undefined): number | null {
  const { estimatedSlot } = useGame()
  const [, redraw] = useState(0)
  useEffect(() => {
    if (slot == null) return
    const timer = setInterval(() => redraw((tick) => tick + 1), 100)
    return () => clearInterval(timer)
  }, [slot])
  if (slot == null) return null
  return Math.max(0, ((slot - estimatedSlot()) * SLOT_MS) / 1000)
}

import { useCallback, useEffect, useState } from 'react'
import type { CardView, WalletView } from '../../../shared/api.ts'
import { useGame } from './game.tsx'
import { useWallet } from './wallet.tsx'

export type RipPhase = 'landing' | 'counted' | 'late'

export interface MyRip {
  signature: string
  phase: RipPhase
  startedAt: number
  card: CardView | null
}

const GIVE_UP_MS = 45_000

async function post(path: string, body: unknown): Promise<any> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data?.error ?? 'Request failed')
  return data
}

/** Sends the signature a few times: the first posts can beat the transaction. */
function hint(signature: string, onRejected: () => void): void {
  let tries = 0
  const send = () => {
    post('/api/rips', { signature })
      .then(({ result }) => {
        if (result === 'pending' && tries++ < 8) setTimeout(send, 1_200)
        // Wallets return once they send, so a failed burn only shows up here.
        if (result === 'rejected') onRejected()
      })
      .catch(() => {})
  }
  send()
}

function friendlyError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  if (/reject|denied|cancel/i.test(message)) return 'Cancelled in your wallet.'
  if (/insufficient|0x1\b/i.test(message)) return `Not enough coins to burn.`
  if (/dynamically imported module|importing a module/i.test(message)) return 'A new version just went live. Refresh and rip again.'
  return message.length > 90 ? 'That did not go through. Try again.' : message
}

export function useRipper() {
  const { state, config } = useGame()
  const { address, isDemo, signAndSend } = useWallet()
  const [rips, setRips] = useState<MyRip[]>([])
  const [signing, setSigning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [walletView, setWalletView] = useState<WalletView | null>(null)
  const round = state?.round ?? null
  const roundId = round?.id

  const refreshWallet = useCallback(async () => {
    if (!address) return setWalletView(null)
    const view = await fetch(`/api/wallet/${address}`).then((res) => (res.ok ? res.json() : null)).catch(() => null)
    setWalletView(view)
  }, [address])

  useEffect(() => {
    void refreshWallet()
  }, [refreshWallet, roundId, round?.status])

  // Follow each rip through the live state.
  useEffect(() => {
    if (!round) return
    setRips((current) => {
      let changed = false
      const next = current.map((rip) => {
        const counted = round.rips.some((entry) => entry.signature === rip.signature)
        const card = round.cards.find((entry) => entry.ripSig === rip.signature) ?? null
        const expired = rip.phase === 'landing' && Date.now() - rip.startedAt > GIVE_UP_MS
        const ended = !['open', 'live'].includes(round.status) || round.packsRipped >= round.packsTotal
        let phase = rip.phase
        if (counted) phase = 'counted'
        else if (rip.phase === 'landing' && ended && Date.now() - rip.startedAt > 8_000) phase = 'late'
        else if (expired) phase = 'late'
        if (phase === rip.phase && card === rip.card) return rip
        changed = true
        return { ...rip, phase, card: card ?? rip.card }
      })
      return changed ? next : current
    })
  }, [round])

  const begin = useCallback(
    async (send: () => Promise<string>) => {
      setError(null)
      setSigning(true)
      try {
        const signature = await send()
        setRips((current) => [...current, { signature, phase: 'landing', startedAt: Date.now(), card: null }])
        hint(signature, () => {
          setRips((current) => current.filter((entry) => entry.signature !== signature))
          setError('That did not go through. Check you hold enough coins, then try again.')
        })
      } catch (err) {
        setError(friendlyError(err))
      } finally {
        setSigning(false)
      }
    },
    [],
  )

  const rip = useCallback(() => {
    if (!address || !config || !roundId) return
    void begin(async () => {
      if (isDemo) return (await post('/api/mock/rip', { wallet: address, roundId })).signature
      const { buildRip } = await import('./transactions.ts')
      return signAndSend(await buildRip(config, address, roundId))
    })
  }, [address, begin, config, isDemo, roundId, signAndSend])

  const ripWithVoucher = useCallback(
    (originSig: string) => {
      if (!address || !config || !roundId) return
      void begin(async () => {
        if (isDemo) return (await post('/api/mock/redeem', { wallet: address, roundId, originSig })).signature
        const { buildVoucherRip } = await import('./transactions.ts')
        return signAndSend(await buildVoucherRip(config, address, roundId, originSig))
      }).then(() => refreshWallet())
    },
    [address, begin, config, isDemo, refreshWallet, roundId, signAndSend],
  )

  const dismiss = useCallback((signature: string) => {
    setRips((current) => current.filter((entry) => entry.signature !== signature))
  }, [])

  return { rips, signing, error, rip, ripWithVoucher, dismiss, vouchers: walletView?.vouchers ?? [] }
}

export type Ripper = ReturnType<typeof useRipper>

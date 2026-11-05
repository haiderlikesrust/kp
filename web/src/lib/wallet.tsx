import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { getWallets } from '@wallet-standard/app'
import type { Wallet, WalletAccount } from '@wallet-standard/base'
import bs58 from 'bs58'
import { useGame } from './game.tsx'

const CONNECT = 'standard:connect'
const SIGN_AND_SEND = 'solana:signAndSendTransaction'
const DEMO_KEY = 'keepripping-demo-wallet'

function usableWallet(wallet: Wallet): boolean {
  return (
    wallet.chains.some((chain) => chain.startsWith('solana:')) &&
    CONNECT in wallet.features &&
    SIGN_AND_SEND in wallet.features
  )
}

function demoAddress(): string {
  try {
    const saved = sessionStorage.getItem(DEMO_KEY)
    if (saved) return saved
    const address = bs58.encode(crypto.getRandomValues(new Uint8Array(32)))
    sessionStorage.setItem(DEMO_KEY, address)
    return address
  } catch {
    return bs58.encode(crypto.getRandomValues(new Uint8Array(32)))
  }
}

interface WalletContextValue {
  address: string | null
  isDemo: boolean
  wallets: readonly Wallet[]
  pickerOpen: boolean
  openPicker(): void
  closePicker(): void
  connect(wallet: Wallet): Promise<void>
  useDemo(): void
  disconnect(): void
  /** Signs and sends with the connected wallet, returning the signature. */
  signAndSend(transaction: Uint8Array): Promise<string>
}

const WalletContext = createContext<WalletContextValue | null>(null)

export function WalletProvider({ children }: { children: ReactNode }) {
  const { config } = useGame()
  const [wallets, setWallets] = useState<readonly Wallet[]>([])
  const [active, setActive] = useState<{ wallet: Wallet; account: WalletAccount } | null>(null)
  const [demo, setDemo] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)

  useEffect(() => {
    const registry = getWallets()
    const refresh = () => setWallets(registry.get().filter(usableWallet))
    refresh()
    const off = [registry.on('register', refresh), registry.on('unregister', refresh)]
    return () => off.forEach((unsubscribe) => unsubscribe())
  }, [])

  const connect = useCallback(async (wallet: Wallet) => {
    const feature = wallet.features[CONNECT] as {
      connect(): Promise<{ accounts: readonly WalletAccount[] }>
    }
    const { accounts } = await feature.connect()
    const account = accounts[0]
    if (!account) throw new Error('The wallet returned no account')
    setActive({ wallet, account })
    setPickerOpen(false)
  }, [])

  const signAndSend = useCallback(
    async (transaction: Uint8Array) => {
      if (!active) throw new Error('Connect a wallet first')
      const feature = active.wallet.features[SIGN_AND_SEND] as {
        signAndSendTransaction(input: {
          account: WalletAccount
          chain: string
          transaction: Uint8Array
          options?: { commitment?: string; skipPreflight?: boolean }
        }): Promise<readonly { signature: Uint8Array }[]>
      }
      const chain = config?.mode === 'devnet' ? 'solana:devnet' : 'solana:mainnet'
      const [result] = await feature.signAndSendTransaction({
        account: active.account,
        chain,
        transaction,
        // Skip preflight so a rip in the last seconds loses no time to simulation.
        options: { commitment: 'confirmed', skipPreflight: true },
      })
      if (!result) throw new Error('The wallet did not return a signature')
      return bs58.encode(result.signature)
    },
    [active, config?.mode],
  )

  const value = useMemo<WalletContextValue>(
    () => ({
      address: demo ?? active?.account.address ?? null,
      isDemo: demo !== null,
      wallets,
      pickerOpen,
      openPicker: () => setPickerOpen(true),
      closePicker: () => setPickerOpen(false),
      connect,
      useDemo: () => {
        setDemo(demoAddress())
        setPickerOpen(false)
      },
      disconnect: () => {
        setActive(null)
        setDemo(null)
      },
      signAndSend,
    }),
    [active, demo, wallets, pickerOpen, connect, signAndSend],
  )

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>
}

export function useWallet(): WalletContextValue {
  const value = useContext(WalletContext)
  if (!value) throw new Error('useWallet outside WalletProvider')
  return value
}

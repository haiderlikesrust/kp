import { useEffect, useState } from 'react'
import { Link, NavLink, Outlet } from 'react-router-dom'
import { FlaskConical, LogOut, Moon, Sun, Wallet, X } from 'lucide-react'
import { short } from '../lib/format.ts'
import { useGame } from '../lib/game.tsx'
import { useWallet } from '../lib/wallet.tsx'
import { Avatar } from './Avatar.tsx'
import { ContractAddress } from './ContractAddress.tsx'
import { Mark, Wordmark, XLogo } from './Logo.tsx'

const X_HANDLE = 'keepripping'
const X_URL = `https://x.com/${X_HANDLE}`

const LINKS = [
  { to: '/', label: 'Rip', end: true },
  { to: '/history', label: 'History', end: false },
  { to: '/how', label: 'How it works', end: false },
]

const THEME_KEY = 'keepripping-theme'

function useTheme() {
  const [dark, setDark] = useState(() => {
    try {
      return localStorage.getItem(THEME_KEY) !== 'light'
    } catch {
      return true
    }
  })
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    try {
      localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light')
    } catch {
      // Storage blocked: the choice lasts this visit.
    }
  }, [dark])
  return { dark, toggle: () => setDark(!dark) }
}

function ConnectDialog() {
  const { pickerOpen, closePicker, wallets, connect, useDemo } = useWallet()
  const { state } = useGame()
  const [error, setError] = useState<string | null>(null)
  if (!pickerOpen) return null
  const mock = state?.mode === 'mock'

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-night/60 p-4 sm:items-center" onClick={closePicker}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Connect a wallet"
        className="panel rise-in w-full max-w-sm p-6"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <Mark size={44} />
          <button type="button" aria-label="Close" onClick={closePicker} className="grid size-9 place-items-center rounded-lg text-mute hover:bg-soft">
            <X size={18} />
          </button>
        </div>
        <h2 className="mt-3 text-2xl">Connect a wallet</h2>
        <p className="mt-1 text-sm text-mute">You only sign when you rip. Connecting never approves a transaction.</p>
        <div className="mt-5 grid gap-2.5">
          {wallets.map((wallet) => (
            <button
              type="button"
              key={wallet.name}
              onClick={() => connect(wallet).catch(() => setError('The wallet did not connect.'))}
              className="pill pill-ghost h-14 justify-start px-4 text-base"
            >
              <img src={wallet.icon} alt="" className="size-7 rounded-lg" />
              {wallet.name}
            </button>
          ))}
          {wallets.length === 0 && !mock ? (
            <p className="rounded-xl bg-soft p-4 text-sm text-mute">No Solana wallet found. Install Phantom, Solflare or Backpack, then reload this page.</p>
          ) : null}
          {mock ? (
            <button type="button" onClick={useDemo} className="pill pill-rip h-14 text-base">
              <FlaskConical size={17} />
              Use a practice wallet
            </button>
          ) : null}
        </div>
        {error ? <p className="mt-3 text-sm font-bold text-signal">{error}</p> : null}
      </div>
    </div>
  )
}

function WalletControl() {
  const { address, openPicker, disconnect } = useWallet()
  if (!address) {
    return (
      <button type="button" onClick={openPicker} className="flex h-9 items-center gap-1.5 rounded-lg bg-gold px-3 font-display text-sm font-bold text-night hover:brightness-105">
        <Wallet size={15} />
        Connect
      </button>
    )
  }
  return (
    <div className="flex h-9 items-center gap-0.5 rounded-lg bg-white/10 pr-0.5 pl-2">
      <span className="tnum flex items-center gap-1.5 text-sm font-bold" title={address}>
        <Avatar wallet={address} size={18} />
        {short(address)}
      </span>
      <button type="button" onClick={disconnect} aria-label="Disconnect" title="Disconnect" className="grid size-8 place-items-center rounded-md text-white/60 hover:bg-white/15 hover:text-white">
        <LogOut size={14} />
      </button>
    </div>
  )
}

function Navbar() {
  const { state } = useGame()
  const theme = useTheme()

  return (
    <header className="nav-rail">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-2 gap-y-2 px-4 py-2 sm:gap-x-3 sm:px-6 md:h-[58px] md:flex-nowrap md:py-0">
        <Link to="/" aria-label="KeepRipping home" className="shrink-0 rounded-lg">
          <Wordmark onDark size="text-[1.1rem] sm:text-[1.25rem]" />
        </Link>

        <nav aria-label="Main" className="nav-tabs order-last w-full md:order-none md:ml-3 md:w-auto">
          {LINKS.map((link) => (
            <NavLink key={link.to} to={link.to} end={link.end} className="nav-tab">
              <span>{link.label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2 lg:gap-3">
          {state?.mode === 'mock' ? (
            <span title="Practice mode: nothing is real" className="hidden items-center gap-1 text-xs font-bold text-gold sm:flex">
              <FlaskConical size={13} />
              Practice
            </span>
          ) : null}
          <a
            href={X_URL}
            target="_blank"
            rel="noreferrer"
            aria-label={`KeepRipping on X, @${X_HANDLE}`}
            title={`@${X_HANDLE} on X`}
            className="grid size-9 place-items-center rounded-lg text-white/70 hover:bg-white/10 hover:text-white"
          >
            <XLogo size={15} />
          </a>
          <button
            type="button"
            onClick={theme.toggle}
            aria-label={theme.dark ? 'Switch to light mode' : 'Switch to dark mode'}
            className="hidden size-9 place-items-center rounded-lg text-white/70 hover:bg-white/10 hover:text-white sm:grid"
          >
            {theme.dark ? <Sun size={17} /> : <Moon size={17} />}
          </button>
          <WalletControl />
        </div>
      </div>
    </header>
  )
}

export function Layout() {
  const { state, connected } = useGame()
  return (
    <>
      <Navbar />

      {state && !connected ? (
        <div className="mx-auto mt-4 max-w-6xl px-4 sm:px-6">
          <p className="rounded-xl border-2 border-[var(--edge)] bg-signal-soft px-4 py-2 text-center text-sm font-bold text-night">Reconnecting… the timer here may be out of date.</p>
        </div>
      ) : null}
      {state?.paused ? (
        <div className="mx-auto mt-4 max-w-6xl px-4 sm:px-6">
          <p className="rounded-xl border-2 border-[var(--edge)] bg-gold-soft px-4 py-2 text-center text-sm font-bold text-night">Paused for maintenance. Rips that land now still count, and packs open when we are back.</p>
        </div>
      ) : null}

      <main className="mx-auto max-w-6xl px-4 pb-16 sm:px-6">
        <Outlet />
      </main>

      <footer className="mx-auto max-w-6xl px-4 pb-10 sm:px-6">
        <div className="panel grid gap-6 p-7 sm:p-9 md:grid-cols-[1.2fr_1fr]">
          <div>
            <Wordmark size="text-3xl" />
            <p className="mt-3 max-w-sm font-medium text-mute">Keep ripping. Last rip takes it all.</p>
            <ContractAddress className="mt-4" />
          </div>
          <div className="grid content-start gap-3">
            <nav aria-label="Footer" className="flex flex-wrap gap-x-5 gap-y-1 font-display font-semibold">
              {LINKS.map((link) => (
                <Link key={link.to} to={link.to} className="text-mute hover:text-ink">
                  {link.label}
                </Link>
              ))}
              <a href={X_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-mute hover:text-ink">
                <XLogo size={13} />@{X_HANDLE}
              </a>
            </nav>
            <p className="text-xs leading-relaxed text-faint">
              Independent project, not affiliated with Nintendo, The Pokémon Company or Collector Crypt. Cards are
              vaulted, tokenized collectibles, valued at Collector Crypt’s insured value. Burned coins are gone for good.
              Check the rules where you live before playing.
            </p>
          </div>
        </div>
      </footer>
      <ConnectDialog />
    </>
  )
}

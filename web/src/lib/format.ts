export const short = (address: string | null | undefined): string =>
  address ? `${address.slice(0, 4)}…${address.slice(-4)}` : '—'

export const usd = (amount: number): string =>
  `$${amount.toLocaleString('en-US', { maximumFractionDigits: amount < 100 ? 2 : 0 })}`

export const compact = (amount: number): string =>
  amount >= 1_000_000 ? `${amount / 1_000_000}M` : amount >= 1_000 ? `${amount / 1_000}K` : String(amount)

/** 01:30 normally, 9.4 inside the last ten seconds. */
export function clock(seconds: number): string {
  const left = Math.max(0, seconds)
  if (left < 10) return left.toFixed(1).padStart(4, '0')
  const whole = Math.ceil(left)
  return `${String(Math.floor(whole / 60)).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`
}

export function explorerTx(signature: string, cluster: string): string {
  return `https://solscan.io/tx/${signature}${cluster}`
}

export function explorerAccount(address: string, cluster: string): string {
  return `https://solscan.io/account/${address}${cluster}`
}

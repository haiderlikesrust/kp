/** A small colour disc derived from the address, so wallets are recognisable at a glance. */
export function Avatar({ wallet, size = 24 }: { wallet: string; size?: number }) {
  let hash = 0
  for (const char of wallet) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  const first = hash % 360
  const second = (first + 70 + (hash >> 8) % 120) % 360
  return (
    <span
      aria-hidden="true"
      className="inline-block shrink-0 rounded-full"
      style={{
        width: size,
        height: size,
        background: `conic-gradient(from ${hash % 360}deg, hsl(${first} 85% 62%), hsl(${second} 85% 58%), hsl(${first} 85% 62%))`,
        boxShadow: '0 0 0 2px rgb(0 0 0 / 0.35)',
      }}
    />
  )
}

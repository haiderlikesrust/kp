/** A stand-in mark until the final logo lands: a pack mid-rip. */
export function Mark({ size = 30, className = '' }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" className={className} aria-hidden="true">
      <path
        d="M6.5 14.2 9.6 16.8 12.8 14.2 16 16.8 19.2 14.2 22.4 16.8 25.5 14.2V26.5A2 2 0 0 1 23.500 28.500H8.500A2 2 0 0 1 6.500 26.500Z"
        fill="var(--color-sky)"
      />
      <path
        d="M7.800 11.400 8.900 6.200A1.500 1.500 0 0 1 10.700 5L24.500 8A1.500 1.500 0 0 1 25.600 9.800L24.600 14.400 21.200 12.400 18.600 14.800 15.400 12.900 12.600 14.800 9.800 12.500Z"
        fill="var(--color-gold)"
        stroke="var(--color-night)"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function XLogo({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  )
}

export function Wordmark({ className = '', size = 'text-[1.4rem]', onDark = false }: { className?: string; size?: string; onDark?: boolean }) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <Mark />
      <span className={`font-display font-extrabold leading-none tracking-[-0.04em] ${onDark ? 'text-[#fff8e8]' : 'text-ink'} ${size}`}>
        keep<span className={onDark ? 'text-gold' : 'burn-text'}>ripping</span>
      </span>
    </span>
  )
}

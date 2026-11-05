interface PackProps {
  width?: number
  torn?: boolean
  className?: string
}

export function Pack({ width = 200, torn = false, className = '' }: PackProps) {
  return (
    <div
      className={`pack ${className}`}
      style={{ '--w': `${width}px` } as React.CSSProperties}
      data-torn={torn}
      aria-hidden="true"
    >
      <div className="pack-part pack-body">
        <div className="pack-stripes" />
        <div className="pack-sheen" />
        <div className="absolute inset-0 flex flex-col items-center justify-center pt-[12%] text-night">
          <span className="font-display font-extrabold leading-[0.92] tracking-[-0.04em]" style={{ fontSize: width * 0.19 }}>
            keep
          </span>
          <span className="font-display font-extrabold leading-[0.92] tracking-[-0.04em] text-[#2238d8]" style={{ fontSize: width * 0.19 }}>
            ripping
          </span>
          <span
            className="mt-3 rounded-md bg-night px-2.5 py-0.5 font-bold text-gold"
            style={{ fontSize: Math.max(10, width * 0.058) }}
          >
            1 graded card
          </span>
        </div>
      </div>
      <div className="pack-part pack-top" />
    </div>
  )
}

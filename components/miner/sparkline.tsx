interface SparklineProps {
  data: number[]
  className?: string
}

const WIDTH = 600
const HEIGHT = 120

export function Sparkline({ data, className }: SparklineProps) {
  const peak = Math.max(...data, 1)
  const points = data.map((value, index) => {
    const x = data.length <= 1 ? WIDTH : (index / (data.length - 1)) * WIDTH
    const y = HEIGHT - (value / peak) * (HEIGHT - 10) - 5
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })

  const line = points.join(' ')
  const area = points.length > 0 ? `0,${HEIGHT} ${line} ${WIDTH},${HEIGHT}` : ''

  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      preserveAspectRatio="none"
      className={className}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="hashrate-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--primary)" stopOpacity="0.28" />
          <stop offset="100%" stopColor="var(--primary)" stopOpacity="0" />
        </linearGradient>
      </defs>
      {[0.25, 0.5, 0.75].map((ratio) => (
        <line
          key={ratio}
          x1="0"
          x2={WIDTH}
          y1={HEIGHT * ratio}
          y2={HEIGHT * ratio}
          stroke="var(--border)"
          strokeWidth="1"
          strokeDasharray="2 6"
          vectorEffect="non-scaling-stroke"
        />
      ))}
      {area && <polygon points={area} fill="url(#hashrate-fill)" />}
      {line && (
        <polyline
          points={line}
          fill="none"
          stroke="var(--primary)"
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      )}
    </svg>
  )
}

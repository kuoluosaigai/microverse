/**
 * Minimal SVG sparkline. Zero dependencies. Editorial: thin line, single accent,
 * no axes (the "now" value is shown by the tiles beside it).
 *
 * props:
 *   data: number[]       samples (oldest → newest)
 *   width, height        svg box (default 120 × 32)
 *   color                stroke (CSS var; default --accent)
 *   max?                 fixed upper bound (e.g. 100 for CPU%); omitted → data max
 */
function Sparkline({ data = [], width = 120, height = 32, color = 'var(--accent)', max }) {
  const n = data.length

  if (n === 0) {
    return (
      <svg className="sparkline" width={width} height={height} aria-hidden="true">
        <line x1={0} y1={height / 2} x2={width} y2={height / 2}
          stroke="var(--rule)" strokeWidth={1} />
      </svg>
    )
  }

  const lo = Math.min(...data)
  const hi = max !== undefined ? max : Math.max(...data)
  const span = hi - lo || 1

  let points
  if (n < 2) {
    const y = (height - ((data[0] - lo) / span) * height).toFixed(1)
    points = `0,${y} ${width},${y}`
  } else {
    points = data
      .map((v, i) => {
        const x = ((i / (n - 1)) * width).toFixed(1)
        const y = (height - ((v - lo) / span) * height).toFixed(1)
        return `${x},${y}`
      })
      .join(' ')
  }

  return (
    <svg className="sparkline" width={width} height={height} preserveAspectRatio="none">
      <polyline points={points} fill="none" stroke={color}
        strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

export default Sparkline

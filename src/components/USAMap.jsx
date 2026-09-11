import React, { useState, useEffect, useRef, useCallback } from 'react'
import * as d3 from 'd3'
import { feature } from 'topojson-client'
import { motion, AnimatePresence } from 'framer-motion'

const FIPS = {
  '01':'AL','02':'AK','04':'AZ','05':'AR','06':'CA','08':'CO','09':'CT',
  '10':'DE','12':'FL','13':'GA','15':'HI','16':'ID','17':'IL','18':'IN',
  '19':'IA','20':'KS','21':'KY','22':'LA','23':'ME','24':'MD','25':'MA',
  '26':'MI','27':'MN','28':'MS','29':'MO','30':'MT','31':'NE','32':'NV',
  '33':'NH','34':'NJ','35':'NM','36':'NY','37':'NC','38':'ND','39':'OH',
  '40':'OK','41':'OR','42':'PA','44':'RI','45':'SC','46':'SD','47':'TN',
  '48':'TX','49':'UT','50':'VT','51':'VA','53':'WA','54':'WV','55':'WI',
  '56':'WY',
}

const NAMES = {
  AL:'Alabama',AK:'Alaska',AZ:'Arizona',AR:'Arkansas',CA:'California',
  CO:'Colorado',CT:'Connecticut',DE:'Delaware',FL:'Florida',GA:'Georgia',
  HI:'Hawaii',ID:'Idaho',IL:'Illinois',IN:'Indiana',IA:'Iowa',KS:'Kansas',
  KY:'Kentucky',LA:'Louisiana',ME:'Maine',MD:'Maryland',MA:'Massachusetts',
  MI:'Michigan',MN:'Minnesota',MS:'Mississippi',MO:'Missouri',MT:'Montana',
  NE:'Nebraska',NV:'Nevada',NH:'New Hampshire',NJ:'New Jersey',NM:'New Mexico',
  NY:'New York',NC:'North Carolina',ND:'North Dakota',OH:'Ohio',OK:'Oklahoma',
  OR:'Oregon',PA:'Pennsylvania',RI:'Rhode Island',SC:'South Carolina',
  SD:'South Dakota',TN:'Tennessee',TX:'Texas',UT:'Utah',VT:'Vermont',
  VA:'Virginia',WA:'Washington',WV:'West Virginia',WI:'Wisconsin',WY:'Wyoming',
}

// Order density along the brand ramp: navy (sparse) → indigo → cyan (dense).
const RAMP = ['rgba(27, 58, 140, 0.42)', 'rgba(36, 65, 229, 0.62)',
              'rgba(18, 104, 168, 0.78)', 'rgba(0, 184, 217, 0.92)']
const EMPTY = 'rgba(18, 40, 76, 0.14)'

// Four buckets scaled to the busiest state, so the ramp means something whether
// Resolute is running ten orders or ten thousand. The thresholds used to be the
// fixed 4 / 9 / 18 that suited the invented fixture; against a real portfolio of
// a dozen orders every state came out the same colour.
function buckets(max) {
  const step = Math.max(1, Math.ceil(max / 4))
  return [step, step * 2, step * 3, Infinity]
}
const densityColor = (count, edges) => {
  if (!count) return EMPTY
  return RAMP[edges.findIndex(e => count <= e)] || RAMP[RAMP.length - 1]
}
const bucketLabels = (edges) => edges.map((e, i) => {
  const lo = i === 0 ? 1 : edges[i - 1] + 1
  return e === Infinity ? `${lo}+` : lo === e ? `${lo}` : `${lo}–${e}`
})

const W = 960, H = 560

// `counts` is { AZ: 3, OH: 10, … } — real orders per state, supplied by the
// caller. It used to read a hardcoded 50-state fixture from mockData (TX 35,
// CA 28, FL 31) while the page above it promised "real-time order distribution",
// so every colour, every label, every tooltip and the pulse on "high-volume"
// states was invented.
export default function USAMap({ compact = false, counts = {} }) {
  const [geoStates, setGeoStates]   = useState([])
  const [loading, setLoading]       = useState(true)
  const [failed, setFailed]         = useState(false)
  const [hovered, setHovered]       = useState(null)
  const [tooltip, setTooltip]       = useState({ x: 0, y: 0 })
  const svgRef   = useRef(null)
  const values = Object.values(counts)
  const maxOrders = values.length ? Math.max(...values) : 0
  const edges = buckets(maxOrders)

  // Served from our own origin, not a CDN. This used to fetch
  // https://cdn.jsdelivr.net/npm/us-atlas@3/states-10m.json at runtime, so the
  // map depended on a third party being reachable every time an admin opened
  // the page, and rendered nothing behind a strict CSP, on a locked-down
  // network, or offline. The file is public/us-states-10m.json, vendored
  // verbatim from us-atlas@3.0.1 (states-10m.json); refresh it with
  // `npm pack us-atlas@3 && tar xzf us-atlas-*.tgz package/states-10m.json`.
  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}us-states-10m.json`)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() })
      .then(us => {
        const proj = d3.geoAlbersUsa().scale(1280).translate([W / 2, H / 2])
        const path = d3.geoPath().projection(proj)
        const feats = feature(us, us.objects.states).features
        const computed = feats.map(f => {
          const fips   = String(f.id).padStart(2, '0')
          const abbrev = FIPS[fips]
          const c      = path.centroid(f)
          return {
            fips,
            abbrev,
            d:  path(f),
            cx: isFinite(c[0]) ? c[0] : null,
            cy: isFinite(c[1]) ? c[1] : null,
          }
        }).filter(s => s.abbrev && s.d)
        setGeoStates(computed)
        setLoading(false)
      })
      // A map that silently renders nothing looks like a portal with no orders.
      .catch(e => { console.error('[USAMap]', e.message); setFailed(true); setLoading(false) })
  }, [])

  const handleMouseMove = useCallback((e, abbrev) => {
    const rect = svgRef.current?.getBoundingClientRect()
    if (!rect) return
    setTooltip({ x: e.clientX - rect.left, y: e.clientY - rect.top })
    setHovered(abbrev)
  }, [])

  const displayH = compact ? 280 : 420

  return (
    <div className="relative w-full select-none" style={{ height: displayH }}>
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center gap-3">
          <div className="w-5 h-5 border-2 rounded-full animate-spin"
            style={{ borderColor: 'rgba(36,65,229,0.25)', borderTopColor: 'rgba(36,65,229,0.8)' }} />
          <span className="text-xs" style={{ color: '#5C6E8C' }}>Loading map…</span>
        </div>
      )}
      {failed && !loading && (
        <div className="absolute inset-0 flex items-center justify-center px-6 text-center">
          <span className="text-xs" style={{ color: '#a16207' }}>
            The map outline could not be loaded. The order counts beside it are unaffected.
          </span>
        </div>
      )}

      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="w-full h-full"
        style={{ overflow: 'visible' }}
      >
        <defs>
          <filter id="accent-glow" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="4" result="blur"/>
            <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
          </filter>
          <filter id="state-shadow" x="-5%" y="-5%" width="110%" height="110%">
            <feDropShadow dx="0" dy="1" stdDeviation="2" floodColor="rgba(0,0,0,0.4)" floodOpacity="0.6"/>
          </filter>
        </defs>

        {/* State paths */}
        {geoStates.map(st => {
          const orders    = counts[st.abbrev] || 0
          const isHovered = hovered === st.abbrev
          return (
            <g key={st.fips}>
              <path
                d={st.d}
                fill={isHovered ? 'rgba(0, 184, 217, 0.95)' : densityColor(orders, edges)}
                stroke={isHovered
                  ? 'rgba(255, 255, 255, 0.9)'
                  : 'rgba(36, 65, 229, 0.28)'}
                strokeWidth={isHovered ? 1.8 : 0.8}
                style={{
                  cursor: 'pointer',
                  transition: 'fill 0.18s ease, stroke 0.18s ease, filter 0.18s ease',
                  filter: isHovered ? 'url(#accent-glow)' : 'url(#state-shadow)',
                }}
                onMouseMove={e => handleMouseMove(e, st.abbrev)}
                onMouseLeave={() => setHovered(null)}
              />

              {/* State label — skip tiny states when compact */}
              {!compact && st.cx && st.cy && orders > 0 && (
                <text
                  x={st.cx} y={st.cy + 1}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fontSize={orders > 10 ? 9 : 7}
                  fontWeight={orders > 10 ? '600' : '400'}
                  fill={isHovered ? 'rgba(18,40,76,0.95)' : '#3D5171'}
                  style={{ pointerEvents: 'none', userSelect: 'none' }}
                >
                  {st.abbrev}
                </text>
              )}
            </g>
          )
        })}

        {/* Animated pulse on highest-volume states */}
        {!compact && geoStates
          .filter(st => maxOrders > 0 && (counts[st.abbrev] || 0) >= edges[2] && st.cx && st.cy)
          .map(st => (
            <g key={`pulse-${st.fips}`} style={{ pointerEvents: 'none' }}>
              <circle cx={st.cx} cy={st.cy - 14} r="4" fill="#00B8D9" opacity="0.85">
                <animate attributeName="r"       values="4;9;4"     dur="2.2s" repeatCount="indefinite"/>
                <animate attributeName="opacity" values="0.85;0;0.85" dur="2.2s" repeatCount="indefinite"/>
              </circle>
              <circle cx={st.cx} cy={st.cy - 14} r="3" fill="#c8e090" opacity="0.9"/>
            </g>
          ))
        }
      </svg>

      {/* Tooltip */}
      <AnimatePresence>
        {hovered && (
          <motion.div
            key={hovered}
            initial={{ opacity: 0, scale: 0.88, y: 6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.88 }}
            transition={{ duration: 0.12 }}
            className="absolute pointer-events-none z-50"
            style={{
              left: Math.min(tooltip.x + 16, (svgRef.current?.offsetWidth || 600) - 190),
              top:  Math.max(tooltip.y - 76, 4),
            }}
          >
            <div className="glass-card px-4 py-3 min-w-[170px]"
              style={{ border: '1px solid rgba(36,65,229,0.35)' }}>
              <div className="font-semibold text-sm mb-0.5" style={{ color: '#12284C' }}>
                {NAMES[hovered] || hovered}
              </div>
              <div className="text-xs font-medium mb-2" style={{ color: '#2441E5' }}>
                {counts[hovered] || 0} active orders
              </div>
              <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'rgba(18,40,76,0.10)' }}>
                <div className="h-full rounded-full"
                  style={{
                    width: `${maxOrders ? ((counts[hovered] || 0) / maxOrders) * 100 : 0}%`,
                    background: 'linear-gradient(90deg, #2441E5, #00B8D9)',
                    transition: 'width 0.3s ease',
                  }} />
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Legend */}
      {!compact && (
        <div className="absolute bottom-1 right-3 flex items-center gap-3 flex-wrap">
          <span className="text-xs" style={{ color: '#5C6E8C' }}>Orders</span>
          {RAMP.map((c, i) => [c, bucketLabels(edges)[i]]).map(([c, l]) => (
            <div key={l} className="flex items-center gap-1.5">
              <div className="w-3 h-3 rounded-sm" style={{ background: c, border: '1px solid rgba(36,65,229,0.25)' }} />
              <span className="text-xs" style={{ color: '#5C6E8C' }}>{l}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

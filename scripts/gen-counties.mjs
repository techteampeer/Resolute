// Regenerate public/us-counties.json — the state → county list backing the
// Place-Order county dropdown. Source: us-atlas (the same dataset the coverage
// map uses), so county names stay authoritative and consistent.
//
//   npm pack us-atlas@3 && tar xzf us-atlas-*.tgz
//   node scripts/gen-counties.mjs ./package/counties-10m.json
//
// Territories (Puerto Rico, etc.) are intentionally dropped — the portal serves
// the 50 states + DC.
import fs from 'node:fs'

const src = process.argv[2] || '/tmp/usatlas/package/counties-10m.json'
const FIPS = {
  '01':'AL','02':'AK','04':'AZ','05':'AR','06':'CA','08':'CO','09':'CT','10':'DE','11':'DC',
  '12':'FL','13':'GA','15':'HI','16':'ID','17':'IL','18':'IN','19':'IA','20':'KS','21':'KY',
  '22':'LA','23':'ME','24':'MD','25':'MA','26':'MI','27':'MN','28':'MS','29':'MO','30':'MT',
  '31':'NE','32':'NV','33':'NH','34':'NJ','35':'NM','36':'NY','37':'NC','38':'ND','39':'OH',
  '40':'OK','41':'OR','42':'PA','44':'RI','45':'SC','46':'SD','47':'TN','48':'TX','49':'UT',
  '50':'VT','51':'VA','53':'WA','54':'WV','55':'WI','56':'WY',
}

const j = JSON.parse(fs.readFileSync(src, 'utf8'))
const out = {}
for (const g of j.objects.counties.geometries) {
  const fips = String(g.id).padStart(5, '0')
  const code = FIPS[fips.slice(0, 2)]
  const name = g.properties && g.properties.name
  if (!code || !name) continue
  ;(out[code] = out[code] || []).push(name)
}
const sorted = {}
for (const k of Object.keys(out).sort()) sorted[k] = [...new Set(out[k])].sort()
fs.writeFileSync('public/us-counties.json', JSON.stringify(sorted))
const total = Object.values(sorted).reduce((a, c) => a + c.length, 0)
console.log(`wrote public/us-counties.json — ${Object.keys(sorted).length} states, ${total} counties`)

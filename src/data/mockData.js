// Pipeline stages (typing inserted before delivery)
// One status per role stage, strictly ordered. Status is DERIVED from the role
// that owns the order (see statusForRole), so the two can never drift.
export const STAGE_KEYS   = ['received','screening','examining','typing','delivery','delivered']
export const STAGE_LABELS = ['Received','Screening','Examining','Typing','Out for Delivery','Delivered']

export const PAYMENT_METHODS = ['Check', 'ACH']

export const ORDERS = [
  { id: 'RTS-10041', client: 'Lakewood Title Group',    state: 'FL', county: 'Miami-Dade',  type: 'Full Search',     status: 'examining',  screener: 'Sam Carter',   examiner: 'Jordan Lee',  typer: 'Priya Nair', delivery: 'Morgan Davis', priority: 'rush',   payment: 'Wire',             clarification: null,        created: '2026-06-09', eta: '2026-06-11', completed: null,         progress: 65,  assignedTo: 'examiner', completedDates: { screener: '2026-06-09', examiner: null, typer: null, delivery: null }, completedBy: { screener: 'Sam Carter', examiner: null, typer: null, delivery: null } },
  { id: 'RTS-10042', client: 'Apex Lending Partners',   state: 'TX', county: 'Harris',      type: 'Current Owner',   status: 'delivered',  screener: 'Sam Carter',   examiner: 'Jordan Lee',  typer: 'Priya Nair', delivery: 'Morgan Davis', priority: 'normal', payment: 'ACH',              clarification: null,        created: '2026-06-08', eta: '2026-06-10', completed: '2026-06-10', progress: 100, assignedTo: null,       completedDates: { screener: '2026-06-08', examiner: '2026-06-09', typer: '2026-06-09', delivery: '2026-06-10' }, completedBy: { screener: 'Sam Carter', examiner: 'Jordan Lee', typer: 'Priya Nair', delivery: 'Morgan Davis' } },
  { id: 'RTS-10043', client: 'Sterling Law Firm',       state: 'CA', county: 'Los Angeles', type: 'Two-Owner',       status: 'examining',  screener: 'Sam Carter',   examiner: 'Jordan Lee',  typer: 'Priya Nair', delivery: 'Morgan Davis', priority: 'normal', payment: 'Credit Card',      clarification: 'responded', created: '2026-06-09', eta: '2026-06-12', completed: null,         progress: 45,  assignedTo: 'examiner', completedDates: { screener: '2026-06-09', examiner: null, typer: null, delivery: null }, completedBy: { screener: 'Sam Carter', examiner: null, typer: null, delivery: null } },
  { id: 'RTS-10044', client: 'Pinnacle Real Estate',    state: 'NY', county: 'Kings',       type: 'Lien Search',     status: 'screening',   screener: 'Sam Carter',   examiner: 'Jordan Lee',  typer: 'Priya Nair', delivery: 'Morgan Davis', priority: 'rush',   payment: 'Invoice (Net-30)', clarification: 'pending',   created: '2026-06-10', eta: '2026-06-11', completed: null,         progress: 10,  assignedTo: 'screener', completedDates: { screener: null, examiner: null, typer: null, delivery: null }, completedBy: { screener: null, examiner: null, typer: null, delivery: null }, workflow: { screenerDoc: { id: 'sd44', name: 'Kings County Chain of Title.pdf', type: 'pdf' }, examinerDoc: { id: 'ed44', name: 'Examiner Findings - Lien Search.docx', type: 'word' } } },
  { id: 'RTS-10045', client: 'BlueStar Title Agency',   state: 'GA', county: 'Fulton',      type: 'Full Search',     status: 'screening',  screener: 'Sam Carter',   examiner: 'Jordan Lee',  typer: 'Priya Nair', delivery: 'Morgan Davis', priority: 'normal', payment: 'Check',            clarification: 'responded', created: '2026-06-10', eta: '2026-06-13', completed: null,         progress: 25,  assignedTo: 'screener', completedDates: { screener: null, examiner: null, typer: null, delivery: null }, completedBy: { screener: null, examiner: null, typer: null, delivery: null } },
  { id: 'RTS-10046', client: 'Meridian Mortgage LLC',   state: 'OH', county: 'Cuyahoga',    type: 'Tax Certificate', status: 'delivered',  screener: 'Sam Carter',   examiner: 'Jordan Lee',  typer: 'Priya Nair', delivery: 'Morgan Davis', priority: 'normal', payment: 'Wire',             clarification: null,        created: '2026-06-07', eta: '2026-06-09', completed: '2026-06-09', progress: 100, assignedTo: null,       completedDates: { screener: '2026-06-07', examiner: '2026-06-08', typer: '2026-06-08', delivery: '2026-06-09' }, completedBy: { screener: 'Sam Carter', examiner: 'Jordan Lee', typer: 'Priya Nair', delivery: 'Morgan Davis' } },
  { id: 'RTS-10047', client: 'Coastal Title Services',  state: 'NC', county: 'Mecklenburg', type: 'HOA Estoppel',    status: 'examining',  screener: 'Sam Carter',   examiner: 'Jordan Lee',  typer: 'Priya Nair', delivery: 'Morgan Davis', priority: 'rush',   payment: 'ACH',              clarification: null,        created: '2026-06-09', eta: '2026-06-11', completed: null,         progress: 55,  assignedTo: 'examiner', completedDates: { screener: '2026-06-09', examiner: null, typer: null, delivery: null }, completedBy: { screener: 'Sam Carter', examiner: null, typer: null, delivery: null } },
  { id: 'RTS-10048', client: 'Lakewood Title Group',    state: 'AZ', county: 'Maricopa',    type: 'Current Owner',   status: 'typing',     screener: 'Sam Carter',   examiner: 'Jordan Lee',  typer: 'Priya Nair', delivery: 'Morgan Davis', priority: 'normal', payment: 'Wire',             clarification: null,        created: '2026-06-08', eta: '2026-06-12', completed: null,         progress: 85,  assignedTo: 'typer',    completedDates: { screener: '2026-06-08', examiner: '2026-06-10', typer: null, delivery: null }, completedBy: { screener: 'Sam Carter', examiner: 'Jordan Lee', typer: null, delivery: null } },
]

// Client registry — codes assigned in registration order, stable per client.
// Non-super-admins see the code; only super admins (Rajni, Saravanan) see the name + contact.
export const CLIENTS = [
  { code: 'CL01', name: 'Lakewood Title Group',   contact: 'Dana Whitfield', email: 'dana@lakewoodtitle.com',  phone: '(305) 555-0142', registered: '2025-01-20', activity: 'high',   orders: 14, payment: 'Wire'             },
  { code: 'CL02', name: 'Apex Lending Partners',  contact: 'Casey Wilson',   email: 'casey@apexlending.com',   phone: '(713) 555-0188', registered: '2025-02-04', activity: 'high',   orders: 9,  payment: 'ACH'              },
  { code: 'CL03', name: 'Sterling Law Firm',      contact: 'Riley Stone',    email: 'riley@sterlinglaw.com',   phone: '(213) 555-0119', registered: '2025-02-26', activity: 'medium', orders: 6,  payment: 'Credit Card'      },
  { code: 'CL04', name: 'Pinnacle Real Estate',   contact: 'Morgan Pratt',   email: 'morgan@pinnaclere.com',   phone: '(718) 555-0173', registered: '2025-03-12', activity: 'medium', orders: 5,  payment: 'Invoice (Net-30)' },
  { code: 'CL05', name: 'BlueStar Title Agency',  contact: 'Jamie Fox',      email: 'jamie@bluestartitle.com', phone: '(404) 555-0150', registered: '2025-04-01', activity: 'low',    orders: 3,  payment: 'Check'            },
  { code: 'CL06', name: 'Meridian Mortgage LLC',  contact: 'Avery Banks',    email: 'avery@meridianmtg.com',   phone: '(216) 555-0137', registered: '2025-04-22', activity: 'low',    orders: 2,  payment: 'Wire'             },
  { code: 'CL07', name: 'Coastal Title Services', contact: 'Quinn Rivera',   email: 'quinn@coastaltitle.com',  phone: '(704) 555-0164', registered: '2025-05-15', activity: 'low',    orders: 2,  payment: 'ACH'              },
]

// Abstractor vendor registry — outside search firms the screener can route to
// (the "ABS (Abstract)" assignment). Vivek pays them from the Chase account on
// each vendor's payout cycle; `cycle` here is the default (editable in Billing).
export const VENDORS = [
  { code: 'VN01', name: 'Meridian Abstracting LLC', contact: 'Paul Ortiz',   coverage: 'FL · GA · SC', cycle: 'weekly' },
  { code: 'VN02', name: 'TitleTrace Abstractors',   contact: 'Gina Malone',  coverage: 'TX · OK · LA', cycle: 'days15' },
  { code: 'VN03', name: 'Keystone Search Group',    contact: 'Ed Novak',     coverage: 'NY · NJ · PA', cycle: 'days30' },
]

const CODE_BY_NAME   = Object.fromEntries(CLIENTS.map(c => [c.name, c.code]))
const NAME_BY_CODE   = Object.fromEntries(CLIENTS.map(c => [c.code, c.name]))
export const clientCode   = (name) => CODE_BY_NAME[name] || name
export const clientName   = (code) => NAME_BY_CODE[code] || null
export const clientByName = (name) => CLIENTS.find(c => c.name === name) || null
// Returns the real client name for super admins, otherwise the stable client code.
//
// Takes an order (or support thread) row rather than a bare name, because the row
// carries the authoritative `client_code`. The old signature took only the name and
// mapped it through CODE_BY_NAME, which is built from the demo CLIENTS array above
// — and fell back to returning the name unchanged on a miss. Every real client is
// absent from that array by definition, so the masking rule held only for the seven
// demo clients and leaked the full legal name of exactly the clients that matter:
// a screener's queue rendered "Northgate Pilot Escrow LLC" beside a correctly
// masked "CL04". There is deliberately no name fallback now — an unmappable client
// shows a placeholder rather than an identity.
//
// A bare name string is still accepted for the mock-data paths that have no row.
export const displayClient = (row, user) => {
  const isRow = row && typeof row === 'object'
  const name = isRow ? (row.client ?? row.clientName ?? null) : (row ?? null)
  const code = (isRow ? (row.clientCode ?? row.client_code ?? null) : null)
    || CODE_BY_NAME[name] || null
  if (user && user.superAdmin) return name || code || '—'
  return code || '—'
}

export const STATE_ORDERS = {
  AL:2, AK:1, AZ:14, AR:3, CA:28, CO:9, CT:5, DE:2, FL:31, GA:18,
  HI:2, ID:4, IL:16, IN:8, IA:5, KS:4, KY:6, LA:7, ME:3, MD:11,
  MA:12, MI:14, MN:9, MS:4, MO:10, MT:2, NE:4, NV:8, NH:3, NJ:15,
  NM:3, NY:24, NC:17, ND:1, OH:19, OK:6, OR:8, PA:20, RI:2, SC:9,
  SD:1, TN:11, TX:35, UT:7, VT:1, VA:16, WA:13, WV:3, WI:8, WY:1,
}

// US Census regions — used for "area-wise" filtering across dashboards.
export const REGIONS = ['Northeast', 'Midwest', 'South', 'West']
const REGION_BY_STATE = {
  CT:'Northeast', ME:'Northeast', MA:'Northeast', NH:'Northeast', RI:'Northeast',
  VT:'Northeast', NJ:'Northeast', NY:'Northeast', PA:'Northeast',
  IL:'Midwest', IN:'Midwest', MI:'Midwest', OH:'Midwest', WI:'Midwest', IA:'Midwest',
  KS:'Midwest', MN:'Midwest', MO:'Midwest', NE:'Midwest', ND:'Midwest', SD:'Midwest',
  DE:'South', FL:'South', GA:'South', MD:'South', NC:'South', SC:'South', VA:'South',
  DC:'South', WV:'South', AL:'South', KY:'South', MS:'South', TN:'South', AR:'South',
  LA:'South', OK:'South', TX:'South',
  AZ:'West', CO:'West', ID:'West', MT:'West', NV:'West', NM:'West', UT:'West',
  WY:'West', AK:'West', CA:'West', HI:'West', OR:'West', WA:'West',
}
// Canonical state list. Orders store the two-letter CODE — everything keyed on
// state (regionOf, STATE_ORDERS, the coverage map, the by-state report) uses it.
// The Place Order wizard had its own list of full NAMES and used the name as the
// option value, so every client-placed order stored "Florida" while every other
// order stored "FL": the by-state report counted them as two states, regionOf
// returned '—', and the coverage map could never match them.
export const US_STATES = [
  ['AL','Alabama'],['AK','Alaska'],['AZ','Arizona'],['AR','Arkansas'],['CA','California'],
  ['CO','Colorado'],['CT','Connecticut'],['DE','Delaware'],['DC','District of Columbia'],
  ['FL','Florida'],['GA','Georgia'],['HI','Hawaii'],['ID','Idaho'],['IL','Illinois'],
  ['IN','Indiana'],['IA','Iowa'],['KS','Kansas'],['KY','Kentucky'],['LA','Louisiana'],
  ['ME','Maine'],['MD','Maryland'],['MA','Massachusetts'],['MI','Michigan'],['MN','Minnesota'],
  ['MS','Mississippi'],['MO','Missouri'],['MT','Montana'],['NE','Nebraska'],['NV','Nevada'],
  ['NH','New Hampshire'],['NJ','New Jersey'],['NM','New Mexico'],['NY','New York'],
  ['NC','North Carolina'],['ND','North Dakota'],['OH','Ohio'],['OK','Oklahoma'],['OR','Oregon'],
  ['PA','Pennsylvania'],['RI','Rhode Island'],['SC','South Carolina'],['SD','South Dakota'],
  ['TN','Tennessee'],['TX','Texas'],['UT','Utah'],['VT','Vermont'],['VA','Virginia'],
  ['WA','Washington'],['WV','West Virginia'],['WI','Wisconsin'],['WY','Wyoming'],
].map(([code, name]) => ({ code, name }))

const CODE_BY_STATE_NAME = Object.fromEntries(US_STATES.map(s => [s.name.toLowerCase(), s.code]))
const NAME_BY_STATE_CODE = Object.fromEntries(US_STATES.map(s => [s.code, s.name]))

// Coerce either representation to the two-letter code, so rows written before
// the wizard was fixed still group and filter correctly.
export const stateCode = (v) => {
  if (!v) return ''
  const s = String(v).trim()
  if (NAME_BY_STATE_CODE[s.toUpperCase()]) return s.toUpperCase()
  return CODE_BY_STATE_NAME[s.toLowerCase()] || s
}
export const stateName = (v) => NAME_BY_STATE_CODE[stateCode(v)] || String(v || '')

export const regionOf = (state) => REGION_BY_STATE[stateCode(state)] || '—'

export const USERS = [
  { id: 1, name: 'Sam Carter',     email: 'screener@resolute.com',   role: 'screener', status: 'active',   orders: 47, joined: '2025-01-15' },
  { id: 2, name: 'Jordan Lee',     email: 'examiner@resolute.com',   role: 'examiner', status: 'active',   orders: 63, joined: '2025-02-20' },
  { id: 3, name: 'Priya Nair',     email: 'typer@resolute.com',      role: 'typer',    status: 'active',   orders: 41, joined: '2025-02-10' },
  { id: 4, name: 'Morgan Davis',   email: 'delivery@resolute.com',   role: 'delivery', status: 'active',   orders: 58, joined: '2025-01-08' },
  { id: 5, name: 'Taylor Brooks',  email: 'client@resolute.com',     role: 'client',   status: 'active',   orders: 12, joined: '2025-03-10' },
  { id: 6, name: 'Casey Wilson',   email: 'casey@apexlending.com',   role: 'client',   status: 'active',   orders: 8,  joined: '2025-04-01' },
  { id: 7, name: 'Riley Stone',    email: 'riley@sterlinglaw.com',   role: 'client',   status: 'inactive', orders: 3,  joined: '2025-05-12' },
  { id: 8, name: 'Rajni',          email: 'rajni@resolute.com',      role: 'admin',    status: 'active',   orders: 0,  joined: '2024-12-01', superAdmin: true },
  { id: 9, name: 'Saravanan',      email: 'saravanan@resolute.com',  role: 'admin',    status: 'active',   orders: 0,  joined: '2024-12-01', superAdmin: true },
  // Additional staff per role, so Admin can route each stage to whoever is available.
  { id: 10, name: 'Dana Iqbal',    email: 'dana.i@resolute.com',     role: 'screener', status: 'active',   orders: 22, joined: '2025-06-02' },
  { id: 11, name: 'Marcus Reed',   email: 'marcus.r@resolute.com',   role: 'screener', status: 'active',   orders: 15, joined: '2025-07-14' },
  { id: 12, name: 'Riley Cho',     email: 'riley.c@resolute.com',    role: 'examiner', status: 'active',   orders: 38, joined: '2025-03-19' },
  { id: 13, name: 'Owen Park',     email: 'owen.p@resolute.com',     role: 'examiner', status: 'active',   orders: 27, joined: '2025-08-05' },
  { id: 14, name: 'Leah Tran',     email: 'leah.t@resolute.com',     role: 'typer',    status: 'active',   orders: 19, joined: '2025-05-21' },
  { id: 15, name: 'Nina Reyes',    email: 'nina.r@resolute.com',     role: 'delivery', status: 'active',   orders: 31, joined: '2025-04-12' },
  { id: 16, name: 'Jordan Blake',  email: 'operator@resolute.com',   role: 'operator', status: 'active',   orders: 26, joined: '2025-03-01' },
]

// Fixed order of pipeline roles. Routing flexibility = Admin chooses WHO does
// each role; the role order itself stays screener → examiner → typer → delivery.
export const ROLE_SEQUENCE = ['screener', 'examiner', 'typer', 'delivery']
// The next role that still needs to act on an order (null once all four are done).
export const nextRoleFor = (order) =>
  ROLE_SEQUENCE.find(r => !(order.completedDates && order.completedDates[r])) || null

// The role that FOLLOWS a stage that has just been completed (null after delivery).
// Distinct from nextRoleFor, which finds the first *incomplete* stage: that answers
// "who should act next on this order", and using it to route a completion sends the
// order BACKWARDS whenever an earlier stage was skipped (delivery completing on an
// un-typed order returned 'typer', dropping status/progress from delivery/80 to
// typing/60 while the event log announced "delivered"). Handing off follows the
// fixed sequence, so it can only ever move forward.
export const roleAfter = (role) => {
  const i = ROLE_SEQUENCE.indexOf(role)
  return i === -1 || i === ROLE_SEQUENCE.length - 1 ? null : ROLE_SEQUENCE[i + 1]
}

// The single source of truth for status: it follows the owning role.
// null role (all stages done) → 'delivered'.
// BUG_010: a delivered order must never read "80% complete". Progress is
// DERIVED from the order's terminal state rather than trusting the stored
// column, which can lag (progressFor('delivery') is 80, and rows written at
// that stage keep it after delivery).
export const orderProgress = (order) => {
  if (!order) return 0
  if (order.status === 'cancelled') return 0
  if (order.status === 'delivered' || order.completed) return 100
  return Math.min(100, Math.max(0, Number(order.progress) || 0))
}
export const isOrderComplete = (order) =>
  !!order && (order.status === 'delivered' || !!order.completed)

export const statusForRole = (role) =>
  role === null ? 'delivered'
    : ({ screener: 'screening', examiner: 'examining', typer: 'typing', delivery: 'delivery' }[role] || 'received')

export const ACTIVITY = [
  { time: '10:42 AM', action: 'Order RTS-10044 received from Pinnacle Real Estate', type: 'new' },
  { time: '10:28 AM', action: 'RTS-10042 delivered to Apex Lending Partners', type: 'delivered' },
  { time: '10:15 AM', action: 'RTS-10047 search in progress – 55% complete', type: 'progress' },
  { time: '09:55 AM', action: 'RTS-10048 moved to Typing stage', type: 'status' },
  { time: '09:30 AM', action: 'New client registered: Riley Stone (Sterling Law)', type: 'user' },
  { time: '09:12 AM', action: 'RTS-10048 examination started by Jordan Lee', type: 'status' },
]

// Client/customer messages per order — surfaced in the order detail Inbox tab.
export const MESSAGES = [
  { id: 'msg1', orderId: 'RTS-10044', from: 'Pinnacle Real Estate', preview: 'Good morning — any update on the lien search? Closing is tight.', date: 'Jun 18, 10:40 AM' },
  { id: 'msg2', orderId: 'RTS-10044', from: 'Pinnacle Real Estate', preview: 'Please prioritize, this is a rush file. Thank you!',               date: 'Jun 18, 11:02 AM' },
  { id: 'msg3', orderId: 'RTS-10041', from: 'Lakewood Title Group',  preview: 'Confirming the property is Miami-Dade county, correct?',          date: 'Jun 17, 3:15 PM' },
  { id: 'msg4', orderId: 'RTS-10043', from: 'Sterling Law Firm',     preview: 'We responded to the clarification request — let us know if you need more.', date: 'Jun 17, 9:20 AM' },
  { id: 'msg5', orderId: 'RTS-10048', from: 'Lakewood Title Group',  preview: 'Following up on the typed report for Maricopa.',                  date: 'Jun 19, 8:53 AM' },
]

export const MONTHLY_STATS = [
  { month: 'Jan', orders: 142, delivered: 138 },
  { month: 'Feb', orders: 168, delivered: 161 },
  { month: 'Mar', orders: 195, delivered: 188 },
  { month: 'Apr', orders: 221, delivered: 215 },
  { month: 'May', orders: 248, delivered: 241 },
  { month: 'Jun', orders: 87,  delivered: 79  },
]

export const STATUS_COLORS = {
  received:  { bg: 'bg-blue-500/20',   text: 'text-blue-300',   dot: 'bg-blue-400'   },
  screening: { bg: 'bg-yellow-500/20', text: 'text-yellow-300', dot: 'bg-yellow-400' },
  searching: { bg: 'bg-purple-500/20', text: 'text-purple-300', dot: 'bg-purple-400' },
  examining: { bg: 'bg-orange-500/20', text: 'text-orange-300', dot: 'bg-orange-400' },
  typing:    { bg: 'bg-cyan-500/20',   text: 'text-cyan-300',   dot: 'bg-cyan-400'   },
  delivery:  { bg: 'bg-amber-500/20',  text: 'text-amber-300',  dot: 'bg-amber-400'  },
  delivered: { bg: 'bg-green-500/20',  text: 'text-green-300',  dot: 'bg-green-400'  },
  onhold:    { bg: 'bg-red-500/20',    text: 'text-red-300',    dot: 'bg-red-400'    },
}

// Isolated in-memory dataset for the guest "Try demo" client sandbox.
// The demo client view reads ONLY from here — it is never persisted and never
// mixed with real or mock data, so a demo session cannot reach real orders.
// A demo user also never gets a Supabase session (see AuthContext.loginAsDemo),
// so the backend is never queried on its behalf. State resets on refresh
// because the demo user lives only in React memory.

export const DEMO_CLIENT_CODE = 'DEMO'

export const DEMO_USER = {
  email: 'demo@resolute.com',
  role: 'client',
  name: 'Demo User',
  avatar: 'DM',
  clientCode: DEMO_CLIENT_CODE,
  superAdmin: false,
  demo: true,
}

// A delivered order ships with a viewable sample report (served from /public).
const SAMPLE_DOC = {
  id: 'demo-doc-1',
  name: 'Title Search Report (sample).pdf',
  type: 'pdf',
  url: '/demo/sample-title-search.html',
}

export const DEMO_ORDERS = [
  {
    id: 'DEMO-2001', client: 'Demo Title Co.', client_code: DEMO_CLIENT_CODE,
    state: 'FL', county: 'Miami-Dade', type: 'Full Search', status: 'examining',
    priority: 'rush', payment: 'Wire', assignedTo: 'examiner',
    screener: 'Sam Carter', examiner: 'Jordan Lee', typer: 'Priya Nair', delivery: 'Morgan Davis',
    progress: 55, created: '2026-07-10', eta: '2026-07-16', completed: null,
    completedDates: { screener: '2026-07-11' }, completedBy: { screener: 'Sam Carter' },
    workflow: { intake: { source: 'demo', propertyAddress: '1450 Ocean Dr, Miami Beach, FL 33139', parcelNumberAPN: '02-3234-019-0180', buyer: 'Alex Rivera', seller: 'Jamie Cole', orderType: 'Full Search' } },
  },
  {
    id: 'DEMO-2002', client: 'Demo Title Co.', client_code: DEMO_CLIENT_CODE,
    state: 'TX', county: 'Harris', type: 'Current Owner', status: 'delivered',
    priority: 'normal', payment: 'ACH', assignedTo: null,
    screener: 'Sam Carter', examiner: 'Jordan Lee', typer: 'Priya Nair', delivery: 'Morgan Davis',
    progress: 100, created: '2026-07-05', eta: '2026-07-08', completed: '2026-07-08',
    completedDates: { screener: '2026-07-05', examiner: '2026-07-06', typer: '2026-07-07', delivery: '2026-07-08' },
    completedBy: { screener: 'Sam Carter', examiner: 'Jordan Lee', typer: 'Priya Nair', delivery: 'Morgan Davis' },
    workflow: { intake: { source: 'demo', propertyAddress: '880 Main St, Houston, TX 77002', parcelNumberAPN: '0660110000021', buyer: 'Taylor Brooks', orderType: 'Current Owner' }, commitmentDoc: SAMPLE_DOC, invoiceAmount: 165, invoicedAt: '2026-07-07' },
  },
  {
    id: 'DEMO-2003', client: 'Demo Title Co.', client_code: DEMO_CLIENT_CODE,
    state: 'CA', county: 'Los Angeles', type: 'Two-Owner', status: 'screening',
    priority: 'normal', payment: 'Wire', assignedTo: 'screener',
    screener: 'Sam Carter', examiner: 'Jordan Lee', typer: 'Priya Nair', delivery: 'Morgan Davis',
    progress: 15, created: '2026-07-14', eta: '2026-07-18', completed: null,
    completedDates: {}, completedBy: {},
    workflow: { intake: { source: 'demo', propertyAddress: '55 Sunset Blvd, Los Angeles, CA 90028', parcelNumberAPN: '5544-021-014', buyer: 'Morgan Lee', seller: 'Chris Vale', orderType: 'Two-Owner' } },
  },
]

// Verifies E2 (admin-set stage routing) over the REAL REST path (RLS + guard):
//   • an owner who completes a stage routes the order IN-POOL to the plan's
//     pre-assigned next-stage owner, with NO Admin gate between stages;
//   • the newly-routed owner can then work the order (and nobody else can);
//   • a production user can NEVER choose who gets the order next — routing to
//     an arbitrary user, or to the right user without completing the stage, is
//     refused (the anti-bias rule);
//   • the stage plan and the singleSeating flag are admin-only (a production
//     user cannot add, change or clear either);
//   • escalation to Admin (disruption/query) still works mid-stage;
//   • a plan slot with no owner parks that stage with Admin;
//   • a legacy order with NO plan still behaves exactly as under A1
//     (single-seating advances in-seat; non-single returns to Admin).
// Model script: it ASSERTS with an exit code (exit 1 on any failure).
//
// Requires the local stack: `supabase start` + migrations applied.
//   node .audit/verify-stage-routing.mjs
import { as, sql, sqlJson } from './harness.mjs'

let failures = 0
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? '✓' : '*** FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!pass) failures++
}

const idOf = (email) => (sqlJson(`select id from profiles where email = '${email}'`)[0] || {}).id
// Four real production (`user`-role) logins, one per pipeline stage — the plan
// routes the order from one to the next, and each can actually work their turn.
const SCREENER = idOf('screener@resolute.com')
const EXAMINER = idOf('examiner@resolute.com')
const TYPER    = idOf('typer@resolute.com')
const DELIVERY = idOf('delivery@resolute.com')
// A production user who is on NO stage of the plan — "a user of one's choosing".
const OUTSIDER = idOf('operator@resolute.com')

const c1 = sqlJson('select code from clients order by code')[0]?.code ?? null
const OID = 'RTS-AUDIT-E2'
const full = JSON.stringify({
  singleSeating: false,
  stagePlan: { screener: SCREENER, examiner: EXAMINER, typer: TYPER, delivery: DELIVERY },
})
// Seed the order as Admin would at intake: full plan, first owner = the screener.
const seed = (workflow = full, { status = 'screening', owner = SCREENER, dates = '{}' } = {}) => {
  sql(`delete from orders where id = '${OID}'`)
  sql(`insert into orders (id, client_code, state, county, type, status, assigned_to, assigned_user_id, progress, created, completed_dates, workflow)
       values ('${OID}', ${c1 ? `'${c1}'` : 'null'}, 'FL', 'Test', 'Full Search', '${status}', 'user',
               ${owner ? `'${owner}'` : 'null'}, 10, current_date, '${dates}'::jsonb, '${workflow}'::jsonb)`)
}
const rowOf = () => sqlJson(`select assigned_to::text a, status::text s, assigned_user_id u, completed_dates cd, workflow w from orders where id = '${OID}'`)[0] || {}
// PATCH as a given production login.
const P = (who, body) => as(who, `/orders?id=eq.${OID}`, { method: 'PATCH', body: JSON.stringify(body) })

// ── E2.A: the admin-set plan routes the order stage → stage automatically ───
console.log('── E2.A: completing a stage routes to the pre-assigned next owner ──')
seed()
// The screener completes screening and the order flows to the EXAMINER (the
// admin's pre-set examiner owner), staying in the pool — no Admin gate.
const a1 = await P('screener', { completed_dates: { screener: '2026-06-01' }, assigned_to: 'user', assigned_user_id: EXAMINER, status: 'examining' })
check('screener → examiner routing allowed', a1.status < 400, `HTTP ${a1.status}`)
check('order now owned by examiner, still in pool, at examining',
  rowOf().a === 'user' && rowOf().u === EXAMINER && rowOf().s === 'examining',
  `a=${rowOf().a} u=${rowOf().u} s=${rowOf().s}`)
// The old owner (screener) can no longer write it; the new owner (examiner) can.
const a2 = await P('screener', { progress: 999 })
check('previous owner can no longer write the order', a2.status >= 400 || rowOf().a === 'user')
check('previous owner did not change it', sqlJson(`select progress from orders where id = '${OID}'`)[0].progress === 10)
const a3 = await P('examiner', { completed_dates: { screener: '2026-06-01', examiner: '2026-06-02' }, assigned_to: 'user', assigned_user_id: TYPER, status: 'typing' })
check('examiner → typer routing allowed (new owner works it)', a3.status < 400, `HTTP ${a3.status}`)
check('order now owned by typer at typing', rowOf().u === TYPER && rowOf().s === 'typing', `u=${rowOf().u} s=${rowOf().s}`)

// ── E2.B: a production user can never choose who gets the order next ─────────
console.log('── E2.B: routing is confined to the plan (anti-bias) ──')
seed()
// Route to an OUTSIDER (on no stage) — refused.
const b1 = await P('screener', { completed_dates: { screener: '2026-06-01' }, assigned_to: 'user', assigned_user_id: OUTSIDER, status: 'examining' })
check('routing to an off-plan user refused', b1.status >= 400, `HTTP ${b1.status}`)
check('owner unchanged after refusal', rowOf().u === SCREENER)
// Route to the TYPER (skipping the examiner, i.e. the wrong next owner) — refused.
const b2 = await P('screener', { completed_dates: { screener: '2026-06-01' }, assigned_to: 'user', assigned_user_id: TYPER, status: 'examining' })
check('routing to the wrong next-stage user refused', b2.status >= 400, `HTTP ${b2.status}`)
// Hand to the examiner WITHOUT completing the stage (no stamp) — refused.
const b3 = await P('screener', { assigned_user_id: EXAMINER })
check('handing the order on without completing the stage refused', b3.status >= 400, `HTTP ${b3.status}`)
check('owner still the screener', rowOf().u === SCREENER)
// Hand directly to another DESK role — refused.
const b4 = await P('screener', { completed_dates: { screener: '2026-06-01' }, assigned_to: 'delivery', status: 'delivery' })
check('direct desk-to-desk handoff refused', b4.status >= 400, `HTTP ${b4.status}`)

// ── E2.C: the plan and singleSeating are admin-only ─────────────────────────
console.log('── E2.C: a production user cannot rewrite the plan ──')
seed()
// Rewrite stagePlan so the next stage points at oneself — refused.
const forged = JSON.stringify({ singleSeating: false, stagePlan: { screener: SCREENER, examiner: SCREENER, typer: TYPER, delivery: DELIVERY } })
const c0 = await P('screener', { workflow: JSON.parse(forged) })
check('rewriting the stage plan refused', c0.status >= 400, `HTTP ${c0.status}`)
check('plan unchanged in DB', rowOf().w?.stagePlan?.examiner === EXAMINER)
// Flip singleSeating to true (to try to earn the in-seat bypass) — refused.
const c1b = await P('screener', { workflow: { singleSeating: true, stagePlan: { screener: SCREENER, examiner: EXAMINER, typer: TYPER, delivery: DELIVERY } } })
check('flipping singleSeating refused', c1b.status >= 400, `HTTP ${c1b.status}`)
check('singleSeating still false', rowOf().w?.singleSeating === false)

// ── E2.D: escalation to Admin still works (disruption / query path) ──────────
console.log('── E2.D: a stuck owner can still send it back to Admin ──')
seed()
const d1 = await P('screener', { assigned_to: 'admin', workflow: { singleSeating: false, stagePlan: { screener: SCREENER, examiner: EXAMINER, typer: TYPER, delivery: DELIVERY }, handoff: { note: 'need a clarification' } } })
check('escalation to Admin allowed', d1.status < 400, `HTTP ${d1.status}`)
check('order now parked with Admin', rowOf().a === 'admin', `a=${rowOf().a}`)

// ── E2.E: a plan slot with no owner parks that stage with Admin ─────────────
console.log('── E2.E: an unassigned next stage returns to Admin ──')
const gapPlan = JSON.stringify({ singleSeating: false, stagePlan: { screener: SCREENER, examiner: '', typer: TYPER, delivery: DELIVERY } })
seed(gapPlan)
// Completing screener when the examiner slot is empty: routing in-pool is refused…
const e1 = await P('screener', { completed_dates: { screener: '2026-06-01' }, assigned_to: 'user', assigned_user_id: SCREENER, status: 'examining' })
check('routing into an unassigned stage refused', e1.status >= 400, `HTTP ${e1.status}`)
// …but returning to Admin to fill the gap is allowed.
seed(gapPlan)
const e2 = await P('screener', { completed_dates: { screener: '2026-06-01' }, assigned_to: 'admin', status: 'examining' })
check('completing into a gap returns to Admin', e2.status < 400, `HTTP ${e2.status}`)
check('order parked with Admin at examining', rowOf().a === 'admin' && rowOf().s === 'examining')

// ── E2.F: legacy orders (no plan) are untouched ─────────────────────────────
console.log('── E2.F: no plan ⇒ A1 behaviour, unchanged ──')
// Legacy single-seating: in-seat advance with no gate, same owner.
seed(JSON.stringify({ singleSeating: true }), { status: 'screening' })
const f1 = await P('screener', { completed_dates: { screener: '2026-06-01' }, assigned_to: 'user', status: 'examining' })
check('legacy single-seating in-seat advance allowed', f1.status < 400, `HTTP ${f1.status}`)
check('stayed in pool at examining', rowOf().a === 'user' && rowOf().s === 'examining')
// Legacy non-single-seating: the every-stage Admin gate still bites.
seed(JSON.stringify({ singleSeating: false }), { status: 'screening' })
const f2 = await P('screener', { completed_dates: { screener: '2026-06-01' }, assigned_to: 'user', status: 'examining' })
check('legacy non-single stamp without Admin refused', f2.status >= 400, `HTTP ${f2.status}`)
const f3 = await P('screener', { completed_dates: { screener: '2026-06-01' }, assigned_to: 'admin', status: 'examining' })
check('legacy non-single stamp + return-to-Admin allowed', f3.status < 400, `HTTP ${f3.status}`)

sql(`delete from orders where id = '${OID}'`)

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed')
process.exit(failures ? 1 : 0)

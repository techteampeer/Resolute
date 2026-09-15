// Desk and client figures, derived from the orders the signed-in user can see.
//
// Every dashboard shipped with invented numbers — "Passed Today 5", "Delivered
// (MTD) 79", "Completed (YTD) 12" — and four sidebars carried invented queue
// badges. None of them moved when the data moved, so a screener's sidebar read
// "Screening Queue 3" over an empty queue and a pilot client was shown twelve
// completed orders on their first day. Anything a staff member might quote to a
// client, or a client might quote back, has to come from the rows.
//
// Per-stage averages are deliberately absent. The order row records the DATE a
// stage completed (`completedDates`), never a start or an end time, so "Avg
// Screen Time 18m" and "Avg Delivery 22m" cannot be computed from what is
// stored. An invented average is worse than no average, so those tiles are gone
// rather than guessed. Client turnaround IS computable — `created` and
// `completed` are both on the row — so that one stays and reads '—' until there
// is something to average.

export const todayISO = () => new Date().toISOString().slice(0, 10)
export const monthISO = () => todayISO().slice(0, 7)
export const yearISO  = () => todayISO().slice(0, 4)

// Dates arrive as 'YYYY-MM-DD' or a full timestamp depending on the source.
const day = (v) => (typeof v === 'string' ? v.slice(0, 10) : '')
const inPeriod = (v, prefix) => { const d = day(v); return !!d && d.startsWith(prefix) }

// Orders sitting on one desk right now. This is the queue every account on that
// desk shares — the same set the queue screen and the sidebar badge show.
export const queueFor = (orders, role) => (orders || []).filter(o => o.assignedTo === role)

// Orders this desk finished within a period ('2026-09-11' for a day, '2026-09'
// for a month, '' for all time).
export const finishedBy = (orders, role, prefix = '') =>
  (orders || []).filter(o => inPeriod(o.completedDates?.[role], prefix))

// The four figures every production desk shows. Counting by desk rather than by
// person is deliberate: the queue belongs to the desk, and two screeners share
// it, so "completed today" means the desk's day.
export const deskStats = (orders, role) => {
  const queue = queueFor(orders, role)
  return {
    queue: queue.length,
    rush:  queue.filter(o => o.priority === 'rush').length,
    today: finishedBy(orders, role, todayISO()).length,
    month: finishedBy(orders, role, monthISO()).length,
  }
}

// Examiner-only: orders where the examiner ticked a problem. Written by the
// examiner's own submit (workflow.examIssues), so this is a real count.
export const issuesFlagged = (orders) =>
  (orders || []).filter(o => Object.values(o.workflow?.examIssues || {}).some(Boolean)).length

// Client-side figures, over that client's own orders.
export const clientStats = (orders) => {
  const all  = orders || []
  const live = all.filter(o => o.status !== 'delivered' && o.status !== 'cancelled')
  const spans = all
    .map(o => [Date.parse(day(o.created)), Date.parse(day(o.completed))])
    .filter(([a, b]) => !Number.isNaN(a) && !Number.isNaN(b) && b >= a)
    .map(([a, b]) => (b - a) / 86400000)
  return {
    active:       live.length,
    completedYtd: all.filter(o => inPeriod(o.completed, yearISO())).length,
    rush:         live.filter(o => o.priority === 'rush').length,
    turnaround:   spans.length
      ? `${(spans.reduce((s, n) => s + n, 0) / spans.length).toFixed(1)}d`
      : '—',
  }
}

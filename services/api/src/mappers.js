// DB row -> app shape. Mirrors toAppOrder in the frontend Supabase provider
// (src/lib/backends/supabase.js) so the GCP provider returns identical objects;
// the frontend can't tell which backend served a request. Pure and
// dependency-free, so it unit-tests without a database.
export function toAppOrder(r) {
  return {
    id: r.id,
    client: r.client_name || r.client_code,
    clientCode: r.client_code,
    state: r.state,
    county: r.county,
    type: r.type,
    status: r.status,
    priority: r.priority,
    payment: r.payment,
    clarification: r.clarification,
    clientFileNo: r.client_file_no,
    assignedTo: r.assigned_to,
    assignedUserId: r.assigned_user_id || null,
    screener: r.screener,
    examiner: r.examiner,
    typer: r.typer,
    delivery: r.delivery,
    progress: r.progress,
    created: r.created,
    eta: r.eta,
    completed: r.completed,
    completedDates: r.completed_dates || {},
    completedBy: r.completed_by || {},
    workflow: r.workflow || {},
    updatedAt: r.updated_at || null,
  }
}

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

// Display initials, exactly as the frontend's mapUser computes them.
const initials = (name = '') =>
  name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() || '').join('') || '?'

// Own profile row -> the portal user object (GET /api/me). Mirrors mapUser in the
// frontend Supabase provider field for field; email is the verified Firebase
// identity's (display only, as the Supabase auth email was). Fails closed: returns
// null (the caller answers 403) unless the row is the requester's own -- same
// profiles.id -- still active, and has a role. Never a default role, never a
// fabricated user, and nothing beyond these nine fields.
export function toAppUser(profile, user) {
  if (!profile || !user || profile.id !== user.id || profile.status !== 'active' || !profile.role) return null
  const email = user.email || null
  return {
    id: profile.id,
    email,
    role: profile.role,
    name: profile.name || email,
    avatar: initials(profile.name || email || ''),
    superAdmin: !!profile.super_admin,
    clientCode: profile.client_code || null,
    canConfirmPayments: !!profile.can_confirm_payments,
    permissions: Array.isArray(profile.permissions) ? profile.permissions : [],
  }
}

// Profile row -> the admin user-list entry (api/admin/users.js GET shape, with
// status from the database instead of the auth ban). Never the Firebase UID.
export function toAdminUser(r) {
  return {
    id: r.id,
    email: r.email || null,
    name: r.name || '',
    role: r.role || null,
    clientCode: r.client_code || null,
    superAdmin: !!r.super_admin,
    canConfirmPayments: !!r.can_confirm_payments,
    permissions: Array.isArray(r.permissions) ? r.permissions : [],
    status: r.status || null,
    active: r.status === 'active',
    created: r.created_at || null,
    updatedAt: r.updated_at || null,
  }
}

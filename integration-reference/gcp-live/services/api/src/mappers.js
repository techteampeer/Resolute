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

// Own profile row -> the portal user object. Mirrors mapUser in the frontend
// Supabase provider field for field; email is the verified Firebase identity's
// (display only, as the Supabase auth email was). Fails closed: returns null
// (the caller answers 403) unless the row is the requester's own -- same
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

// Stored document row -> the app's document reference (the shape the portal's
// upload components and order workflows carry: id, name, type, size, status),
// plus its kind and order. Never the storage object name or checksum.
const DOC_KIND = { 'application/pdf': 'pdf', 'application/msword': 'word',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'word' }
export function toAppDocument(r) {
  return {
    id: r.id,
    documentId: r.id,
    orderId: r.order_id,
    kind: r.kind,
    name: r.filename,
    type: DOC_KIND[r.content_type] || 'other',
    contentType: r.content_type,
    size: Number(r.size_bytes),
    status: 'done',
    uploadedAt: r.stored_at || null,
  }
}

// Message row -> the portal's message shape (SupportContext): `from` is the
// stored sender ('client' | 'support'); `mine` says whether the caller wrote it.
// `author` is null where the caller may not see the person (production staff
// reading a client's message).
export function toAppMessage(r) {
  return {
    id: r.id,
    clientCode: r.client_code,
    orderId: r.order_id || null,
    from: r.sender,
    visibility: r.visibility,
    text: r.body,
    author: r.author || null,
    mine: !!r.mine,
    attachment: null,
    createdAt: r.created_at,
  }
}

// Activity row -> the portal's activity entry (OrderContext / ActivityTab).
export function toAppEvent(r) {
  return {
    id: r.id,
    orderId: r.order_id || null,
    kind: r.kind,
    type: r.type,
    action: r.action,
    actor: r.actor || null,
    meta: r.meta || {},
    createdAt: r.created_at,
  }
}

// Notification row -> what the bell shows and where it leads (`target`: the
// order, its messages, or the support conversation).
export function toAppNotification(r) {
  return {
    id: r.id,
    kind: r.kind,
    orderId: r.order_id || null,
    target: r.target,
    title: r.title,
    body: r.body || null,
    createdAt: r.created_at,
    readAt: r.read_at || null,
    read: !!r.read_at,
  }
}

// Client contact (client_contacts, section 14) -> the shape useContacts uses.
export function toAppContact(r) {
  return {
    id: r.id, clientCode: r.client_code, name: r.name, email: r.email || '', phone: r.phone || '', title: r.title || '',
    marketingOptIn: !!r.marketing_opt_in, createdBy: r.created_by || null, createdAt: r.created_at, updatedAt: r.updated_at,
  }
}

// Company profile (client_profiles, section 14) -> the shape useClientProfile uses.
export function toAppProfile(r) {
  return {
    clientCode: r.client_code, address: r.address || '', city: r.city || '', state: r.state || '', zip: r.zip || '',
    phone: r.phone || '', website: r.website || '', logoUrl: r.logo_url || '', updatedBy: r.updated_by || null, updatedAt: r.updated_at,
  }
}

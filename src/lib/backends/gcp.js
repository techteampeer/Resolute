// GCP backend provider — STUB (ADR 0002, phases B2–B5).
//
// Selected only when VITE_BACKEND=gcp, which NO deployment sets yet. Its job
// right now is to make the backend contract explicit and keep the seam
// compiling. The real implementation — Firebase Auth (B3) over the Cloud Run
// data API (B2), with realtime (B4) and Cloud Storage (B5) — lands later and
// replaces these bodies one function at a time, behind this same surface.
//
// Semantics while unwired: `isSupabaseConfigured` is false, so selecting this
// provider makes the app behave exactly like "no backend connected" (mock
// data) rather than white-screening. Reads resolve empty, writes report a
// clear not-wired error, realtime subscriptions are inert, and the handful of
// functions the app calls for their side effect only are no-ops.

const writeErr = (phase) => ({ ok: false, error: `GCP backend not wired yet (ADR 0002, ${phase})` })
const notImpl = (fn) => { throw new Error(`GCP backend not implemented yet: ${fn} — see docs/adr/0002 (B2+)`) }
const inertUnsub = () => () => {}

// Mirrors supabase.js's flag. False here means "the active (GCP) backend is not
// configured", so every isSupabaseConfigured guard in the app falls back to mock
// until the real provider lands. (Renaming this to isBackendConfigured app-wide
// is a later, separate cleanup — kept as-is now to stay non-breaking.)
export const isSupabaseConfigured = false

// ── Auth ──────────────────────────────────────────────────────────────────────
export async function getCurrentUser() { return null }
export async function getAccessToken() { return null }
export async function signIn() { return { success: false, error: 'GCP backend not wired yet (ADR 0002, B3)' } }
export async function signOut() { /* no session to end */ }
export function onAuthChange() { return inertUnsub() }
export async function updatePassword() { return { success: false, error: 'GCP backend not wired yet (ADR 0002, B3)' } }
export function onPasswordRecovery() { return inertUnsub() }

// ── Orders ──────────────────────────────────────────────────────────────────
export async function fetchOrders() { return null }
export async function fetchOrderById() { return { row: null } }
export async function saveOrder() { return writeErr('B2') }
export async function insertOrder() { notImpl('insertOrder') }
export function subscribeOrders() { return inertUnsub() }

// ── Support messages ──────────────────────────────────────────────────────────
export async function fetchSupportMessages() { return null }
export async function insertSupportMessage() { notImpl('insertSupportMessage') }
export async function markOrderPayment() { notImpl('markOrderPayment') }
export async function cancelOrderRpc() { notImpl('cancelOrderRpc') }
export async function respondClarificationRpc() { notImpl('respondClarificationRpc') }
export function subscribeSupport() { return inertUnsub() }

// ── Fulfillment ───────────────────────────────────────────────────────────────
export async function fetchFulfillment() { return null }
export async function saveFulfillment() { return writeErr('B2') }

// ── Notification preferences ──────────────────────────────────────────────────
export async function fetchNotificationTypes() { return null }
export async function fetchNotificationPreferences() { return null }
export async function saveNotificationPreference() { return writeErr('B2') }
export async function clearNotificationPreference() { return writeErr('B2') }

// ── Clients ───────────────────────────────────────────────────────────────────
export async function fetchClients() { return null }
export async function fetchClientTerms() { return null }
export async function saveClientTerms() { /* side-effect write; no-op until B2 */ }

// ── Client contacts ───────────────────────────────────────────────────────────
export async function fetchContacts() { return null }
export async function saveContact() { return writeErr('B2') }
export async function deleteContact() { return writeErr('B2') }

// ── Client company profile ────────────────────────────────────────────────────
export async function fetchClientProfile() { return null }
export async function saveClientProfile() { return writeErr('B2') }

// ── Vendors & payouts ─────────────────────────────────────────────────────────
export async function fetchVendors() { return null }
export async function saveVendorCycle() { /* side-effect write; no-op until B2 */ }
export async function savePayoutLedger() { /* side-effect write; no-op until B2 */ }

// ── Subscriptions ─────────────────────────────────────────────────────────────
export async function fetchSubscriptions() { return null }
export async function saveSubscription() { /* side-effect write; no-op until B2 */ }

// ── Audit trail ───────────────────────────────────────────────────────────────
export async function fetchActivity() { return null }
export async function logEvent() { /* side-effect write; no-op until B2 */ }

// ── Staff roster ──────────────────────────────────────────────────────────────
export async function fetchProfiles() { return null }

// ── Server-generated order IDs ────────────────────────────────────────────────
export async function nextOrderId() { return null }

// ── Storage (documents) ───────────────────────────────────────────────────────
export async function uploadDocument() { notImpl('uploadDocument') }       // B5
export async function removeDocument() { /* no-op until B5 */ }
export async function openDocument() { return null }                       // B5

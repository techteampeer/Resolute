// Backend seam — the single place the app gets its data/auth/realtime/storage
// provider (ADR 0002). The app imports every backend function from here and
// never from a concrete provider, so swapping Supabase for the GCP-native stack
// is a one-line selection, not a hunt across the codebase.
//
// Selection is build-time: VITE_BACKEND picks the provider, defaulting to
// `supabase` so every existing build (Vercel included) behaves exactly as
// before. `gcp` selects the Cloud SQL + Firebase provider (stubbed until B2+).
// Because VITE_BACKEND is a compile-time constant, the branch folds away and
// the unused provider tree-shakes out of the bundle.
import * as supabaseProvider from './backends/supabase'
import * as gcpProvider from './backends/gcp'

const provider = import.meta.env.VITE_BACKEND === 'gcp' ? gcpProvider : supabaseProvider

// Re-export the whole contract from the selected provider. Keep this list in
// sync with the provider surface — a name present here but missing on a provider
// is a contract gap (it re-exports as undefined), which the providers' matching
// shapes are meant to prevent.
export const {
  // config flag (true when the ACTIVE backend is configured; false ⇒ mock mode)
  isSupabaseConfigured,
  // auth
  getCurrentUser, getAccessToken, signIn, signOut, onAuthChange, updatePassword, onPasswordRecovery,
  // orders
  fetchOrders, fetchOrderById, saveOrder, insertOrder, subscribeOrders,
  // support messages
  fetchSupportMessages, insertSupportMessage, markOrderPayment, cancelOrderRpc, respondClarificationRpc, subscribeSupport,
  // fulfillment
  fetchFulfillment, saveFulfillment,
  // notification preferences
  fetchNotificationTypes, fetchNotificationPreferences, saveNotificationPreference, clearNotificationPreference,
  // clients
  fetchClients, fetchClientTerms, saveClientTerms,
  // client contacts (per-company people directory)
  fetchContacts, saveContact,
  // vendors & payouts
  fetchVendors, saveVendorCycle, savePayoutLedger,
  // subscriptions
  fetchSubscriptions, saveSubscription,
  // audit trail
  fetchActivity, logEvent,
  // staff roster / ids
  fetchProfiles, nextOrderId,
  // storage
  uploadDocument, removeDocument, openDocument,
} = provider

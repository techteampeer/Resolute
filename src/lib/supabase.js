// Supabase client — single instance for the whole app.
//
// The app runs on mock data until BOTH env vars are present, so it keeps
// working on Vercel / locally before the backend is connected. Check
// `isSupabaseConfigured` before calling Supabase; fall back to mock otherwise.
import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

export const isSupabaseConfigured = Boolean(url && anonKey)

export const supabase = isSupabaseConfigured
  ? createClient(url, anonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    })
  : null

if (!isSupabaseConfigured && import.meta.env.DEV) {
  console.info('[supabase] Not configured — running on mock data. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to enable the backend.')
}

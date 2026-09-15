// HTTP access to the portal's own API (server/).
//
// Replaces the Supabase client. The browser holds no token and no database
// credentials: the session is an httpOnly cookie the server set at sign-in, so
// every request just needs to carry cookies. That is also why there is no
// Authorization header anywhere in the app any more.
//
// `isBackendConfigured` keeps the old meaning of `isBackendConfigured`: false
// means run on mock data. A production build is always served by the server that
// provides /api, so it is configured by definition; `vite dev` is only
// configured when VITE_API_BASE is set (with a matching proxy in vite.config.js),
// which preserves the previous "works on mock data until the backend is wired
// up" behaviour.
const BASE = import.meta.env.VITE_API_BASE || '/api'

export const isBackendConfigured =
  import.meta.env.PROD || import.meta.env.VITE_API_BASE != null

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message)
    this.status = status
    this.body = body
  }
}

async function request(method, path, { body, form, signal } = {}) {
  const init = {
    method,
    // Same-origin in production; the cookie is httpOnly so this is the only way
    // the session travels.
    credentials: 'same-origin',
    signal,
  }
  if (form) init.body = form
  else if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify(body)
  }

  const res = await fetch(`${BASE}${path}`, init)
  const text = await res.text()
  let parsed = null
  if (text) { try { parsed = JSON.parse(text) } catch { parsed = text } }

  if (!res.ok) {
    const message = (parsed && parsed.error) || res.statusText || 'Request failed'
    throw new ApiError(message, res.status, parsed)
  }
  return parsed
}

export const api = {
  get: (p, o) => request('GET', p, o),
  post: (p, body, o) => request('POST', p, { ...o, body }),
  put: (p, body, o) => request('PUT', p, { ...o, body }),
  patch: (p, body, o) => request('PATCH', p, { ...o, body }),
  del: (p, body, o) => request('DELETE', p, { ...o, body }),
  upload: (p, form, o) => request('POST', p, { ...o, form }),
  /** EventSource for the change stream; cookies ride along automatically. */
  stream: (p) => new EventSource(`${BASE}${p}`, { withCredentials: true }),
}

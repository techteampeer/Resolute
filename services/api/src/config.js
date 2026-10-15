// Fail-fast runtime config. On Cloud Run these come from the service env plus
// Secret Manager (DB_PASSWORD); locally from a .env / the Cloud SQL Auth Proxy.
function required(name) {
  const v = process.env[name]
  if (!v) throw new Error(`Missing required env var: ${name}`)
  return v
}

// Cloud Run + the Cloud SQL connector mount a unix socket at
// /cloudsql/<INSTANCE_CONNECTION_NAME>. Locally, point DB_HOST at the Auth Proxy
// (127.0.0.1:5432). node-postgres treats a socket-directory `host` correctly.
function dbHost() {
  if (process.env.DB_HOST) return process.env.DB_HOST
  if (process.env.DB_INSTANCE_CONNECTION_NAME) return `/cloudsql/${process.env.DB_INSTANCE_CONNECTION_NAME}`
  return '127.0.0.1'
}

export const config = {
  port: Number(process.env.PORT || 8080),
  db: {
    host: dbHost(),
    port: Number(process.env.DB_PORT || 5432),
    user: required('DB_USER'),         // the non-superuser app login (resolute_app)
    password: required('DB_PASSWORD'), // from Secret Manager; never baked into the image
    database: required('DB_NAME'),
    max: Number(process.env.DB_POOL_MAX || 10),
  },
  // Verified against this project's Firebase tokens.
  firebaseProjectId: process.env.FIREBASE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || null,
}

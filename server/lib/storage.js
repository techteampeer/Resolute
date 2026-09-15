import { Storage } from '@google-cloud/storage'

/**
 * Document storage on Google Cloud Storage.
 *
 * Replaces Supabase Storage. One difference matters and is easy to miss:
 * Supabase enforced RLS policies on storage.objects, so the DATABASE decided who
 * could read a file (documents_client_read / documents_staff_all). GCS does not
 * consult Postgres at all, and a signed URL is a bearer token — whoever holds it
 * can fetch the object until it expires, whoever they are.
 *
 * So the access check has to happen in the route that mints the URL, by reading
 * the owning order through withUser() first: if RLS hides the order, there is
 * nothing to sign. Never sign a path that arrived from the client unchecked.
 */
const storage = new Storage({
  projectId: process.env.GOOGLE_CLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID,
})

function bucket() {
  const name = process.env.BUCKET_NAME
  if (!name) throw new Error('BUCKET_NAME is not set')
  return storage.bucket(name)
}

export async function upload(path, buffer, contentType) {
  await bucket().file(path).save(buffer, { contentType, resumable: false })
}

/**
 * A short-lived read URL.
 *
 * On Cloud Run there is no service-account private key, so this signs through
 * the IAM credentials API — which needs the runtime service account to hold
 * "Service Account Token Creator" ON ITSELF. Without it this throws at signing
 * time, long after the upload appeared to succeed.
 */
export async function signedUrl(path, seconds = 3600) {
  const [url] = await bucket().file(path).getSignedUrl({
    version: 'v4', action: 'read', expires: Date.now() + seconds * 1000,
  })
  return url
}

export async function remove(path) {
  await bucket().file(path).delete({ ignoreNotFound: true })
}

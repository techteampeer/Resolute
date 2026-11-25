// Private Cloud Storage for order documents (gcp/terraform storage.tf: uniform
// access, public access prevention). The API is the only reader and writer:
// objects are never made public and no URL to one is ever handed out --
// downloads stream through the API after the database has authorized them, so
// the bucket's name never reaches a browser. Credentials are Application
// Default Credentials (the Cloud Run service account); none are configured or
// read here. The client library is loaded on first use; a test passes its own
// stand-in through `load` (the only substitution point -- there is no in-process
// fallback store, and an unconfigured bucket means document routes answer 503).

export class StorageMissing extends Error {}

export function gcsStorage(bucketName, load = () => import('@google-cloud/storage')) {
  if (!bucketName) throw new Error('gcsStorage: a bucket name is required')
  let bucketPromise = null
  const bucket = () => {
    bucketPromise ??= load()
      .then(({ Storage }) => new Storage().bucket(bucketName))
      .catch((err) => { bucketPromise = null; throw err })
    return bucketPromise
  }
  return {
    // A write stream for a NEW object: never overwrites (ifGenerationMatch 0),
    // one request (no resumable session left behind), integrity-checked by the
    // library, and stored as an attachment that is never cached.
    async writer(name, contentType) {
      return (await bucket()).file(name).createWriteStream({
        resumable: false,
        contentType,
        metadata: { contentType, contentDisposition: 'attachment', cacheControl: 'private, no-store' },
        preconditionOpts: { ifGenerationMatch: 0 },
      })
    },
    // { size, stream } for an existing object; StorageMissing if there is none.
    async reader(name) {
      const file = (await bucket()).file(name)
      let meta
      try {
        [meta] = await file.getMetadata()
      } catch (err) {
        if (err && Number(err.code) === 404) throw new StorageMissing('object not found')
        throw err
      }
      return { size: Number(meta.size), stream: file.createReadStream() }
    },
    async remove(name) {
      await (await bucket()).file(name).delete({ ignoreNotFound: true })
    },
    // Start-up check (index.js): the bucket exists and these credentials may
    // list it -- one object at most, with the permission the API already
    // needs (objectAdmin has no storage.buckets.get, so not bucket.exists()).
    async probe() {
      try {
        await (await bucket()).getFiles({ maxResults: 1, autoPaginate: false })
      } catch (err) {
        const code = Number(err && err.code)
        if (code === 404) throw new Error('the documents bucket does not exist')
        if (code === 401 || code === 403) throw new Error('the service account may not use the documents bucket')
        throw new Error(`the documents bucket could not be reached (${(err && err.code) || 'unknown'})`)
      }
    },
  }
}

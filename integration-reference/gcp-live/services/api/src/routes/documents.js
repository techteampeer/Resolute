// Order documents. Thin adapters over the database's document_* functions
// (who may add or remove what, decided from the caller's profile and the
// order's stored state) and the private Cloud Storage bucket (storage.js).
//   POST   /api/orders/:id/documents?kind=&filename=   raw file body -> 201 document
//   GET    /api/orders/:id/documents                   -> { documents } the caller may see
//   GET    /api/documents/:docId                       -> document metadata
//   GET    /api/documents/:docId/content               -> the file (attachment, nosniff)
//   DELETE /api/documents/:docId                       -> { id, status: 'deleted' }
// An upload is recorded 'uploading' before a byte is stored and 'stored' only
// after the object exists, so a failure anywhere is never reported as success
// and every leftover object is named by a 'uploading' / 'failed' / 'deleting'
// row (see services/api/README.md, "Reconciliation").
import { Router } from 'express'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createHash } from 'node:crypto'
import { withUserClaims } from '../db.js'
import * as docs from '../repositories/documents.js'
import { getOrder } from '../repositories/orders.js'
import { toAppDocument } from '../mappers.js'
import { StorageMissing } from '../storage.js'
import {
  FileRejected, MAX_DOCUMENT_BYTES, HEAD_BYTES, cleanFilename, expectedType, checkHead, wordMarkers, contentDisposition,
} from '../fileCheck.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const NOT_FOUND = 'not found'
// Logged with the error's code only: storage and database messages can carry
// bucket or server details, and no document byte is ever logged.
const log = (what, err) => console.error(`[documents] ${what}:`, (err && (err.code || err.name)) || 'unknown')

// The database's refusals, in the caller's terms. Hidden and absent are one 404.
const REFUSALS = { P0002: 404, 42501: 403, 22023: 400, 55000: 409 }
function refusalOf(err) {
  if (err instanceof FileRejected) return [err.status, err.message]
  const status = err && REFUSALS[err.code]
  if (!status) return null
  if (status === 404) return [404, NOT_FOUND]
  const msg = String(err.message || '')
  return [status, msg.startsWith('documents: ') ? msg.slice(11) : status === 403 ? 'not allowed' : 'invalid request']
}

// Answer at once without storing the rest of the body. Node reads and discards
// whatever the client is still sending once the response is out, so the browser
// gets the reason rather than a reset; the connection is not reused.
function refuse(req, res, status, error) {
  res.set('Cache-Control', 'no-store')
  if (!req.complete) res.set('Connection', 'close')
  if (!res.headersSent) res.status(status).json({ error })
}

// Read at least n bytes (or the whole body if shorter) without consuming more.
function readHead(stream, n) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    const done = (fn, value) => {
      stream.off('readable', onReadable); stream.off('end', onEnd); stream.off('error', onError); stream.off('close', onClose)
      fn(value)
    }
    const onReadable = () => {
      let c
      while ((c = stream.read()) !== null) {
        chunks.push(c); size += c.length
        if (size >= n) return done(resolve, { head: Buffer.concat(chunks, size), ended: false })
      }
    }
    const onEnd = () => done(resolve, { head: Buffer.concat(chunks, size), ended: true })
    const onError = (err) => done(reject, err)
    const onClose = () => { if (!stream.complete) done(reject, new Error('client aborted')) }
    stream.on('readable', onReadable); stream.on('end', onEnd); stream.on('error', onError); stream.on('close', onClose)
    onReadable()
  })
}

export function documentsRouter(storage) {
  const router = Router()
  const unavailable = 'document storage is not available'

  router.post('/orders/:id/documents', async (req, res) => {
    res.set('Cache-Control', 'no-store')
    if (!storage) return refuse(req, res, 503, unavailable)
    let kind, filename, type
    try {
      kind = String(req.query.kind || '')
      filename = cleanFilename(req.query.filename)
      type = expectedType(kind, filename)
    } catch (err) {
      return refuse(req, res, err.status || 400, err.message)
    }
    const declared = req.headers['content-length']
    if (declared !== undefined && Number(declared) > MAX_DOCUMENT_BYTES) return refuse(req, res, 413, 'the file is larger than 25 MB')
    if (declared === '0') return refuse(req, res, 400, 'the file is empty')

    // 1. Authorize and record the upload -- before reading the file.
    let up
    try {
      up = await withUserClaims(req.user, (c) => docs.beginUpload(c, req.params.id, kind, filename, type))
    } catch (err) {
      const r = refusalOf(err)
      if (r) return refuse(req, res, ...r)
      log('begin failed', err)
      return refuse(req, res, 500, 'internal error')
    }
    let aborted = false
    const markFailed = () => withUserClaims(req.user, (c) => docs.failUpload(c, up.id)).catch((err) => log(`could not mark ${up.id} failed`, err))
    const discard = () => storage.remove(up.objectName).catch((err) => log(`could not remove the object of ${up.id}`, err))

    // 2. The first bytes must prove the type the name claims.
    let head, ended
    try {
      ({ head, ended } = await readHead(req, HEAD_BYTES))
      checkHead(head, type)
    } catch (err) {
      await markFailed()
      if (err instanceof FileRejected) return refuse(req, res, err.status, err.message)
      return undefined                                     // the client went away
    }

    // 3. Stream to storage: counted, hashed, size-limited, never overwriting.
    const hash = createHash('sha256')
    const word = type === DOCX ? wordMarkers() : null
    let size = 0
    const checker = new Transform({
      transform(chunk, _enc, cb) {
        size += chunk.length
        if (size > MAX_DOCUMENT_BYTES) return cb(new FileRejected(413, 'the file is larger than 25 MB'))
        hash.update(chunk)
        if (word) word.feed(chunk)
        return cb(null, chunk)
      },
      flush(cb) {
        if (word && !word.complete()) return cb(new FileRejected(415, 'the file content does not match its type (not a Word document)'))
        return cb()
      },
    })
    // Watch for the client going away from here on (opening storage is async).
    const onAbort = () => { if (!req.complete) { aborted = true; checker.destroy(new Error('client aborted')) } }
    req.on('close', onAbort)
    req.on('error', onAbort)
    let writer
    try {
      writer = await storage.writer(up.objectName, type)
    } catch (err) {
      req.off('close', onAbort); req.off('error', onAbort)
      log('storage unavailable', err)
      await markFailed()
      return aborted ? undefined : refuse(req, res, 503, 'document storage is unavailable; nothing was stored')
    }
    if (aborted) {                                       // gone while storage was opening: nothing was written
      req.off('close', onAbort); req.off('error', onAbort)
      writer.destroy()
      await markFailed()
      return undefined
    }
    checker.write(head)
    if (ended) checker.end()
    else req.pipe(checker)
    try {
      await pipeline(checker, writer)
    } catch (err) {
      req.unpipe(checker)
      await discard()
      await markFailed()
      if (aborted) return undefined
      if (err instanceof FileRejected) return refuse(req, res, err.status, err.message)
      log('storage write failed', err)
      return refuse(req, res, 502, 'the document could not be stored; nothing was saved — try again')
    } finally {
      req.off('close', onAbort)
      req.off('error', onAbort)
    }

    // 4. Only now is it a document.
    try {
      const row = await withUserClaims(req.user, (c) => docs.finishUpload(c, up.id, size, hash.digest('hex'), type))
      return res.status(201).json(toAppDocument(row))
    } catch (err) {
      await discard()
      await markFailed()
      const r = refusalOf(err)
      if (r) return res.status(r[0]).json({ error: r[1] })
      log('finish failed', err)
      return res.status(500).json({ error: 'the document could not be recorded; nothing was saved — try again' })
    }
  })

  router.get('/orders/:id/documents', async (req, res, next) => {
    res.set('Cache-Control', 'no-store')
    try {
      const rows = await withUserClaims(req.user, async (c) => ((await getOrder(c, req.params.id)) ? docs.listOrderDocuments(c, req.params.id) : null))
      if (!rows) return res.status(404).json({ error: NOT_FOUND })
      return res.json({ documents: rows.map(toAppDocument) })
    } catch (err) {
      return next(err)
    }
  })

  router.get('/documents/:docId', async (req, res, next) => {
    res.set('Cache-Control', 'no-store')
    if (!UUID.test(req.params.docId)) return res.status(404).json({ error: NOT_FOUND })
    try {
      const row = await withUserClaims(req.user, (c) => docs.getDocument(c, req.params.docId))
      return row ? res.json(toAppDocument(row)) : res.status(404).json({ error: NOT_FOUND })
    } catch (err) {
      return next(err)
    }
  })

  router.get('/documents/:docId/content', async (req, res, next) => {
    res.set('Cache-Control', 'no-store')
    if (!UUID.test(req.params.docId)) return res.status(404).json({ error: NOT_FOUND })
    if (!storage) return res.status(503).json({ error: unavailable })
    let row
    try {
      row = await withUserClaims(req.user, (c) => docs.getDocument(c, req.params.docId))
    } catch (err) {
      return next(err)
    }
    if (!row) return res.status(404).json({ error: NOT_FOUND })
    let object
    try {
      object = await storage.reader(row.object_name)
    } catch (err) {
      if (err instanceof StorageMissing) {
        console.error('[documents] stored object missing for document', row.id)
        return res.status(502).json({ error: 'the stored file is missing; it cannot be downloaded' })
      }
      log('storage read failed', err)
      return res.status(503).json({ error: 'document storage is unavailable' })
    }
    if (object.size !== Number(row.size_bytes)) {
      object.stream.destroy()
      console.error('[documents] stored object does not match its record:', row.id)
      return res.status(502).json({ error: 'the stored file does not match its record; it cannot be downloaded' })
    }
    res.status(200).set({
      'Content-Type': row.content_type,
      'Content-Length': String(object.size),
      'Content-Disposition': contentDisposition(row.filename),
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cross-Origin-Resource-Policy': 'same-origin',
    })
    try {
      await pipeline(object.stream, res)
    } catch (err) {
      log(`download of ${row.id} interrupted`, err)
      res.destroy()
    }
    return undefined
  })

  router.delete('/documents/:docId', async (req, res, next) => {
    res.set('Cache-Control', 'no-store')
    const id = req.params.docId
    if (!UUID.test(id)) return res.status(404).json({ error: NOT_FOUND })
    if (!storage) return res.status(503).json({ error: unavailable })
    let objectName
    try {
      objectName = await withUserClaims(req.user, (c) => docs.beginDelete(c, id))
    } catch (err) {
      const r = refusalOf(err)
      return r ? res.status(r[0]).json({ error: r[1] }) : next(err)
    }
    try {
      await storage.remove(objectName)
    } catch (err) {
      log(`storage delete of ${id} failed`, err)
      await withUserClaims(req.user, (c) => docs.abortDelete(c, id)).catch((e) => log(`could not restore ${id}`, e))
      return res.status(502).json({ error: 'the document could not be removed from storage; it is still available' })
    }
    try {
      await withUserClaims(req.user, (c) => docs.finishDelete(c, id))
    } catch (err) {
      log(`removal of ${id} not recorded`, err)
      return res.status(500).json({ error: 'the file was removed but the removal could not be recorded; it will be reconciled' })
    }
    return res.json({ id, status: 'deleted' })
  })

  return router
}

// A small typed error the routes map to an HTTP status. Thrown from inside a
// withUserClaims transaction so the throw also rolls the transaction back; the
// route catches it and replies with { error: message } at `status`. Its message
// is caller-safe (never an internal/DB detail — server.js's handler keeps those
// out of the body), so it is the one error whose text we do surface.
export class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.name = 'HttpError'
    this.status = status
  }
}

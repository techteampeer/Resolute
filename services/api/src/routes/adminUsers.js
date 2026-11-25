// /api/admin/users -- account management for administrators. Thin adapter:
// provisioning.js orders the Firebase and database steps, and the database
// decides who may do what. There is no signup: every account is created here
// by an authorized administrator, disabled and pending until activated.
//   GET  /                list accounts (active admins only)
//   POST /                create { email, name?, role, clientCode?, superAdmin?,
//                         canConfirmPayments?, permissions? } -> 201 { id, status: 'pending' }
//   POST /:id/activate    -> 200 { id, status: 'active' }
//   PATCH /:id            { updatedAt, name?, role?, clientCode?, superAdmin?, canConfirmPayments?, permissions? }
//                         -> 200 the account | 409 changed since read
//   POST /:id/deactivate  { updatedAt } -> 200 { id, status: 'inactive', signIn } | 502 locked out, sign-in not disabled yet
//   POST /:id/reactivate  { updatedAt } -> 200 { id, status: 'active', signIn: 'enabled' }
// No account is ever deleted here.
import { Router } from 'express'
import {
  AccountError, listAccounts, createAccount, activateAccount, updateAccount, deactivateAccount, reactivateAccount,
} from '../provisioning.js'

export const adminUsersRouter = Router()

const handle = (fn) => async (req, res, next) => {
  res.set('Cache-Control', 'no-store')
  try {
    const [status, body] = await fn(req)
    return res.status(status).json(body)
  } catch (err) {
    if (err instanceof AccountError) return res.status(err.status).json({ error: err.message })
    return next(err)
  }
}

adminUsersRouter.get('/', handle(async (req) => [200, { users: await listAccounts(req.user) }]))
adminUsersRouter.post('/', handle(async (req) => [201, await createAccount(req.user, req.body)]))
adminUsersRouter.post('/:id/activate', handle(async (req) => [200, await activateAccount(req.user, req.params.id)]))
adminUsersRouter.patch('/:id', handle(async (req) => [200, await updateAccount(req.user, req.params.id, req.body)]))
adminUsersRouter.post('/:id/deactivate', handle(async (req) => [200, await deactivateAccount(req.user, req.params.id, req.body)]))
adminUsersRouter.post('/:id/reactivate', handle(async (req) => [200, await reactivateAccount(req.user, req.params.id, req.body)]))

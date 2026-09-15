#!/usr/bin/env node
// Bind existing portal profiles to Identity Platform accounts.
//
// Firebase cannot import Supabase's password hashes, and profiles.id is a uuid
// that every RLS policy and foreign key is built on. So each person needs a
// Firebase account whose uid is recorded against their EXISTING profile uuid in
// auth.users — not a new profile.
//
// Binding is deliberate and done here rather than automatically on first
// sign-in. Auto-binding on a matching email would mean anyone able to create an
// Identity Platform account with a Resolute address inherits that person's
// profile, their orders and their clients' data.
//
// Usage (dry run prints the plan and changes nothing):
//   DB_USER=… DB_PASS=… DB_NAME=… FIREBASE_PROJECT_ID=… node scripts/link-firebase-users.mjs
//   …                                                    node scripts/link-firebase-users.mjs --apply
import { getAuth } from 'firebase-admin/auth'
import { initializeApp, applicationDefault, cert } from 'firebase-admin/app'
import pg from 'pg'

const APPLY = process.argv.includes('--apply')

const raw = process.env.FIREBASE_SERVICE_ACCOUNT
initializeApp({
  credential: raw ? cert(JSON.parse(raw)) : applicationDefault(),
  projectId: process.env.FIREBASE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT,
})
const auth = getAuth()

const instance = process.env.INSTANCE_CONNECTION_NAME
const db = new pg.Client({
  user: process.env.DB_USER, password: process.env.DB_PASS, database: process.env.DB_NAME,
  ...(instance ? { host: `/cloudsql/${instance}` }
               : { host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 5432) }),
})
await db.connect()

const { rows: profiles } = await db.query(
  `select p.id, p.email, p.name, p.role::text as role, u.firebase_uid
     from public.profiles p
     left join auth.users u on u.id = p.id
    where p.email is not null
    order by p.email`)

let linked = 0, created = 0, already = 0
for (const p of profiles) {
  if (p.firebase_uid) { already++; console.log(`  = ${p.email.padEnd(32)} already linked`); continue }

  let fb = await auth.getUserByEmail(p.email).catch(() => null)
  const willCreate = !fb
  console.log(`  ${willCreate ? '+' : '→'} ${p.email.padEnd(32)} ${willCreate ? 'create + link' : 'link existing'} (${p.role})`)
  if (!APPLY) continue

  if (!fb) {
    // A random password nobody is told: every account starts by using the
    // password-reset link, so no temporary secret is ever transmitted.
    fb = await auth.createUser({
      email: p.email, emailVerified: true, displayName: p.name || undefined,
      password: 'Rslt-' + crypto.randomUUID(),
    })
    created++
  }
  await db.query(
    `insert into auth.users (id, firebase_uid, email) values ($1,$2,$3)
     on conflict (id) do update set firebase_uid = excluded.firebase_uid`,
    [p.id, fb.uid, p.email])
  linked++
}

console.log(APPLY
  ? `\nlinked ${linked} (of which ${created} newly created), ${already} already linked`
  : `\nDRY RUN — ${profiles.length - already} would change, ${already} already linked. Re-run with --apply.`)
console.log('Each person then sets a password via the reset link from Admin → Users.')
await db.end()

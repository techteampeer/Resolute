#!/usr/bin/env node
// Email self-test — verifies SMTP credentials and shows exactly what a
// notification looks like, including the portal-only policy headers.
//
//   npm run email:test                 # compose only, print the message
//   npm run email:test -- you@work.com # actually send (needs SMTP_* set)
//
// Reads .env.local / .env if present so it behaves like the serverless runtime.
import { readFileSync, existsSync } from 'node:fs'
import { sendMail, mailFrom, replyTo, isSmtpLive, PORTAL_URL } from '../api/_lib/mailer.js'

for (const f of ['.env.local', '.env']) {
  if (!existsSync(f)) continue
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_0-9]+)\s*=\s*(.*)\s*$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').split('#')[0].trim()
  }
}

const to = process.argv[2] || null
const missing = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS'].filter(v => !process.env[v])

console.log('\n── Resolute email self-test ─────────────────────────────')
console.log('SMTP live     :', isSmtpLive() ? 'YES — messages will be SENT' : 'NO  — compose only (set SMTP_HOST to send)')
if (missing.length) console.log('Missing vars  :', missing.join(', '))
console.log('From          :', mailFrom())
console.log('Reply-To      :', replyTo())
console.log('Portal URL    :', PORTAL_URL())
console.log('Recipient     :', to || '(none given — pass one to send)')
console.log('─────────────────────────────────────────────────────────\n')

if (!to) {
  console.log('No recipient. Re-run as:  npm run email:test -- you@example.com\n')
  process.exit(0)
}

try {
  const result = await sendMail({
    to,
    subject: 'Resolute portal — email self-test',
    text: 'This is a test notification from the Resolute portal.\n\nIf you received it, SMTP is configured correctly.',
    link: `${PORTAL_URL()}/client/support`,
  })
  if (isSmtpLive()) {
    console.log('✅ Sent. messageId:', result.messageId)
    console.log('   Check the inbox (and spam) for', to)
  } else {
    console.log('📝 Composed (not sent). Full message below:\n')
    console.log(result.message)
  }
  console.log('\nVerify: Reply-To is the no-reply address, and the body ends with')
  console.log('the "mailbox is not monitored" footer + portal link.\n')
} catch (err) {
  console.error('❌ Send failed:', err?.message || err)
  console.error('\nCommon causes: wrong SMTP_PASS (use a Gmail App Password, not the')
  console.error('account password), port/secure mismatch (465 = secure), or the')
  console.error('provider blocking sign-in from this network.\n')
  process.exit(1)
}

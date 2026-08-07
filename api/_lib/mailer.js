// Outbound email transport. Uses SMTP when configured (e.g. Gmail with an app
// password) and falls back to nodemailer's jsonTransport otherwise, so
// dev/test compose-and-inspect messages without actually sending.
//
// Env (Vercel → Settings → Environment Variables):
//   SMTP_HOST   e.g. smtp.gmail.com
//   SMTP_PORT   e.g. 465
//   SMTP_USER   the Gmail address (also the default From)
//   SMTP_PASS   the Gmail app password (same one the IMAP ingest uses)
//   MAIL_FROM   optional From override (defaults to "Resolute <SMTP_USER>")
import nodemailer from 'nodemailer'

let _tx = null
export function transport() {
  if (_tx) return _tx
  const host = process.env.SMTP_HOST
  if (host) {
    const port = Number(process.env.SMTP_PORT || 465)
    _tx = nodemailer.createTransport({
      host, port, secure: port === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    })
  } else {
    // No SMTP configured — capture messages instead of sending (dev/test).
    _tx = nodemailer.createTransport({ jsonTransport: true })
  }
  return _tx
}

export const mailFrom = () =>
  process.env.MAIL_FROM || `Resolute Title Services <${process.env.SMTP_USER || 'no-reply@resolute.local'}>`

// Portal-only communication policy: outbound mail is NOTIFICATION ONLY. Replies
// must never land in a human (or ingest-monitored) mailbox, so every message
// carries a Reply-To pointing at an unmonitored address. Set MAIL_REPLY_TO to a
// real no-reply@yourdomain once DNS is configured.
export const replyTo = () =>
  process.env.MAIL_REPLY_TO || `no-reply@${(process.env.MAIL_DOMAIN || 'resolute.local')}`

export const PORTAL_URL = () => process.env.PORTAL_URL || 'https://portal.resolute.local'

const FOOTER = (link) => [
  '',
  '—',
  'This mailbox is not monitored — please do not reply to this email.',
  `All correspondence happens in the portal: ${link}`,
].join('\n')

export const isSmtpLive = () => Boolean(process.env.SMTP_HOST)

// `link` deep-links to the relevant thread; falls back to the portal root.
export async function sendMail({ to, subject, text, link }) {
  if (!to) return { skipped: 'no recipient' }
  const info = await transport().sendMail({
    from: mailFrom(),
    replyTo: replyTo(),
    to,
    subject,
    text: `${text}${FOOTER(link || PORTAL_URL())}`,
    headers: {
      // Marks this as machine-generated so well-behaved clients and mailing
      // systems don't auto-reply, and our own ingest can detect it.
      'Auto-Submitted': 'auto-generated',
      'X-Auto-Response-Suppress': 'All',
      'X-Resolute-Notification': '1',
    },
  })
  return { messageId: info.messageId, envelope: info.envelope, message: info.message?.toString?.() }
}

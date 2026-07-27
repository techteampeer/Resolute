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

export const isSmtpLive = () => Boolean(process.env.SMTP_HOST)

export async function sendMail({ to, subject, text }) {
  if (!to) return { skipped: 'no recipient' }
  const info = await transport().sendMail({ from: mailFrom(), to, subject, text })
  return { messageId: info.messageId, envelope: info.envelope, message: info.message?.toString?.() }
}

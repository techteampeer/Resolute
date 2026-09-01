// Preview sender — writes messages to disk instead of transmitting them.
//
// This exists so the notification cycle can be built, reviewed and signed off
// before SES has an identity or DNS has DKIM records. It is also the safe
// default: if NOTIFY_PROVIDER is unset, nothing leaves the building, which
// matters on a project whose recipients are real colleagues.
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export function previewProvider(env = process.env) {
  const dir = env.NOTIFY_PREVIEW_DIR || 'preview/notifications'
  let n = 0

  return {
    name: `preview:${dir}`,
    async send({ to, subject, html, text }) {
      await mkdir(dir, { recursive: true })
      const stem = `${String(++n).padStart(2, '0')}-`
        + subject.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)
      await writeFile(join(dir, `${stem}.html`), html, 'utf8')
      await writeFile(join(dir, `${stem}.txt`), `To: ${to}\nSubject: ${subject}\n\n${text}\n`, 'utf8')
      return { id: `preview-${stem}` }
    },
  }
}

// Sender that only logs, for a dry run against production data where writing
// files would be noise.
export function consoleProvider() {
  return {
    name: 'console',
    async send({ to, subject }) {
      console.log(`  [would send] ${to.padEnd(34)} ${subject}`)
      return { id: null }
    },
  }
}

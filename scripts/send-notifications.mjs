// Drain the notification outbox.
//
//   node scripts/send-notifications.mjs immediate
//   node scripts/send-notifications.mjs digest
//
// This is the runner, not the logic — everything real lives in
// services/notify/. On AWS the Lambda handler calls runNotifications() the same
// way, so this script and that handler stay interchangeable and neither owns
// behaviour the other lacks.
//
// Defaults to the preview provider: with no NOTIFY_PROVIDER set it writes files
// and mails nobody, which is what you want while pointing it at real data for
// the first time.
import { runNotifications } from '../services/notify/index.js'

const mode = process.argv[2] || 'immediate'

try {
  const r = await runNotifications({ mode })
  console.log(
    `[notify] mode=${r.mode} provider=${r.provider} `
    + `claimed=${r.claimed} messages=${r.messages} sent=${r.sent} failed=${r.failed}`)
  // A failure here means rows were returned to pending, not lost — but the exit
  // code has to reflect it so a scheduler surfaces the problem.
  process.exit(r.failed > 0 ? 1 : 0)
} catch (err) {
  console.error(`[notify] ${err.message}`)
  process.exit(1)
}

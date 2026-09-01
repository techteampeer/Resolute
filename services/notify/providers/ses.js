// Amazon SES v2 sender.
//
// Signs requests with SigV4 by hand against node:crypto rather than pulling in
// @aws-sdk/client-sesv2. The SDK is ~2 MB of dependency for one POST, it
// inflates a Lambda cold start, and CLAUDE.md asks that the Vercel deployment
// not accumulate libraries it will not keep. This is about sixty lines and has
// no supply chain.
//
// Credentials come from the environment, so this file is identical on Vercel
// (static IAM user keys) and on Lambda (role credentials injected as
// AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN). Nothing here
// needs to change on Friday.
import { createHash, createHmac } from 'node:crypto'

const sha256 = (data) => createHash('sha256').update(data, 'utf8').digest('hex')
const hmac = (key, data) => createHmac('sha256', key).update(data, 'utf8').digest()

function signingKey(secret, date, region, service) {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), service), 'aws4_request')
}

export function sesProvider(env = process.env) {
  const region = env.SES_REGION || env.AWS_REGION || 'us-east-1'
  const accessKey = env.AWS_ACCESS_KEY_ID
  const secretKey = env.AWS_SECRET_ACCESS_KEY
  const sessionToken = env.AWS_SESSION_TOKEN || null
  const from = env.NOTIFY_FROM
  const replyTo = env.NOTIFY_REPLY_TO || null
  const configSet = env.SES_CONFIGURATION_SET || null

  if (!accessKey || !secretKey) throw new Error('SES: AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY are not set')
  if (!from) throw new Error('SES: NOTIFY_FROM is not set (e.g. "Resolute Portal <notifications@resolutetitleservices.com>")')

  const host = `email.${region}.amazonaws.com`
  const path = '/v2/email/outbound-emails'

  return {
    name: `ses:${region}`,
    async send({ to, subject, html, text }) {
      const body = JSON.stringify({
        FromEmailAddress: from,
        Destination: { ToAddresses: [to] },
        ...(replyTo ? { ReplyToAddresses: [replyTo] } : {}),
        ...(configSet ? { ConfigurationSetName: configSet } : {}),
        Content: {
          Simple: {
            Subject: { Data: subject, Charset: 'UTF-8' },
            Body: {
              Html: { Data: html, Charset: 'UTF-8' },
              Text: { Data: text, Charset: 'UTF-8' },
            },
          },
        },
      })

      const now = new Date()
      const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '')  // 20260901T150000Z
      const dateStamp = amzDate.slice(0, 8)
      const payloadHash = sha256(body)

      // Header set must match, in order, between the canonical request and
      // SignedHeaders — a mismatch is the classic SigV4 403.
      const headers = {
        'content-type': 'application/json',
        host,
        'x-amz-date': amzDate,
        ...(sessionToken ? { 'x-amz-security-token': sessionToken } : {}),
      }
      const signedHeaders = Object.keys(headers).sort().join(';')
      const canonicalHeaders = Object.keys(headers).sort()
        .map(k => `${k}:${String(headers[k]).trim()}\n`).join('')

      const canonicalRequest = [
        'POST', path, '', canonicalHeaders, signedHeaders, payloadHash,
      ].join('\n')

      const scope = `${dateStamp}/${region}/ses/aws4_request`
      const stringToSign = [
        'AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest),
      ].join('\n')

      const signature = createHmac('sha256', signingKey(secretKey, dateStamp, region, 'ses'))
        .update(stringToSign, 'utf8').digest('hex')

      const res = await fetch(`https://${host}${path}`, {
        method: 'POST',
        headers: {
          ...headers,
          Authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, `
            + `SignedHeaders=${signedHeaders}, Signature=${signature}`,
        },
        body,
      })

      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        // SES sandbox rejections read as "Email address is not verified" — the
        // single most likely failure before production access is granted, so
        // surface the body rather than just the status.
        throw new Error(`SES ${res.status}: ${detail.slice(0, 400)}`)
      }
      const out = await res.json().catch(() => ({}))
      return { id: out.MessageId || null }
    },
  }
}

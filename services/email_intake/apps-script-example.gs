/**
 * REFERENCE ONLY — the Google half of email intake, sketched.
 *
 * This file is not deployed from this repository and is not executed by the
 * portal. It shows the contract the real Apps Script project must satisfy:
 * read the intake inbox, ask Gemini for structured JSON, POST it to the portal.
 * The full Google integration (labels, error handling, quota, retry policy,
 * per-client mapping) is deliberately not built yet.
 *
 * Script properties to set (File → Project properties → Script properties):
 *   TEST_INTAKE_EMAIL        the inbox to watch during the pilot
 *   PORTAL_URL               https://portal.resolutetitleservices.com
 *   EMAIL_INTAKE_API_SECRET  must match the portal's env var
 *   GCP_PROJECT / GCP_LOCATION / VERTEX_MODEL  for the Gemini call
 *
 * Nothing is hard-coded: swapping TEST_INTAKE_EMAIL for the real intake address
 * is a script-property change, not a code change.
 */

var P = PropertiesService.getScriptProperties();

function pollIntakeInbox() {
  var inbox = P.getProperty('TEST_INTAKE_EMAIL');
  if (!inbox) throw new Error('TEST_INTAKE_EMAIL is not set');

  // 'processed' is applied only after the POST succeeds, so a failed run is
  // retried on the next poll. The portal deduplicates on the Message-ID, so a
  // retry can never produce a second order.
  var threads = GmailApp.search('to:' + inbox + ' -label:processed newer_than:7d');

  threads.forEach(function (thread) {
    thread.getMessages().forEach(function (msg) {
      var extracted = extractWithGemini(msg);
      if (!extracted) return;                       // Gemini unsure — leave for a human

      extracted.email_message_id = msg.getHeader('Message-ID');
      extracted.source_email = msg.getFrom();
      extracted.subject = msg.getSubject();
      extracted.received_at = msg.getDate().toISOString();

      postToPortal(extracted);
    });
    thread.addLabel(GmailApp.getUserLabelByName('processed'));
  });
}

function postToPortal(payload) {
  var res = UrlFetchApp.fetch(P.getProperty('PORTAL_URL') + '/api/orders/email-intake', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-intake-secret': P.getProperty('EMAIL_INTAKE_API_SECRET') },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  var code = res.getResponseCode();
  // 2xx is done (201 created, 200 already processed). 4xx means the payload is
  // wrong — log it for a human, never retry. 5xx is safe to retry.
  if (code >= 400) {
    Logger.log('email-intake %s: %s', code, res.getContentText());
    if (code >= 500) throw new Error('portal unavailable — retry next poll');
  }
}

/**
 * Calls Vertex AI and returns the intake fields, or null when the model cannot
 * map the message confidently. `search_type` must be one of the portal's
 * catalog names, and `client_identifier` must be the client's code (CL01, …) —
 * the portal rejects anything else rather than guessing.
 */
function extractWithGemini(msg) {
  // Left unimplemented on purpose: the extraction prompt and the
  // sender → client-code mapping are the next piece of work.
  return null;
}

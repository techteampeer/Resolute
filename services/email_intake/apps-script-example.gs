/**
 * AI-Powered Email Extraction Workflow for Resolute using GCP Vertex AI
 *
 * REFERENCE COPY. Not deployed from this repository and never executed by the
 * portal — it lives here so the contract the Google project must satisfy sits
 * next to the API that depends on it.
 *
 * Reconciled from the project-lead script. Gmail and Vertex behaviour is theirs
 * and unchanged: the `label:resolute is:unread` queue, both the plain and HTML
 * bodies sent to the model (HTML is what makes customerLink extractable), the
 * OAuth-token Vertex call, and the 5-minute time-driven trigger.
 *
 * What is added is the portal connection:
 *
 *   Gmail → Vertex AI → [optional Sheet test log]
 *         → POST /api/orders/email-intake → client matched or created by the
 *           portal → order parked with Admin
 *
 * Three behaviours changed deliberately, and only these:
 *
 *  1. markRead() now happens ONLY after the API confirms the order (201) or
 *     confirms it already had it (200 duplicate). The lead script marked every
 *     message read even when extraction failed, which silently dropped it.
 *     Unread mail is the work queue, so every failure now stays unread.
 *  2. The Spreadsheet is optional and observational. It is opened lazily inside
 *     a try/catch and a logging failure cannot affect whether an order was
 *     posted or a message was marked read. Set SPREADSHEET_ID to "" to disable.
 *  3. There is no subject gate. Clients send unstructured emails, so EVERY
 *     unread message under the label goes to Vertex AI. A RES- number in the
 *     subject is read when present, as optional metadata, and never required.
 *
 * Dependencies:
 * - Gmail API
 * - Vertex AI API (requires linking Apps Script to a GCP Project)
 * - Google Sheets API (optional — testing/logging only)
 *
 * appsscript.json must request these scopes, or getOAuthToken() will not carry
 * Vertex permission and the fetch returns 401:
 *
 *   "oauthScopes": [
 *     "https://www.googleapis.com/auth/cloud-platform",
 *     "https://www.googleapis.com/auth/gmail.modify",
 *     "https://www.googleapis.com/auth/script.external_request",
 *     "https://www.googleapis.com/auth/spreadsheets"
 *   ]
 *
 * The script's Google identity must also hold Vertex AI User on GCP_PROJECT_ID.
 */

// --- CONFIGURATION (from the project-lead script) ---
const GCP_PROJECT_ID = "peer-website-504716"; // Your GCP Project ID
const GCP_REGION = "us-central1"; // Ensure this matches your Vertex AI region
const VERTEX_AI_MODEL = "gemini-2.5-pro"; // Recommended for fast text extraction

// --- SEARCH FILTER ---
// For testing: Only look in the specific label and ensure it's unread.
// For production: point this at the dedicated intake mailbox/label. Every unread
// match is sent to Vertex AI — there is no subject filter.
const GMAIL_SEARCH_QUERY = 'label:resolute is:unread';

// The RES- order number as it appears in the subject, e.g. RES-2026-1937.
// Optional metadata: most client emails will not carry one. When the subject
// does, it is read deterministically rather than trusted from the model — a
// regex cannot hallucinate one.
const RES_ORDER_NUMBER = /RES-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*/;

// --- OPTIONAL TEST LOG (testing only, never production logic) ---
// Set SPREADSHEET_ID to "" to disable. Nothing is ever read back out of this
// sheet to make a decision; it exists so a pilot run can be eyeballed.
const SPREADSHEET_ID = "1bAT4nKzk1cIqND2sFtTaghEdEct-fxnYMY09HzWaUGw";
const TARGET_SHEET_NAME = "Sheet1";

// Written to row 1 when the sheet is empty. NOTE: this layout adds Gmail
// Message ID and Client Email to the original six columns, so a sheet already
// populated under the old layout should be given a fresh tab rather than mixed.
const SHEET_HEADERS = [
  "Processing Timestamp",
  "Gmail Message ID",
  "Order Number",
  "Customer",
  "Client Email",
  "Customer File",
  "Customer Link",
  "Property Address",
  "API Result / Detail"
];

// 1-based position of "Gmail Message ID" in SHEET_HEADERS — the dedupe key.
const MESSAGE_ID_COLUMN = 2;

// --- PORTAL CONNECTION (script properties, so nothing sensitive is in code) ---
// File → Project properties → Script properties:
//   INTAKE_API_URL           https://…/api/orders/email-intake
//   EMAIL_INTAKE_API_SECRET  must match the portal's env var. Never logged.
// There is no client map: the portal resolves the client from the company name.
const PROPS = PropertiesService.getScriptProperties();

/** Read-only accessor so a missing property fails with a useful message. */
function prop(name, required) {
  const value = PROPS.getProperty(name);
  if (!value && required) throw new Error(`${name} is not set in Script properties`);
  return value;
}

// --- PRODUCT CATALOG ---
// Mirrors src/data/products.js so the model can only choose a product Resolute
// actually sells. The API re-validates and REJECTS anything it does not know,
// so a stale entry here surfaces as a 400 rather than a mispriced order.
const SEARCH_TYPES = [
  "Current Owner Search",
  "Two Owner Search",
  "Full Search",
  "Update / Bringdown",
  "Commercial Search",
  "Energy / Infrastructure",
  "Tax Search",
  "Patriot Name Search",
  "Bankruptcy Name Search",
  "Document Retrieval",
  "Lien Search",
  "Tax Certificate",
  "HOA Estoppel"
];

// The portal has exactly two priorities, so these are the only two turnarounds.
const TURNAROUNDS = ["Standard (48 hours)", "Rush (24 hours)"];

/**
 * Main execution function.
 * Designed to be triggered by a Time-Driven event (e.g., every 5 minutes).
 *
 * Name preserved from the lead script — createTimeDrivenTrigger() and any
 * trigger already created in the Google project both point at it.
 */
function processResoluteEmailsWithVertexAI() {
  const threads = GmailApp.search(GMAIL_SEARCH_QUERY);

  if (threads.length === 0) {
    Logger.log("Info: No new unread emails found matching the criteria.");
    return;
  }

  for (let i = 0; i < threads.length; i++) {
    const messages = threads[i].getMessages();

    for (let j = 0; j < messages.length; j++) {
      const message = messages[j];

      // Ensure we only process unread messages within the thread
      if (!message.isUnread()) continue;

      // No subject gate: every unread message under the label goes to Vertex
      // AI. Anything that is not a complete order fails extraction or API
      // validation and stays unread for a human.
      processResoluteMessage(message, message.getSubject());
    }
  }
}

/**
 * One message: extract, resolve the client, post, log, and mark read only on
 * success. Every early return leaves the message UNREAD so the next run — or a
 * human — picks it up. Nothing is ever silently dropped.
 */
function processResoluteMessage(message, subject) {
  // Gmail's own immutable message id. Preferred over the RFC Message-ID header,
  // which some senders omit or rewrite. The portal deduplicates on whatever we
  // send, so a stable id is what makes a retry safe.
  const messageId = message.getId();
  let payload = null;

  try {
    const plainBody = message.getPlainBody();
    const htmlBody = message.getBody();

    // Construct the context payload for the AI model. Both bodies go in: the
    // HTML version is where the customer link survives as a real href.
    const emailContext = `
      Subject: ${subject}

      Plain Text Body:
      ${plainBody}

      HTML Version (Reference for extracting hyperlinks):
      ${htmlBody}
    `;

    // Call Vertex AI to extract the required data points
    const extractedJsonData = extractEntitiesViaVertexAI(emailContext);

    if (!extractedJsonData) {
      Logger.log(`Warning: Failed to extract structured data for subject: ${subject}`);
      logToTestSheet(messageId, null, "extraction-failed", "");
      return;                                    // stays UNREAD
    }

    // The order number is optional metadata, never a gate: the API's own
    // required fields are the real validation. Take it from the subject, which
    // is authoritative, and fall back to whatever the model read.
    extractedJsonData.orderNumber =
      orderNumberFromSubject(subject) || extractedJsonData.orderNumber || "";

    // Belt and braces: the prompt forbids it and the schema has no such key,
    // but if a future prompt edit reintroduces one, drop it rather than let a
    // hallucinated code reach the API and bill the wrong client.
    delete extractedJsonData.client_identifier;
    delete extractedJsonData.clientCode;

    payload = buildIntakePayload(extractedJsonData, message, messageId);
    const outcome = postToPortal(payload);
    logToTestSheet(messageId, extractedJsonData, outcome.state, outcome.detail);

    // The one and only place mail is marked read.
    if (outcome.state === 'created' || outcome.state === 'duplicate') {
      message.markRead();
      Logger.log(`Success: ${outcome.state} ${outcome.detail} for order ${extractedJsonData.orderNumber || "(no RES- number read)"}`);
    } else {
      Logger.log(`Left unread (${outcome.state}): ${outcome.detail}`);
    }
  } catch (executionError) {
    Logger.log("Exception caught while processing message: " + executionError.toString());
    logToTestSheet(messageId, null, "error", executionError.toString());
    // stays UNREAD
  }
}

/**
 * The RES- order number read straight out of the subject line. Deterministic:
 * no model call, nothing to hallucinate. Returns null when the subject has no
 * RES- number — the usual case for an unstructured client email. Optional
 * metadata only; never a processing gate.
 */
function orderNumberFromSubject(subject) {
  const match = String(subject || "").match(RES_ORDER_NUMBER);
  return match ? match[0] : null;
}

// --- PORTAL PAYLOAD ---
/**
 * Maps the extracted fields onto the portal's official intake field set.
 *
 * Required by the API: property_state, county, property_address, city,
 * search_type, turnaround, contact_first_name, contact_last_name,
 * contact_email, email_message_id, and the client's company name. Everything
 * else is optional and may be null.
 *
 * CLIENT IDENTITY. Gemini MUST NOT invent a client code — it has no way to know
 * that "Atlantic Closing & Escrow, LLC" is CL01, and a hallucinated code would
 * attach a real order to the wrong client's billing. So no client code is sent
 * at all: `company` carries the name the model read, and the PORTAL resolves it
 * against its clients table — the existing client when exactly one matches, a
 * new client when none does, a 422 (left unread) when the name is ambiguous.
 * Nothing here maps names to codes, and sender addresses are never used.
 *
 * email_message_id comes from Gmail — never from the model.
 */
function buildIntakePayload(x, message, messageId) {
  return {
    // required
    property_state:       x.propertyState || null,
    county:               x.county || null,
    property_address:     x.propertyAddress || null,
    city:                 x.city || null,
    search_type:          x.searchType || null,
    turnaround:           x.turnaround || null,
    contact_first_name:   x.contactFirstName || null,
    contact_last_name:    x.contactLastName || null,
    contact_email:        x.contactEmail || null,
    email_message_id:     messageId,
    company:              x.customer || null,   // the client, by name
    // optional
    zip:                  x.zip || null,
    parcel_apn:           x.parcelApn || null,
    client_file_number:   x.customerFile || null,
    buyer:                x.buyer || null,
    borrower:             x.borrower || null,
    seller:               x.seller || null,
    special_instructions: x.specialInstructions || null,
    order_number:         x.orderNumber || null,
    customer_link:        x.customerLink || null,
    email_subject:        message.getSubject(),
    source_email:         message.getFrom()
  };
}

/**
 * POSTs to the portal. Returns { state, detail } where state is one of
 * created | duplicate | rejected | unavailable — only the first two count as
 * success and allow the message to be marked read.
 *
 * The secret travels in a header and is never logged or written to the sheet.
 */
function postToPortal(payload) {
  const apiResponse = UrlFetchApp.fetch(prop('INTAKE_API_URL', true), {
    "method": "post",
    "contentType": "application/json",
    "headers": {
      "x-intake-secret": prop('EMAIL_INTAKE_API_SECRET', true)
    },
    "payload": JSON.stringify(payload),
    "muteHttpExceptions": true
  });

  const responseCode = apiResponse.getResponseCode();
  let body = {};
  try {
    body = JSON.parse(apiResponse.getContentText()) || {};
  } catch (parseError) {
    // Non-JSON error page (proxy, gateway); leave body empty.
  }

  // e.g. "RTS-10060 · client CL08 (created)" — how the portal resolved the client.
  if (responseCode === 201) {
    const client = body.clientCode ? ` · client ${body.clientCode}${body.clientMatch ? ` (${body.clientMatch})` : ""}` : "";
    return { state: 'created', detail: `${body.orderId || ""}${client}` };
  }
  if (responseCode === 200) return { state: 'duplicate', detail: body.orderId || "" };

  // 4xx means the payload is wrong: a retry sends the same bytes and fails the
  // same way, so it needs a human. 5xx is the portal's problem and the next run
  // retries safely, because email_message_id makes intake idempotent.
  const detail = `HTTP ${responseCode} ${body.error || ""}${body.field ? ` [${body.field}]` : ""}`;
  return { state: responseCode >= 500 ? 'unavailable' : 'rejected', detail: detail };
}

// --- VERTEX AI ---
/**
 * Interfaces with GCP Vertex AI API to parse unstructured text into JSON.
 * Authenticates automatically using the Apps Script OAuth token.
 *
 * Unchanged from the lead script apart from the schema in the prompt, which now
 * asks for the portal's official intake fields instead of the six spreadsheet
 * columns. Model, region, temperature, responseMimeType, the markdown
 * sanitizer and the error handling are all as written by the project lead.
 *
 * Attachments are NOT handled: the model sees the subject and the two bodies
 * only. Sending PDFs to Gemini and moving them onto the order is an open item.
 *
 * @param {string} emailText - The combined subject and bodies of the email.
 * @returns {object|null} - Parsed JSON object containing extracted fields, or null on failure.
 */
function extractEntitiesViaVertexAI(emailText) {
  // Construct the Vertex AI endpoint URL
  const vertexEndpoint = `https://${GCP_REGION}-aiplatform.googleapis.com/v1/projects/${GCP_PROJECT_ID}/locations/${GCP_REGION}/publishers/google/models/${VERTEX_AI_MODEL}:generateContent`;

  // Retrieve the native OAuth2 token bound to the script's execution environment
  const oauthToken = ScriptApp.getOAuthToken();

  const systemPrompt = `
    You are an intelligent data extraction assistant.
    Analyze the provided email content and extract specific operational data.

    Return ONLY a valid, raw JSON object matching this schema. Do not include markdown code blocks (e.g., \`\`\`json).

    Schema:
    {
      "orderNumber": "Extract the order number that begins with 'RES-' (e.g., RES-2026-1937).",
      "customer": "The client company placing the order, exactly as written (e.g., Atlantic Closing & Escrow, LLC or Premier Title) — the title, escrow, lending or law firm, NOT the buyer, seller or borrower. '' if not stated.",
      "customerFile": "Extract the customer file identifier (e.g., ACE-26-13155 or 2026-PTMD-1922).",
      "customerLink": "Extract the primary URL to view the request, message, or customer file. Look for full http/https links.",
      "propertyAddress": "Extract the STREET LINE ONLY of the property (e.g., 880 Main St). Do not include city, state or ZIP. If no address is found, return ''.",
      "city": "Extract the city of the property, or '' if not stated.",
      "propertyState": "Extract the two-letter US state code of the property (e.g., TX, FL), or '' if not stated.",
      "county": "Extract the county of the property, without the word 'County', or '' if not stated.",
      "zip": "Extract the property ZIP code, or ''.",
      "parcelApn": "Extract the parcel number / Assessor's Parcel Number (APN), or ''.",
      "searchType": "The search product requested. MUST be exactly one of: ${SEARCH_TYPES.join(" | ")}. If the request does not clearly match one of those, return ''.",
      "turnaround": "MUST be exactly one of: ${TURNAROUNDS.join(" | ")}. Use '${TURNAROUNDS[1]}' only if the email actually asks for rush, urgent or 24-hour service; otherwise use '${TURNAROUNDS[0]}'.",
      "contactFirstName": "First name of the person requesting the order, or ''.",
      "contactLastName": "Last name of the person requesting the order, or ''.",
      "contactEmail": "Reply-to email address of the requester, or ''.",
      "buyer": "Buyer / purchaser name, or ''.",
      "borrower": "Borrower or current owner name, or ''.",
      "seller": "Seller name, or ''.",
      "specialInstructions": "Any instruction, deadline or caveat the client states, or ''."
    }

    Rules:
    - Use '' for anything the email does not clearly state. Never infer, never guess, never fill a field from general knowledge.
    - Do NOT output a client code, customer id or account number of the form CL01. You cannot know it. Return the customer name as written in "customer" and nothing more.
    - Return only the keys listed in the schema.

    Email Content to Analyze:
    ---
    ${emailText}
    ---
  `;

  const requestPayload = {
    "contents": [{
      "role": "user",
      "parts": [{
        "text": systemPrompt
      }]
    }],
    "generationConfig": {
      "temperature": 0.1, // Low temperature for deterministic extraction
      "responseMimeType": "application/json" // Enforces JSON output format
    }
  };

  const fetchOptions = {
    "method": "post",
    "contentType": "application/json",
    "headers": {
      "Authorization": `Bearer ${oauthToken}`
    },
    "payload": JSON.stringify(requestPayload),
    "muteHttpExceptions": true
  };

  try {
    const apiResponse = UrlFetchApp.fetch(vertexEndpoint, fetchOptions);
    const responseCode = apiResponse.getResponseCode();
    const responseBody = apiResponse.getContentText();

    if (responseCode !== 200) {
      Logger.log(`Vertex AI Error HTTP ${responseCode}: ${responseBody}`);
      return null;
    }

    const parsedResponse = JSON.parse(responseBody);

    if (parsedResponse.candidates && parsedResponse.candidates.length > 0) {
      const generatedText = parsedResponse.candidates[0].content.parts[0].text;

      // Sanitize the output (removes markdown formatting if model ignored responseMimeType)
      const sanitizedJsonString = generatedText.replace(/```json/gi, "").replace(/```/g, "").trim();
      return JSON.parse(sanitizedJsonString);
    } else {
      Logger.log("Error: Empty or invalid response structure from Vertex AI API.");
    }
  } catch (executionError) {
    Logger.log("Exception caught during Vertex AI API call: " + executionError.toString());
  }

  return null;
}

// --- OPTIONAL TEST LOG (NOT production logic) ---
/**
 * One row per Gmail message in the tracking spreadsheet, when SPREADSHEET_ID is
 * set. The lead script's original columns all survive; Gmail Message ID and
 * Client Email are added, and the outcome is one "API Result / Detail" column.
 *
 * Deduplicated on the Gmail message id. A message can be logged more than once
 * — an API failure on one run, a success on the next, or simply a re-run of the
 * trigger — and a second row is never appended for it. The existing row is
 * updated in place instead, so the sheet stays one line per email AND still
 * shows the latest outcome rather than a stale first attempt.
 *
 * This is the SHEET's own duplicate protection and is entirely separate from
 * the API's, which is a unique index in Postgres. Neither affects the other:
 * order creation is decided by the portal, never by anything read from here.
 *
 * Purely observational: set SPREADSHEET_ID to "" and the flow is unchanged.
 * Wrapped so a Sheets failure can never affect whether an order was posted or a
 * message was marked read.
 *
 * Deliberately not logged: the API secret, the OAuth token, and the request
 * headers.
 */
function logToTestSheet(messageId, extracted, state, detail) {
  if (!SPREADSHEET_ID) return;
  try {
    const targetSheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(TARGET_SHEET_NAME);
    if (!targetSheet) return;

    const x = extracted || {};
    const row = [
      new Date(), // Processing Timestamp
      messageId || "",
      x.orderNumber || "",
      x.customer || "",
      // The CLIENT's work email as extracted from the email content. Never
      // message.getFrom(): a forwarded order carries the forwarder's address
      // (Ashly's, for the Fwd: messages), not the client contact's.
      x.contactEmail || "",
      x.customerFile || "",
      x.customerLink || "Link not found",
      x.propertyAddress || "N/A",
      `${state || ""}${detail ? ` — ${detail}` : ""}`
    ];

    if (targetSheet.getLastRow() === 0) targetSheet.appendRow(SHEET_HEADERS);

    const existingRow = findRowByMessageId(targetSheet, messageId);
    if (existingRow) {
      targetSheet.getRange(existingRow, 1, 1, row.length).setValues([row]);
      return;
    }

    targetSheet.appendRow(row);
  } catch (loggingError) {
    Logger.log("Info: test log unavailable: " + loggingError.toString());
  }
}

/**
 * 1-based index of the row already logged for this Gmail message, or 0 when the
 * message has not been logged yet.
 */
function findRowByMessageId(targetSheet, messageId) {
  if (!messageId) return 0;
  const lastRow = targetSheet.getLastRow();
  if (lastRow < 1) return 0;
  const ids = targetSheet.getRange(1, MESSAGE_ID_COLUMN, lastRow, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(messageId)) return i + 1;
  }
  return 0;
}

/**
 * Programmatically creates a time-driven trigger for the main function.
 * Run this function ONCE manually from the editor to set up the automation.
 */
function createTimeDrivenTrigger() {
  const functionName = 'processResoluteEmailsWithVertexAI';

  // 1. Check if the trigger already exists to avoid duplicates
  const triggers = ScriptApp.getProjectTriggers();
  for (let i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === functionName) {
      Logger.log(`A trigger for ${functionName} already exists. Skipping creation.`);
      return; // Exit if it exists
    }
  }

  // 2. Create the trigger to run every 5 minutes
  ScriptApp.newTrigger(functionName)
      .timeBased()
      .everyMinutes(5)
      .create();

  Logger.log(`Successfully created a 5-minute trigger for ${functionName}.`);
}

/**
 * AI-Powered Email Extraction Workflow for Resolute using GCP Vertex AI
 *
 * REFERENCE COPY. Not deployed from this repository and never executed by the
 * portal — it lives here so the contract the Google project must satisfy sits
 * next to the API that depends on it.
 *
 * Reconciled from the project-lead script. Gmail and Vertex behaviour is theirs
 * and unchanged: the `label:resolute is:unread` queue, the RES- subject filter,
 * both the plain and HTML bodies sent to the model (HTML is what makes
 * customerLink extractable), the OAuth-token Vertex call, and the 5-minute
 * time-driven trigger.
 *
 * What is added is the portal connection:
 *
 *   Gmail → Vertex AI → CLIENT_CODE_MAP → [optional Sheet test log]
 *         → POST /api/orders/email-intake → order parked with Admin
 *
 * Two behaviours changed deliberately, and only these:
 *
 *  1. markRead() now happens ONLY after the API confirms the order (201) or
 *     confirms it already had it (200 duplicate). The lead script marked every
 *     message read even when extraction failed, which silently dropped it.
 *     Unread mail is the work queue, so every failure now stays unread.
 *  2. The Spreadsheet is optional and observational. It is opened lazily inside
 *     a try/catch and a logging failure cannot affect whether an order was
 *     posted or a message was marked read. Set SPREADSHEET_ID to "" to disable.
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
// For production (service account): You can change this to 'is:unread subject:"RES-"' or similar.
const GMAIL_SEARCH_QUERY = 'label:resolute is:unread';

// Ashly's forwards start with "Fwd:" but still contain "RES-", so the subject
// filter — not an AI judgement call — is what decides this is a Resolute order.
const SUBJECT_MUST_CONTAIN = "RES-";

// The RES- order number as it appears in the subject, e.g. RES-2026-1937.
// Read deterministically rather than trusted from the model: the filter above
// guarantees it is in the subject, and a regex cannot hallucinate one.
const RES_ORDER_NUMBER = /RES-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*/;

// --- OPTIONAL TEST LOG (testing only, never production logic) ---
// Set to "" to disable. Nothing is ever read back out of this sheet.
const SPREADSHEET_ID = "1bAT4nKzk1cIqND2sFtTaghEdEct-fxnYMY09HzWaUGw";
const TARGET_SHEET_NAME = "Sheet1";

// --- PORTAL CONNECTION (script properties, so nothing sensitive is in code) ---
// File → Project properties → Script properties:
//   INTAKE_API_URL           https://…/api/orders/email-intake
//   EMAIL_INTAKE_API_SECRET  must match the portal's env var. Never logged.
//   CLIENT_CODE_MAP          JSON, customer name → clients.code (see below)
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

      const subject = message.getSubject();

      // Skip emails that don't look like Resolute emails, even if they are in
      // the label. This filter replaces any AI "is this an order?" judgement.
      if (!subject.includes(SUBJECT_MUST_CONTAIN)) {
        Logger.log(`Skipping non-Resolute email in label: ${subject}`);
        continue;
      }

      processResoluteMessage(message, subject);
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
      logToTestSheet(null, "extraction-failed", "");
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

    const clientCode = clientCodeFor(extractedJsonData.customer);
    if (!clientCode) {
      // Do not call the API at all: there is nothing to attach the order to.
      Logger.log(`Warning: no CLIENT_CODE_MAP entry for customer "${extractedJsonData.customer}" — not posted.`);
      logToTestSheet(extractedJsonData, "unmapped-customer", "");
      return;                                    // stays UNREAD
    }

    payload = buildIntakePayload(extractedJsonData, message, messageId, clientCode);
    const outcome = postToPortal(payload);
    logToTestSheet(extractedJsonData, outcome.state, outcome.detail);

    // The one and only place mail is marked read.
    if (outcome.state === 'created' || outcome.state === 'duplicate') {
      message.markRead();
      Logger.log(`Success: ${outcome.state} ${outcome.detail} for order ${extractedJsonData.orderNumber || "(no RES- number read)"}`);
    } else {
      Logger.log(`Left unread (${outcome.state}): ${outcome.detail}`);
    }
  } catch (executionError) {
    Logger.log("Exception caught while processing message: " + executionError.toString());
    logToTestSheet(null, "error", executionError.toString());
    // stays UNREAD
  }
}

/**
 * The RES- order number read straight out of the subject line. Deterministic:
 * no model call, nothing to hallucinate. Returns null when the subject carries
 * the "RES-" marker but no readable number after it.
 */
function orderNumberFromSubject(subject) {
  const match = String(subject || "").match(RES_ORDER_NUMBER);
  return match ? match[0] : null;
}

// --- CLIENT IDENTITY ---
/**
 * Gemini MUST NOT invent a client code. It has no way to know that "Atlantic
 * Closing & Escrow, LLC" is CL01, and a hallucinated code would attach a real
 * order to the wrong client's billing. So the model returns the customer name
 * it read, and the mapping to clients.code happens here, from an explicit table
 * an operator maintains as a script property:
 *
 *   CLIENT_CODE_MAP = {"Atlantic Closing & Escrow, LLC":"CL01","Premier Title":"CL02"}
 *
 * An unmapped customer is NOT posted and its email is left unread, so it shows
 * up as unhandled mail for a human to map. Guessing is never the fallback.
 */
function clientCodeFor(customer) {
  const map = JSON.parse(prop('CLIENT_CODE_MAP', true));
  const wanted = String(customer || "").trim().toLowerCase();
  if (!wanted) return null;
  const names = Object.keys(map);
  for (let i = 0; i < names.length; i++) {
    if (names[i].trim().toLowerCase() === wanted) return map[names[i]];
  }
  return null;
}

// --- PORTAL PAYLOAD ---
/**
 * Maps the extracted fields onto the portal's official intake field set.
 *
 * Required by the API: property_state, county, property_address, city,
 * search_type, turnaround, contact_first_name, contact_last_name,
 * contact_email, client_identifier, email_message_id. Everything else is
 * optional and may be null.
 *
 * client_identifier comes from CLIENT_CODE_MAP and email_message_id from
 * Gmail — never from the model.
 */
function buildIntakePayload(x, message, messageId, clientCode) {
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
    client_identifier:    clientCode,
    email_message_id:     messageId,
    // optional
    zip:                  x.zip || null,
    parcel_apn:           x.parcelApn || null,
    client_file_number:   x.customerFile || null,
    buyer:                x.buyer || null,
    borrower:             x.borrower || null,
    seller:               x.seller || null,
    special_instructions: x.specialInstructions || null,
    company:              x.customer || null,
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

  if (responseCode === 201) return { state: 'created', detail: body.orderId || "" };
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
      "customer": "Extract the customer name (e.g., Atlantic Closing & Escrow, LLC or Premier Title).",
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
 * Appends one row per message to the tracking spreadsheet when SPREADSHEET_ID
 * is set. The lead script's six columns are preserved and in the same order;
 * the outcome columns are appended to the right so an existing sheet keeps
 * working.
 *
 * Purely observational: set SPREADSHEET_ID to "" and the flow is unchanged.
 * Wrapped so a Sheets failure can never affect whether an order was posted or a
 * message was marked read.
 *
 * Deliberately not logged: the API secret, the OAuth token, and the payload's
 * headers.
 */
function logToTestSheet(extracted, state, detail) {
  if (!SPREADSHEET_ID) return;
  try {
    const targetSheet = SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(TARGET_SHEET_NAME);
    if (!targetSheet) return;
    const x = extracted || {};
    targetSheet.appendRow([
      new Date(), // Processing Timestamp
      x.orderNumber || "",
      x.customer || "",
      x.customerFile || "",
      x.customerLink || "Link not found",
      x.propertyAddress || "N/A",
      state || "",
      detail || ""
    ]);
  } catch (loggingError) {
    Logger.log("Info: test log unavailable: " + loggingError.toString());
  }
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

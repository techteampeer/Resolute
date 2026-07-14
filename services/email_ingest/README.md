# Email → Order ingest

Reads a dedicated orders inbox over IMAP, extracts the requested title-search
order from each email (body/subject + PDF attachments) with an LLM, and creates
the order automatically — reusing the same order-creation and document-attach
paths the portal uses. Low-confidence or unmatched mail goes to a review queue
instead of becoming an order (wrong title orders are costly).

## Flow (per message)
1. Fetch UNSEEN messages (`mailbox.js`, imapflow + mailparser).
2. Match sender email → `clients` row (`clients.js`). No match ⇒ review queue.
3. Extract strict JSON via the LLM provider (`providers/`), passing the real
   service catalog so `service_type` can only be a portal value.
4. **Create** the order (`api/_lib/ordersRepo.createInboundOrder`) + attach PDFs
   to the `documents` bucket **only if** client matched *and* service mapped
   *and* `confidence ≥ CONFIDENCE_THRESHOLD` *and* not `needs_review`.
   Otherwise → `email_review_queue` with the parsed result + attachments.
5. Every Message-ID is recorded in `email_ingest_log` (idempotency: re-runs and
   provider retries skip anything already handled).

Migration: `supabase/migrations/20260625000000_email_ingest.sql` (idempotent).

## Run
```bash
npm run email:ingest:once     # one-shot (manual / cron)
npm run email:ingest          # loop every POLL_INTERVAL_SEC
npm test                      # unit tests (mocked LLM — no network)
```
Each message logs `created | queued | skipped` + reason.

## Switching the LLM provider
Set `LLM_PROVIDER` in the environment:
- `gemini` (default) — Google Gemini (`GEMINI_API_KEY`, `GEMINI_MODEL`,
  default `gemini-2.5-flash`). PDFs sent as native document input; JSON mode.
- `local` — any OpenAI-compatible endpoint (`LOCAL_LLM_BASE_URL`,
  `LOCAL_LLM_MODEL`, e.g. Ollama). PDFs are converted to text (embedded text
  layer + `tesseract` OCR fallback) before sending.

Both return the identical validated schema
(`service_type, property_address, parcel_or_apn, client_reference,
requested_turnaround, notes, confidence, needs_review, review_reason`).
See `.env.example` for every setting.

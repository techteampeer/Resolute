# Runtime service accounts, least-privilege. The API SA may reach Cloud SQL,
# read its secrets and use the documents bucket. The web SA just serves static
# files and gets no data access at all.
resource "google_service_account" "run_api" {
  account_id   = "resolute-run-api"
  display_name = "Resolute Cloud Run — API"
}

resource "google_service_account" "run_web" {
  account_id   = "resolute-run-web"
  display_name = "Resolute Cloud Run — web"
}

# Cloud SQL access (connects via the Cloud SQL connector, not a public IP).
resource "google_project_iam_member" "api_cloudsql_client" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.run_api.email}"
}

# Read the DB password secret.
resource "google_secret_manager_secret_iam_member" "api_db_password" {
  secret_id = google_secret_manager_secret.db_app_password.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.run_api.email}"
}

# Read the placeholder secrets (Firebase admin, intake secret, SES) as each is populated.
resource "google_secret_manager_secret_iam_member" "api_placeholders" {
  for_each  = google_secret_manager_secret.placeholders
  secret_id = each.value.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.run_api.email}"
}

# Read/write documents in the bucket. Object-level only — not bucket admin —
# so the API can sign/read/write objects but not reconfigure the bucket.
resource "google_storage_bucket_iam_member" "api_documents" {
  bucket = google_storage_bucket.documents.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.run_api.email}"
}

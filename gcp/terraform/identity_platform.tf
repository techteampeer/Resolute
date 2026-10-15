# Identity Platform is Firebase Auth's backend. This enables email/password
# sign-in, which is what the portal uses. The Firebase *project* linkage and the
# client web-app config (API key, auth domain) are done once in the Firebase
# console in B3 — Terraform manages the auth behaviour, not the console app.
#
# NOTE: initializing Identity Platform on a project is a one-time action that may
# need to be enabled in the console first; if apply errors that Identity Platform
# is not initialized, enable it once at
# https://console.cloud.google.com/customer-identity then re-apply.
resource "google_identity_platform_config" "auth" {
  provider = google-beta
  project  = var.project_id

  sign_in {
    allow_duplicate_emails = false

    email {
      enabled           = true
      password_required = true
    }
  }

  depends_on = [google_project_service.enabled]
}

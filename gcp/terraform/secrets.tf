# Secret CONTAINERS. Values are added out-of-band (gcloud / console) and never
# live in Terraform state or git — except the DB password, which is generated in
# cloudsql.tf and stored here so the API can read it at runtime from Secret
# Manager rather than from an env var baked into the image.
locals {
  placeholder_secrets = [
    "firebase-service-account", # Firebase Admin SDK JSON (B3)
    "email-intake-secret",      # x-intake-secret shared secret
    "ses-credentials",          # outbound mail creds (B6)
  ]
}

resource "google_secret_manager_secret" "db_app_password" {
  secret_id = "db-app-password"
  labels    = var.labels

  replication {
    auto {}
  }

  depends_on = [google_project_service.enabled]
}

resource "google_secret_manager_secret_version" "db_app_password" {
  secret      = google_secret_manager_secret.db_app_password.id
  secret_data = random_password.db_app.result
}

resource "google_secret_manager_secret" "placeholders" {
  for_each  = toset(local.placeholder_secrets)
  secret_id = each.value
  labels    = var.labels

  replication {
    auto {}
  }

  depends_on = [google_project_service.enabled]
}

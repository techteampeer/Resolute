output "db_instance_connection_name" {
  description = "PROJECT:REGION:INSTANCE — used by the Cloud SQL connector from the API."
  value       = google_sql_database_instance.main.connection_name
}

output "db_private_ip" {
  description = "Cloud SQL private IP (reachable only inside the VPC)."
  value       = google_sql_database_instance.main.private_ip_address
}

output "db_name" {
  value = google_sql_database.app.name
}

output "db_app_user" {
  value = google_sql_user.app.name
}

output "documents_bucket" {
  value = google_storage_bucket.documents.name
}

output "artifact_registry_repo" {
  description = "Docker repo path to tag/push images to."
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.containers.repository_id}"
}

output "run_api_service_account" {
  value = google_service_account.run_api.email
}

output "run_web_service_account" {
  value = google_service_account.run_web.email
}

output "api_url" {
  value = google_cloud_run_v2_service.api.uri
}

output "web_url" {
  value = google_cloud_run_v2_service.web.uri
}

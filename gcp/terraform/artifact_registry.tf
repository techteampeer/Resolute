# Docker repository for the Cloud Run images (web + api). CI builds and pushes
# here; Cloud Run pulls from here.
resource "google_artifact_registry_repository" "containers" {
  location      = var.region
  repository_id = "resolute"
  format        = "DOCKER"
  description   = "Container images for the Resolute Cloud Run services."
  labels        = var.labels

  depends_on = [google_project_service.enabled]
}

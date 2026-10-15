# Documents bucket (check scans, uploaded files). Private and uniform-access:
# the nine storage RLS policies Supabase enforced do NOT carry over — Cloud
# Storage never consults Postgres — so access is enforced in the API at
# signed-URL minting (phase B5). public_access_prevention makes an accidental
# public object impossible regardless of object ACLs.
resource "google_storage_bucket" "documents" {
  name                        = "${var.project_id}-documents"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  labels                      = var.labels

  versioning {
    enabled = true
  }

  depends_on = [google_project_service.enabled]
}

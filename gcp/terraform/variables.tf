variable "project_id" {
  description = "GCP project ID (e.g. resolute-509617)."
  type        = string
}

variable "region" {
  description = "Primary region for Cloud Run, Cloud SQL and the VPC connector."
  type        = string
  default     = "us-central1"
}

variable "db_tier" {
  description = "Cloud SQL machine tier. db-custom-1-3840 = 1 vCPU / 3.75 GB — a reasonable staging floor; raise for prod."
  type        = string
  default     = "db-custom-1-3840"
}

variable "db_version" {
  description = "Cloud SQL Postgres version. Matches what the gcp/ migrations were proven against."
  type        = string
  default     = "POSTGRES_17"
}

variable "db_name" {
  description = "Application database name."
  type        = string
  default     = "resolute"
}

variable "db_app_user" {
  description = "Non-superuser application role the API connects as. NEVER the built-in postgres user (Postgres skips RLS for superusers)."
  type        = string
  default     = "resolute_app"
}

variable "db_deletion_protection" {
  description = "Guard against an accidental terraform destroy of the database. Keep true outside throwaway experiments."
  type        = bool
  default     = true
}

variable "labels" {
  description = "Common resource labels."
  type        = map(string)
  default = {
    app        = "resolute-portal"
    managed_by = "terraform"
    workstream = "gcp-migration"
  }
}

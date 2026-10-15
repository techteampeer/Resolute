resource "random_password" "db_app" {
  length  = 32
  special = false
}

resource "google_sql_database_instance" "main" {
  name             = "resolute-db-instance"
  database_version = var.db_version
  region           = var.region

  # The private IP needs the Private Services Access peering in place first.
  depends_on = [google_service_networking_connection.psa]

  settings {
    tier              = var.db_tier
    availability_type = "ZONAL" # staging; REGIONAL for prod HA
    disk_autoresize   = true
    disk_size         = 10
    disk_type         = "PD_SSD"
    user_labels       = var.labels

    ip_configuration {
      ipv4_enabled    = false # no public IP
      private_network = google_compute_network.vpc.id
    }

    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
    }
  }

  deletion_protection = var.db_deletion_protection
}

resource "google_sql_database" "app" {
  name     = var.db_name
  instance = google_sql_database_instance.main.name
}

# The non-superuser application login. gcp/01_bootstrap.sql then creates the
# anon/authenticated/service_role roles and the auth.uid() shim the RLS policies
# call, and GRANTs this login into them. NEVER connect the app as the built-in
# `postgres` user — Postgres skips RLS entirely for superusers, the silent
# failure mode measured in gcp/README.
resource "google_sql_user" "app" {
  name     = var.db_app_user
  instance = google_sql_database_instance.main.name
  password = random_password.db_app.result
}

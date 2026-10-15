# Cloud Run services. CI builds and pushes the real images to Artifact Registry;
# Terraform owns the service CONFIG and starts each with a placeholder image,
# ignoring later image changes so a CI deploy never drifts Terraform state.
resource "google_cloud_run_v2_service" "web" {
  name                = "resolute-web"
  location            = var.region
  deletion_protection = false

  template {
    service_account = google_service_account.run_web.email

    containers {
      image = "us-docker.pkg.dev/cloudrun/container/hello" # placeholder until first CI deploy
      ports {
        container_port = 8080
      }
    }
  }

  lifecycle {
    ignore_changes = [template[0].containers[0].image]
  }

  depends_on = [google_project_service.enabled]
}

resource "google_cloud_run_v2_service" "api" {
  name                = "resolute-api"
  location            = var.region
  deletion_protection = false

  template {
    service_account = google_service_account.run_api.email

    # Into the VPC to reach Cloud SQL's private IP. PRIVATE_RANGES_ONLY keeps
    # public egress off the connector.
    vpc_access {
      connector = google_vpc_access_connector.connector.id
      egress    = "PRIVATE_RANGES_ONLY"
    }

    containers {
      image = "us-docker.pkg.dev/cloudrun/container/hello" # placeholder until first CI deploy
      ports {
        container_port = 8080
      }

      env {
        name  = "DB_INSTANCE_CONNECTION_NAME"
        value = google_sql_database_instance.main.connection_name
      }
      env {
        name  = "DB_NAME"
        value = var.db_name
      }
      env {
        name  = "DB_USER"
        value = var.db_app_user
      }
      env {
        name = "DB_PASSWORD"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.db_app_password.secret_id
            version = "latest"
          }
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [template[0].containers[0].image]
  }

  depends_on = [
    google_project_service.enabled,
    google_secret_manager_secret_version.db_app_password,
  ]
}

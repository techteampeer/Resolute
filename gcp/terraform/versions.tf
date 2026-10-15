terraform {
  required_version = ">= 1.5.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.8"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 6.8"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # Remote state lives in a GCS bucket (see README). Create the bucket once,
  # then uncomment and `terraform init -migrate-state`. Keeping state local is
  # fine for a first solo apply but not for a team.
  # backend "gcs" {
  #   bucket = "resolute-509617-tfstate"
  #   prefix = "gcp-migration"
  # }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

provider "google-beta" {
  project = var.project_id
  region  = var.region
}

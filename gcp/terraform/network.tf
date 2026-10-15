# A dedicated VPC so Cloud Run reaches Cloud SQL over PRIVATE IP — the database
# never gets a public address.
resource "google_compute_network" "vpc" {
  name                    = "resolute-vpc"
  auto_create_subnetworks = false
  depends_on              = [google_project_service.enabled]
}

# Private Services Access: the internal range Google's managed services (Cloud
# SQL) are allocated inside our VPC, plus the peering that wires it up.
resource "google_compute_global_address" "psa_range" {
  name          = "resolute-psa-range"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 16
  network       = google_compute_network.vpc.id
}

resource "google_service_networking_connection" "psa" {
  network                 = google_compute_network.vpc.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.psa_range.name]
  depends_on              = [google_project_service.enabled]
}

# A /28 subnet dedicated to the Serverless VPC Access connector, the path Cloud
# Run takes into the VPC to reach the private Cloud SQL IP.
resource "google_compute_subnetwork" "connector" {
  name          = "resolute-connector-subnet"
  ip_cidr_range = "10.8.0.0/28"
  region        = var.region
  network       = google_compute_network.vpc.id
}

resource "google_vpc_access_connector" "connector" {
  name   = "resolute-connector"
  region = var.region

  subnet {
    name = google_compute_subnetwork.connector.name
  }

  depends_on = [google_project_service.enabled]
}

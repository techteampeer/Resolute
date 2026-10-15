# GCP infrastructure (Terraform) — ADR 0002 phase B0

Provisions the GCP staging stack the portal migrates onto: a private Cloud SQL
Postgres, a VPC + connector, Cloud Run services (web + api), Cloud Storage,
Artifact Registry, Secret Manager and Identity Platform (Firebase Auth). It does
**not** touch the running app — `src/` still talks to Supabase until the GCP
provider is wired (B2+).

## Apply it — keyless, from Cloud Shell

Your org blocks downloadable service-account keys
(`iam.disableServiceAccountKeyCreation`), which is the secure default. So apply
as **yourself in Cloud Shell** — it is already authenticated, no key needed:

```bash
# in Cloud Shell, in this directory (clone the repo or open the editor)
cd gcp/terraform
cp terraform.tfvars.example terraform.tfvars   # edit if needed

terraform init
terraform plan      # review every resource before creating anything
terraform apply
```

Running in GitHub Actions under the existing Workload Identity Federation works
too — same commands, no key either way.

### Remote state (do this before a second person applies)

Local state is fine for the first solo apply. For a team, keep state in GCS:

```bash
gsutil mb -l us-central1 gs://resolute-509617-tfstate
gsutil versioning set on gs://resolute-509617-tfstate
```

Then uncomment the `backend "gcs"` block in `versions.tf` and
`terraform init -migrate-state`.

## Order of operations (full stand-up)

1. `terraform apply` here — creates the instance, VPC, bucket, SAs, etc.
2. Database bootstrap (the `gcp/` SQL, already proven):
   ```bash
   # connect through the Cloud SQL Auth Proxy as an admin user, then:
   ./gcp/bootstrap.sh                       # 01_bootstrap.sql + all migrations
   psql -f gcp/02_post_migrate.sql "$DB_NAME"
   ```
   `01_bootstrap.sql` creates the anon/authenticated/service_role roles, the
   `auth.uid()` shim and the `auth.users` map, and GRANTs the app login
   (`resolute_app`, created by Terraform) into them. **The app connects as that
   login, never as a superuser.**
3. Build + push the web and api images to the Artifact Registry repo (CI), which
   replaces the placeholder images on the Cloud Run services.

## What is still manual (by design)

- **Secret values.** Terraform creates the secret *containers* (and the DB
  password). Populate `firebase-service-account`, `email-intake-secret` and
  `ses-credentials` with `gcloud secrets versions add` or in the console.
- **Firebase console (B3).** Linking a Firebase app, the web API key / auth
  domain, and (optionally) the email action-link templates are console steps.
  Terraform manages the Identity Platform auth behaviour only.
- **Domain + TLS** for the Cloud Run services (B8 cutover).

## Safety notes baked in

- Cloud SQL has **no public IP**; Cloud Run reaches it over the VPC connector.
- The documents bucket enforces public-access-prevention; the dropped storage
  RLS policies are re-implemented in the API at signed-URL minting (B5).
- `deletion_protection` is on for the database — flip `db_deletion_protection`
  only for a throwaway experiment.

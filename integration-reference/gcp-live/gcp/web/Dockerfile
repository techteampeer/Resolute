# Staging web frontend for the GCP stack (VITE_BACKEND=gcp). A SEPARATE image
# from the repository-root Dockerfile, which keeps building the existing
# `resolute-portal` service exactly as before; this one is built only on
# purpose, for a staging Cloud Run service (docs/STAGING-DEPLOYMENT.md).
#
# Build from the repository root:
#   docker build -f gcp/web/Dockerfile \
#     --build-arg VITE_GCP_API_BASE_URL=https://<staging api>.run.app \
#     --build-arg VITE_FIREBASE_API_KEY=... --build-arg VITE_FIREBASE_AUTH_DOMAIN=... \
#     --build-arg VITE_FIREBASE_PROJECT_ID=... --build-arg VITE_FIREBASE_APP_ID=... \
#     --build-arg BUILD_COMMIT_SHA=$(git rev-parse HEAD) .
# The Firebase web config is public by design (it names a project; it grants
# nothing). No secret and no service-account key is ever a build argument.

# ── Build ────────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# The committed lockfile, installed exactly.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# Only what `vite build` reads -- never a local .env file or anything else in
# the working tree (copied by name, so no .dockerignore is needed).
COPY index.html vite.config.js postcss.config.js tailwind.config.js tsconfig.json ./
COPY public ./public
COPY packages ./packages
COPY src ./src
COPY scripts/check-gcp-build-env.mjs ./scripts/

ARG VITE_GCP_API_BASE_URL
ARG VITE_FIREBASE_API_KEY
ARG VITE_FIREBASE_AUTH_DOMAIN
ARG VITE_FIREBASE_PROJECT_ID
ARG VITE_FIREBASE_APP_ID
ARG BUILD_COMMIT_SHA
ENV VITE_BACKEND=gcp \
    VITE_GCP_API_ALLOW_REMOTE=true \
    VITE_GCP_API_BASE_URL=${VITE_GCP_API_BASE_URL} \
    VITE_FIREBASE_API_KEY=${VITE_FIREBASE_API_KEY} \
    VITE_FIREBASE_AUTH_DOMAIN=${VITE_FIREBASE_AUTH_DOMAIN} \
    VITE_FIREBASE_PROJECT_ID=${VITE_FIREBASE_PROJECT_ID} \
    VITE_FIREBASE_APP_ID=${VITE_FIREBASE_APP_ID} \
    BUILD_COMMIT_SHA=${BUILD_COMMIT_SHA}
# The app's own configuration rules, as a production build: a missing value, a
# non-https API or the Auth emulator stops the build here.
RUN node scripts/check-gcp-build-env.mjs && npx vite build

# ── Serve ────────────────────────────────────────────────────────────────────
# Static files only, as an unprivileged nginx on 8080 (Cloud Run's $PORT).
FROM nginxinc/nginx-unprivileged:stable-alpine
COPY gcp/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080

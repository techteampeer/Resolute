# Stage 1: build the Vite SPA
FROM node:20-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY . .
RUN npm run build

# Stage 2: the portal server — the SPA and the API it talks to, in one container
#
# This replaces an nginx image that served /dist and nothing else. That shape
# cannot work here: nginx does not run JavaScript, so there was nowhere to hold
# the Cloud SQL connection, verify a Firebase session, or sign a Cloud Storage
# URL. It also silently dropped api/admin/users.js — Admin's user management —
# because only /dist was copied, and the SPA fallback answered that endpoint
# with index.html, so the fetch failed while parsing HTML rather than 404ing.
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# Production dependencies only: the build tooling stays in the builder stage.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY server ./server

# Cloud Run sends SIGTERM and expects the process to exit promptly. Node as PID 1
# does not get a default SIGTERM handler, so without an init the container is
# killed after the grace period on every revision change.
RUN apk add --no-cache tini
ENTRYPOINT ["/sbin/tini", "--"]

EXPOSE 8080
ENV PORT=8080
CMD ["node", "server/index.js"]

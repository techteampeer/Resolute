# Cloud Run data-API service (ADR 0002, B2). Isolated from the frontend — its
# dependencies live in this service's own package.json, not the app's, so the
# Vercel build never sees pg / firebase-admin / express.
FROM node:20-alpine
WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src

ENV NODE_ENV=production
# Cloud Run routes traffic to $PORT (defaults to 8080).
EXPOSE 8080
CMD ["node", "src/index.js"]

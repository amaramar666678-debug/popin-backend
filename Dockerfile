# syntax=docker/dockerfile:1

# ---------------------------------------------------------------
# Stage 1 — install dependencies + generate the Prisma client
# ---------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

# Native modules (bcrypt) may need a compiler on Alpine; present only here so
# the runtime image stays minimal.
RUN apk add --no-cache python3 make g++

# Copy manifests first so dependency layers are cached unless they change.
COPY package.json package-lock.json* ./
RUN npm ci

# Prisma 7 reads prisma.config.ts to locate the schema/migrations.
COPY prisma ./prisma
COPY prisma.config.ts ./

# Required: without this the generated client (node_modules/.prisma) is missing
# and the app crashes on startup with "Cannot find module .prisma/client/default".
RUN npx prisma generate


# ---------------------------------------------------------------
# Stage 2 — slim runtime image
# ---------------------------------------------------------------
FROM node:22-alpine
WORKDIR /app

ENV NODE_ENV=production

# Full node_modules is copied (not pruned) so the Prisma CLI is available in the
# container — Render runs `npm run migrate:deploy` as preDeployCommand, and
# `npx prisma migrate deploy` needs the CLI at runtime.
COPY --from=build /app/node_modules ./node_modules

COPY package.json ./
COPY prisma ./prisma
COPY src ./src
# Firebase Admin service account (keep file permissions restricted in the repo)
COPY service-account.json ./service-account.json

# Writable uploads dir (multer) owned by the unprivileged user.
RUN mkdir -p uploads && chown -R node:node /app

USER node

# Render/Cloud Run inject PORT; server.js falls back to 3000 otherwise.
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT:-3000}/health || exit 1

CMD ["node", "src/server.js"]

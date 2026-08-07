```dockerfile
# syntax=docker/dockerfile:1

# ---------------------------------------------------------------
# Stage 1 — install dependencies + generate the Prisma client
# ---------------------------------------------------------------

FROM node:22-alpine AS build

WORKDIR /app

# Native modules (bcrypt) may need a compiler on Alpine.
# These tools are only present in the build stage.
RUN apk add --no-cache python3 make g++

# Copy manifests first so dependency layers are cached
# unless package files change.
COPY package.json package-lock.json* ./

RUN npm ci

# Prisma 7 reads prisma.config.ts to locate
# the schema and migrations.
COPY prisma ./prisma
COPY prisma.config.ts ./

# Generate Prisma Client.
RUN npx prisma generate


# ---------------------------------------------------------------
# Stage 2 — slim runtime image
# ---------------------------------------------------------------

FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production

# Keep full node_modules because Prisma CLI may be needed
# for database migrations.
COPY --from=build /app/node_modules ./node_modules

COPY package.json ./
COPY prisma ./prisma
COPY src ./src

# IMPORTANT:
# service-account.json is NOT copied into the Docker image.
# Render provides it as a Secret File at runtime.


# Writable uploads directory.
RUN mkdir -p uploads && chown -R node:node /app

USER node

# Render injects PORT.
# server.js falls back to 3000 locally.
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT:-3000}/health || exit 1

CMD ["node", "src/server.js"]
```

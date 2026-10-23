FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS base
WORKDIR /app
COPY package*.json ./
COPY apps/publisher/package.json ./apps/publisher/package.json
COPY apps/mirror/package.json ./apps/mirror/package.json
COPY packages/core/package.json ./packages/core/package.json
RUN mkdir -p /data /delivery && chown node:node /data /delivery
ENV NODE_ENV=production

FROM base AS publisher
RUN npm ci --omit=dev --ignore-scripts --workspace @webhaven/publisher
COPY apps/publisher ./apps/publisher
COPY packages/core ./packages/core
USER node
CMD ["node", "apps/publisher/src/main.js"]

FROM base AS mirror
RUN npm ci --omit=dev --ignore-scripts --workspace @webhaven/mirror
COPY apps/mirror ./apps/mirror
COPY packages/core ./packages/core
USER node
CMD ["node", "apps/mirror/src/main.js"]

# Compatibility names for existing build commands.
FROM publisher AS producer
FROM mirror AS consumer

FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS base
WORKDIR /app
COPY package*.json ./
COPY apps/producer/package.json ./apps/producer/package.json
COPY apps/consumer/package.json ./apps/consumer/package.json
COPY packages/core/package.json ./packages/core/package.json
RUN mkdir -p /data /delivery && chown node:node /data /delivery
ENV NODE_ENV=production

FROM base AS producer
RUN npm ci --omit=dev --ignore-scripts --workspace @webhaven/producer
COPY apps/producer ./apps/producer
COPY packages/core ./packages/core
USER node
CMD ["node", "apps/producer/src/main.js"]

FROM base AS consumer
RUN npm ci --omit=dev --ignore-scripts --workspace @webhaven/consumer
COPY apps/consumer ./apps/consumer
COPY packages/core ./packages/core
USER node
CMD ["node", "apps/consumer/src/main.js"]

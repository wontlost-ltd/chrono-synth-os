FROM node:24-alpine AS builder
RUN apk upgrade --no-cache
WORKDIR /app

# Install deps (workspace symlinks require packages/ to exist first)
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/kernel/package.json packages/kernel/
COPY packages/data-plane/package.json packages/data-plane/
COPY packages/design-tokens/package.json packages/design-tokens/
COPY packages/sync-engine/package.json packages/sync-engine/
COPY packages/kernel-testkit/package.json packages/kernel-testkit/
COPY packages/adapter-web/package.json packages/adapter-web/
COPY packages/adapter-tauri/package.json packages/adapter-tauri/
COPY packages/adapter-react-native/package.json packages/adapter-react-native/
COPY packages/tsconfig.base.json packages/
COPY tsconfig.src.json tsconfig.scripts.json ./
RUN npm ci

# Build workspace packages in dependency order
COPY packages/contracts/src packages/contracts/src
COPY packages/contracts/tsconfig.json packages/contracts/
RUN npx tsc -p packages/contracts/tsconfig.json

COPY packages/kernel/src packages/kernel/src
COPY packages/kernel/tsconfig.json packages/kernel/
RUN npx tsc -p packages/kernel/tsconfig.json

COPY packages/data-plane/src packages/data-plane/src
COPY packages/data-plane/tsconfig.json packages/data-plane/
RUN npx tsc -p packages/data-plane/tsconfig.json

COPY packages/design-tokens/src packages/design-tokens/src
COPY packages/design-tokens/tsconfig.json packages/design-tokens/
RUN npx tsc -p packages/design-tokens/tsconfig.json

# Runtime adapter packages (test-only at this layer, but required by tsc tests)
COPY packages/adapter-web/src packages/adapter-web/src
COPY packages/adapter-web/tsconfig.json packages/adapter-web/
RUN npx tsc -p packages/adapter-web/tsconfig.json

COPY packages/adapter-tauri/src packages/adapter-tauri/src
COPY packages/adapter-tauri/tsconfig.json packages/adapter-tauri/
RUN npx tsc -p packages/adapter-tauri/tsconfig.json

COPY packages/adapter-react-native/src packages/adapter-react-native/src
COPY packages/adapter-react-native/tsconfig.json packages/adapter-react-native/
RUN npx tsc -p packages/adapter-react-native/tsconfig.json

COPY src/ src/
COPY scripts/ scripts/
RUN npx tsc -p tsconfig.src.json

COPY packages/kernel-testkit/src packages/kernel-testkit/src
COPY packages/kernel-testkit/tsconfig.json packages/kernel-testkit/
RUN npx tsc -p packages/kernel-testkit/tsconfig.json

COPY packages/sync-engine/src packages/sync-engine/src
COPY packages/sync-engine/tsconfig.json packages/sync-engine/
RUN npx tsc -p packages/sync-engine/tsconfig.json && npx tsc -p tsconfig.scripts.json

FROM node:24-alpine
RUN apk upgrade --no-cache && addgroup -S chrono && adduser -S chrono -G chrono
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/kernel/package.json packages/kernel/
COPY packages/data-plane/package.json packages/data-plane/
COPY packages/design-tokens/package.json packages/design-tokens/
COPY packages/sync-engine/package.json packages/sync-engine/
RUN npm ci --omit=dev && npm cache clean --force && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
# Copy built package dists so workspace symlinks resolve at runtime
COPY --from=builder /app/packages/contracts/dist packages/contracts/dist
COPY --from=builder /app/packages/kernel/dist packages/kernel/dist
COPY --from=builder /app/packages/data-plane/dist packages/data-plane/dist
COPY --from=builder /app/packages/design-tokens/dist packages/design-tokens/dist
COPY --from=builder /app/packages/sync-engine/dist packages/sync-engine/dist
COPY --from=builder /app/dist/ dist/
RUN mkdir -p /app/data && chown -R chrono:chrono /app
VOLUME /app/data
USER chrono
ENV NODE_ENV=production
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
ENV CHRONO_DB_PATH=/app/data/chrono.db
CMD ["node", "dist/main.js"]

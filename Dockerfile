FROM node:24-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

FROM node:24-alpine
RUN addgroup -S chrono && adduser -S chrono -G chrono
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
COPY --from=builder /app/dist/ dist/
RUN mkdir -p /app/data && chown -R chrono:chrono /app
VOLUME /app/data
USER chrono
ENV NODE_ENV=production
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/healthz || exit 1
ENV CHRONO_DB_PATH=/app/data/chrono.db
CMD ["node", "dist/main.js"]

FROM node:26-alpine AS builder
RUN apk upgrade --no-cache
WORKDIR /app

# Copy @chrono/* local packages so file: deps resolve inside Docker
COPY packages/ packages/

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM nginxinc/nginx-unprivileged:1.31-alpine3.23
USER root
RUN apk upgrade --no-cache
RUN mkdir -p /app/scripts /usr/share/nginx/html \
  && chown -R 101:0 /app /usr/share/nginx/html /etc/nginx/conf.d \
  && chmod -R g=u /app /usr/share/nginx/html /etc/nginx/conf.d
COPY --from=builder --chown=101:0 /app/dist /usr/share/nginx/html
COPY --chown=101:0 nginx.conf /etc/nginx/conf.d/default.conf
COPY --chown=101:0 scripts/render-runtime-config.sh /app/scripts/render-runtime-config.sh
COPY --chown=101:0 docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/scripts/render-runtime-config.sh /app/docker-entrypoint.sh
USER 101
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/frontend-healthz || exit 1
ENTRYPOINT ["/app/docker-entrypoint.sh"]

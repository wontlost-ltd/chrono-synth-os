# ChronoSynth 企业前端（@chrono/web）镜像 —— monorepo 构建。
#
# 重要：build context 必须是 **monorepo 根**（chrono-synth-os/），不是 apps/web，
# 因为 @chrono/* 依赖是 workspace 包（packages/*），需在同一棵 node_modules 里解析。
#   podman build -f apps/web/Dockerfile -t <img> .
# （ADR-0049：web 已从独立仓融合进 apps/web，去除 vendoring。）

FROM node:26-alpine AS builder
RUN apk upgrade --no-cache
WORKDIR /app

# 先只拷 root + 所有 workspace 成员的 package.json + lockfile，装一次 workspace 依赖。
# 拷全部 workspace manifest（与 root `workspaces` 声明一致）让 npm ci 确定性安装，不依赖
# npm 对缺失 workspace 目录的容忍行为。packages/*/package.json 用通配整目录的 manifest，
# 但为保持依赖安装层缓存，源码在 npm ci 之后再拷。
COPY package.json package-lock.json ./
COPY packages/ packages/
COPY apps/web/package.json apps/web/package.json
COPY apps/desktop/package.json apps/desktop/package.json
COPY apps/companion-web/package.json apps/companion-web/package.json
RUN npm ci

# web 的 @chrono/* 依赖解析到 packages/*/dist，需先构建这些内部包（web devDeps：contracts/
# design-tokens/sync-engine/kernel-testkit；依赖图闭合，sync-engine/kernel-testkit 引用 contracts）。
# packages/ 源码已随上面 COPY 带入；tsconfig.json 是根项目引用图入口。
COPY tsconfig.json ./
RUN npx tsc -b packages/contracts packages/design-tokens packages/sync-engine packages/kernel-testkit

# 再拷 web 源码并构建（vite → apps/web/dist）。
COPY apps/web/ apps/web/
RUN npm run --workspace @chrono/web build

FROM nginxinc/nginx-unprivileged:1.31-alpine3.23
USER root
RUN apk upgrade --no-cache
RUN mkdir -p /app/scripts /usr/share/nginx/html \
  && chown -R 101:0 /app /usr/share/nginx/html /etc/nginx/conf.d \
  && chmod -R g=u /app /usr/share/nginx/html /etc/nginx/conf.d
COPY --from=builder --chown=101:0 /app/apps/web/dist /usr/share/nginx/html
COPY --chown=101:0 apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --chown=101:0 apps/web/scripts/render-runtime-config.sh /app/scripts/render-runtime-config.sh
COPY --chown=101:0 apps/web/docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/scripts/render-runtime-config.sh /app/docker-entrypoint.sh
USER 101
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/frontend-healthz || exit 1
ENTRYPOINT ["/app/docker-entrypoint.sh"]

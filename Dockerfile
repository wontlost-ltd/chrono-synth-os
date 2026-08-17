FROM node:26-alpine AS builder
RUN apk upgrade --no-cache
WORKDIR /app

# Install deps (workspace symlinks require packages/ to exist first)
#
# --ignore-scripts：builder 阶段只跑 `npx tsc` 编译 workspace 包，不需要任何
# 原生模块的安装脚本。而 npm ci 会对含 binding.gyp 的包推导出隐式 gyp 构建
# （即便该包已自带预编译产物、且 gypfile:false），在无 Python 的 alpine 镜像
# 里直接失败。典型例子：better-sqlite3——它只是 packages/schema-dsl 的
# devDependency，却因裸 npm ci 被拉进镜像构建。
#
# 注意不能改用 --omit=dev：本阶段需要 devDependency 里的 typescript 编译
# 10 个 workspace 包，省掉 devDeps 会让后续所有 `npx tsc` 失败。
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
COPY packages/schema-dsl/package.json packages/schema-dsl/
COPY packages/tsconfig.base.json packages/
COPY tsconfig.src.json tsconfig.scripts.json ./
RUN npm ci --ignore-scripts

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

# @wontlost-ltd/schema-dsl 是 src/storage/dsl-migrations-runner.ts 的依赖；
# Dockerfile 要在 RUN tsc -p tsconfig.src.json 之前把它的 dist/ 准备好。
# tsconfig.json 的 include 同时引用 index.ts + src/**/*.ts，两者都得 COPY。
COPY packages/schema-dsl/index.ts packages/schema-dsl/
COPY packages/schema-dsl/src packages/schema-dsl/src
COPY packages/schema-dsl/tsconfig.json packages/schema-dsl/
RUN npx tsc -p packages/schema-dsl/tsconfig.json

COPY src/ src/
COPY scripts/ scripts/
RUN npx tsc -p tsconfig.src.json

COPY packages/kernel-testkit/src packages/kernel-testkit/src
COPY packages/kernel-testkit/tsconfig.json packages/kernel-testkit/
RUN npx tsc -p packages/kernel-testkit/tsconfig.json

COPY packages/sync-engine/src packages/sync-engine/src
COPY packages/sync-engine/tsconfig.json packages/sync-engine/
RUN npx tsc -p packages/sync-engine/tsconfig.json && npx tsc -p tsconfig.scripts.json

FROM node:26-alpine
# Fixed uid 1001 for chrono user — lets bind-mounted secrets on the host
# match a predictable uid for non-root deployments (e.g. setup-nas-beta.sh
# chowns jwt-keys/ to uid 1001 so backend can read PEM as non-root).
RUN apk upgrade --no-cache && addgroup -S -g 1001 chrono && adduser -S -u 1001 -G chrono chrono
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/kernel/package.json packages/kernel/
COPY packages/data-plane/package.json packages/data-plane/
COPY packages/design-tokens/package.json packages/design-tokens/
COPY packages/sync-engine/package.json packages/sync-engine/
# schema-dsl 是 src/storage/dsl-migrations-runner.ts 的运行时依赖；缺它
# 容器一启动就 ERR_MODULE_NOT_FOUND 然后崩。npm ci 需要 package.json
# 才会建工作区软链。
COPY packages/schema-dsl/package.json packages/schema-dsl/
# --ignore-scripts 同上：运行时阶段全部依赖为纯 JS，无需安装脚本产出产物
# （唯一带 postinstall 的生产依赖 protobufjs 只打印版本方案告警，不生成文件）。
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
# Copy built package dists so workspace symlinks resolve at runtime
COPY --from=builder /app/packages/contracts/dist packages/contracts/dist
COPY --from=builder /app/packages/kernel/dist packages/kernel/dist
COPY --from=builder /app/packages/data-plane/dist packages/data-plane/dist
COPY --from=builder /app/packages/design-tokens/dist packages/design-tokens/dist
COPY --from=builder /app/packages/sync-engine/dist packages/sync-engine/dist
COPY --from=builder /app/packages/schema-dsl/dist packages/schema-dsl/dist
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

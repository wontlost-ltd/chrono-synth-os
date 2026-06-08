# ChronoSynth Web

The web console for **ChronoSynth (Enterprise)** — agent governance for
enterprise AI.

This is what your AI lead, compliance officer, and CISO log into when they
want to answer: *which tools did our agents call, on whose authority, and
did anything drift from the policy?* The console renders the audit log,
tool-permission matrix, and drift reports backed by `chrono-synth-os`.

> 🧭 This repo is **the enterprise host**. The consumer-facing
> ChronoCompanion product lives in `chrono-synth-os/apps/companion-web/`
> with a different brand, routing, and pricing model. See
> [ADR-0046](../chrono-synth-os/docs/adr/0046-dual-product-companion.md).
>
> Detailed product narrative: see `chrono-synth-os/.claude/gtm/01-pr-faq.md`.

The same console also surfaces operator views (persona core, knowledge
sources, marketplace, billing) for organizations using ChronoSynth's full
platform — those features ride on the same governance substrate.

## Production Baseline

- 运行时配置注入，不再要求每个环境重新构建前端镜像
- 非 root Nginx 运行模式
- CI 中执行类型检查、构建、单测、运行时配置验证、Lighthouse CI
- Docker 镜像构建与 Trivy 漏洞扫描
- 离线优先同步引擎（IndexedDB 副本、断线重连队列）
- 全浏览器矩阵测试：Chromium、Firefox、WebKit、Pixel 5
- 明确的生产发布说明，见 [docs/production-readiness.md](docs/production-readiness.md)

## Quick Start

```bash
npm ci
npm run typecheck
npm run build
npm run test
npm run test:ops
```

## 脚本命令

| 命令 | 说明 |
|------|------|
| `npm run dev` | 启动开发服务器（Vite，端口 5173） |
| `npm run build` | TypeScript 编译 + Vite 打包 |
| `npm run preview` | 预览构建产物（端口 4173） |
| `npm run typecheck` | 类型检查（不生成产物） |
| `npm run test` | 运行单元测试（Vitest，~201 个） |
| `npm run test:ops` | 运行运维脚本 smoke 测试 |
| `npm run lhci` | 运行 Lighthouse CI（需先 `npm run build`） |

## Runtime Configuration

生产环境不再依赖 `VITE_*` 重新构建镜像。容器启动时会生成 `runtime-config.js`，由浏览器在加载主 bundle 前注入：

- `CHRONO_WEB_API_BASE_URL`
- `CHRONO_WEB_SENTRY_DSN`
- `CHRONO_WEB_ENVIRONMENT`

如果未提供这些环境变量，前端会回退到构建时的 `VITE_API_BASE_URL` / `VITE_SENTRY_DSN`。

## 离线同步（Track 1.B）

本仓库实现了完整的离线优先数据面：

- **`src/sync/replica-store.ts`** — IndexedDB 副本存储（`entities` / `outbox` / `sync_meta`），DB_VERSION=2，支持 `by_projection` 索引
- **`src/sync/use-sync-engine.ts`** — `useSyncEngine()` hook，委托 `@chrono/sync-engine` 的 `deriveRuntimeSyncState` 纯状态机
- **`src/components/ui/SyncStatusIndicator.tsx`** — 同步状态指示组件，使用 `@chrono/contracts` 的 `zhCNCatalog` 文案和设计 token 颜色
- **`src/hooks/useOfflineQueue.ts`** — `useReconnectFlush()` 网络恢复时自动刷新出站队列

同步状态枚举（`RuntimeSyncStateV1`）来自 `@chrono/contracts`：`unconfigured | disabled | idle | pulling | merging | pushing | paused | offline | conflicted | error`。

## E2E 测试

使用 Playwright，覆盖 4 个浏览器项目：

```bash
# 需要先启动 dev server
npm run dev &
npx playwright test

# 或通过 playwright.local.config.ts 单独运行
npx playwright test --config playwright.local.config.ts
```

| 测试文件 | 覆盖内容 |
|----------|----------|
| `e2e/axe-a11y.spec.ts` | axe 无障碍审计（login、register、billing） |
| `e2e/a11y.spec.ts` | 表单标签、键盘焦点、lang 属性 |
| `e2e/auth.spec.ts` | 登录、注册、SSO 回调流程 |
| `e2e/navigation.spec.ts` | 路由跳转、侧边栏导航 |
| `e2e/billing.spec.ts` | 计费页面渲染、订阅操作 |
| `e2e/onboarding.spec.ts` | 引导流程 |
| `e2e/simulation.spec.ts` | 模拟列表与结果视图 |
| `e2e/i18n.spec.ts` | 语言切换（zh-CN / en-US） |

## Lighthouse CI

```bash
npm run build
npm run lhci
```

阈值配置见 `.lighthouserc.js`：performance ≥ 0.80（warn）、accessibility ≥ 0.90（error）、best-practices ≥ 0.85（warn）、SEO ≥ 0.80（warn）。

## 跨运行时包依赖

本仓库通过 `file:` 依赖直接消费 `chrono-synth-os/packages/*`：

| 包 | 用途 |
|---|---|
| `@chrono/contracts` | 类型、Zod schema、文案字典（`zhCNCatalog`）、设计 token |
| `@chrono/sync-engine` | `deriveRuntimeSyncState` 状态机 |
| `@chrono/design-tokens` | `chronoDesignTokens`（颜色/间距/字型） |
| `@chrono/kernel-testkit` | 单元测试内存 DB 工具 |

## Docker

```bash
docker build -t chrono-synth-web:local .
docker run --rm -p 8080:8080 \
  -e CHRONO_WEB_API_BASE_URL=https://api.example.com \
  -e CHRONO_WEB_ENVIRONMENT=production \
  chrono-synth-web:local
```

## Deployment Ownership

完整 K8s / Podman 编排由同级仓库 `../chrono-synth-deploy` 负责；本仓库关注前端镜像、代理配置、运行时注入和前端测试基线。

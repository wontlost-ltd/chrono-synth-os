# 0049 — 把 web/desktop app host 收编进 chrono-synth-os monorepo

**Status:** Accepted
**Date:** 2026-06-08
**Scope:** repo layout, build/CI, dependency management
**Relates-to:** 收回 ADR-0046 D2 对 `chrono-synth-web` / `chrono-synth-desktop` 的「独立仓」豁免。

## Context

ADR-0046 D2 早已定调「同一内核多 host 进 `apps/`」，但当时给 `chrono-synth-web` 和
`chrono-synth-desktop` 开了豁免，让它们留作独立仓——理由是它们「pre-date `apps/` 且各自的
CI/release pipeline 独立 load-bearing」。

代价随时间显现：
- 这两个独立仓靠 **vendoring**（`sync:vendor` 把 `@chrono/*` 的 dist 拷进各仓的
  `vendor/` 或 `packages/`）消费内核包。vendoring 会漂移（本季就出过 vendored design-tokens
  的 license 字段漂移），且每次内核改动要同步到多仓。
- `@chrono/kernel` 等包**并未发布到 registry**（kernel 在 npmjs 是 404，其余 `private:true`），
  所以独立仓只能 vendoring，不能 `npm install`——独立仓的「独立」本就是假的，它们紧耦合内核。
- 内核改动变成跨仓 PR；issue/CI/dependabot 分散在多仓。

founder 决策（2026-06-08）：把 web/desktop 收编进 `apps/`，与 `apps/companion-web`（ADR-0046
新建）、`apps/mobile` 并列，作为 workspace 成员，消除 vendoring。这并非推翻 D2，而是**兑现
D2 的本意**（monorepo 多 host），只是把当初的豁免也收回。

## Decision

### D1 — web → `apps/web`，desktop → `apps/desktop`

- 拷贝两仓源码进 `apps/`（不保留 git 历史，旧仓归档不删——见 D5）。
- `@chrono/*` 依赖从 vendored `file:` / GitHub-Packages 改为 workspace `*`，解析到 `packages/*`
  符号链接。删除 vendoring 机制对 web/desktop 的部分、各仓自带 lockfile、`.npmrc`、vite 的
  `@chrono→vendored-dist` alias。
- 两者命名 `@chrono/web` / `@chrono/desktop`，license `AGPL-3.0-or-later`（消费级应用壳，
  纳入 `check-license-boundary.mjs` 的 AGPL 清单——现 4 个 app 壳）。

### D2 — app host 不进根 `tsc -b` 项目图，各自自构建

与 `apps/mobile`（Expo/Metro）、`apps/companion-web`（Vite）一致：web/desktop 用各自的
Vite/Tauri/vitest 构建与测试 lane，**不**加入根 `tsconfig.json` references（它们带 DOM/JSX，
根 Node 构建须保持干净）。`ga:check` 改为对本地 `apps/web` / `apps/desktop` 跑 typecheck +
i18n + vitest +（desktop）updater-pubkey lint，且**必过**（不再 `optional`——它们已在本仓）。

### D3 — React 版本：workspace 统一 19，mobile 因 RN 锁定隔离 18

- `chrono-synth-web` 用 React 19（`use()` hook），`chrono-synth-desktop` 用 React 19，
  `apps/companion-web` 原 18 但无 React-18/19 专属代码——**统一到 React 19**。
- 单一 workspace 内多包 dedup 会把 React hoist 到 root；web 自身生态（sentry/storybook/
  tanstack/testing-library/react-router/i18next）原会 dedup 到被 hoist 的 React，跨版本时
  类型+运行时双重冲突（实测 vitest 218 fail）。**修复**：root `package.json` `overrides` 强制
  `react`/`react-dom`@^19 + `@types/react`@19.2.15 / `@types/react-dom`@19.2.3 全树统一。
- `apps/mobile` 被 RN 0.76 锁死 React 18.3.1（升 19 需先升 RN 0.78+，是独立大工程）。它
  **不在 root workspaces**（Expo 自管依赖），故 root override 不波及它，保持 React 18 隔离。

### D4 — desktop 骨架的 persona-runtime 能力迁入 `@chrono/adapter-tauri`

OS 原 `apps/desktop` 不是空骨架：它有被测试覆盖的 `persona-runtime.ts`（用 adapter-tauri 把
kernel executors 本地接进 Tauri + 内存回退）。真品 `chrono-synth-desktop` 是另一套思路（本地
SQLCipher + CRDT + HTTP 连服务端，生产级，UI 从未采用骨架 runtime）。真品取代骨架，但能力
不丢：`bootPersonaRuntime` 迁为 `@chrono/adapter-tauri` 的正式包 API（它本就是「把 adapter-tauri
组装成可启动 runtime」），集成测试迁为该包的包测试（`test:packages` 覆盖）。

### D5 — 旧仓归档（不删）

`chrono-synth-web` / `chrono-synth-desktop` 收编后归档（GitHub archive），保留历史可查，但不再
接受改动。新 host 一律进本仓 `apps/`。`chrono-synth-deploy` **不**在本次范围（独立部署仓，
`ga:check` 仍按 sibling optional 解析）。

## 已知遗留 / 后续

- **`apps/mobile` 依赖未接好**（pre-existing，非本次引入）：它 `import '@chrono/contracts'` 但
  未声明该依赖、无 vendor、不在 workspaces——当前**无法解析 contracts**（PoC 从未真正接线）。
  因 RN 锁 React 18 与 workspace React 19 override 冲突，mobile **不宜**直接进 workspaces。
  后续单独处理：让 mobile 用自有 install（React 18 + Expo）+ `file:` 链到 `packages/contracts`，
  或等 RN 升级到支持 React 19 后再并入。本 ADR 不解决，仅登记。
- web/desktop 的 CI/release workflow（web: ci/e2e/release/security/chromatic；desktop:
  build/ci/release）原在各仓 `.github/`；收编时**未**迁入本仓根 `.github/`（嵌套 `apps/*/.github`
  会被 GitHub 忽略，已删除以免误导）。release/signing pipeline 迁移是后续项。
- web 的容器构建（`apps/web/Dockerfile` + `nginx.conf` + `docker-entrypoint.sh`）逐字保留，
  但其 build context 假定旧仓根，monorepo 化是后续项。

## Consequences

- ✅ 消除 vendoring 漂移；内核改动一次 PR 同时验证所有 host；issue/CI/dependabot 归一。
- ✅ web/desktop 测试纳入 `ga:check`（14 gate 全绿：含 web/desktop typecheck+vitest+updater lint）。
- ⚠️ root install 变重（多了 web/desktop 全套前端依赖 + React 19 树）。
- ⚠️ monorepo 体量进一步增大；companion-only / web-only 改动仍跑部分共享 gate（CI `paths:` 过滤是后续优化）。

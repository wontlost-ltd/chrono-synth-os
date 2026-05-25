# 0046 — Dual-product split: Enterprise governance + ChronoCompanion (C-end)

**Status:** Accepted
**Date:** 2026-05-25
**Scope:** product strategy, repo layout, GA timelines
**Supersedes:** 部分内容会反向影响 `01-pr-faq.md` 和 `13-oss-dual-track-strategy.md`
之前隐含的"单产品"假设；本 ADR 把"同一内核两个外壳"明文写死。

## Context

四个仓（`chrono-synth-os/web/desktop/deploy`）的 README 和 GTM (`.claude/gtm/`)
全部 lockstep 到 **B2B 企业 AI agent governance**：
- 定位："The governance layer for enterprise AI agents"
- PR-FAQ 锁定的 GA 目标：2027-Q1，Team $299/月、Enterprise $2K+/月、design partner 全是企业
- OSS 双轨：`@chrono/kernel` + PPF v1 作为引流护城河，闭源 SaaS 收钱

但同一份内核（`src/core/` 慢层 + `src/accelerated/` 快层 + `src/meta/` 元调控 +
`src/recovery/` 演化）的能力——core value、memory graph、value alignment、
persona drift baseline、并行人格实验、快照与演化合并——是**C 端"自学习/自适应/
自我进化数字人" 产品的教科书架构**。如果只让它服务 enterprise governance，
内核 80% 能力被埋没；同时 enterprise 增长曲线（10-20 单/年高客单 SaaS）也覆盖
不了纯消费品的爆发性增长机会。

候选路径（在 `.claude/plan/` 草稿讨论后）：

| 选项 | 说明 |
|------|------|
| A | 维持 enterprise 单产品路线，C 端能力留给开源社区做 |
| B | Pivot 到 C 端数字人，放弃企业 governance 路线 |
| C | **同一内核 + 两个独立外壳，并行发布** ← 本 ADR 选择 |

## Decision

启动 **ChronoCompanion**（代号 `chrono-companion`），作为 ChronoSynth 平台的
第二个产品形态。与 enterprise governance 平行存在、共享内核、独立 GA。

### D1 — 代号 & 品牌

- 内部代号：`chrono-companion`
- 商品名：**ChronoCompanion**
- iOS bundle id：`com.wontlost.companion`（GA 前不可改）
- Android package：`com.wontlost.companion`
- 域名（候选）：`companion.wontlost.com`（GA 前 marketing 团队最终拍板）

### D2 — 代码位置：进 OS monorepo 的 `apps/companion/`

- 新建 `apps/companion-web/`（React 19 + Vite 8 SPA，复用 chrono-synth-web 的
  design system，但路由 / brand / 计费完全独立）
- 扩 `apps/mobile/`（Expo + RN，现有 4 屏 → 完整 9-12 屏 companion UX）
- 扩 `apps/desktop/`（Tauri 2，给 power user 提供桌面陪伴形态；与现有
  enterprise governance Tauri 模式共存于同一 binary，登录时按账号 plan 切换）

**不开新仓**。理由：`apps/` 目录本来就是为 "同一内核多 host" 设计；新仓会让
kernel 改动变成跨仓 PR、CI 翻倍、issue tracker 分裂。

### D3 — 技术栈与复用

| 层 | 复用 | 新写 |
|----|------|------|
| 内核 | `@chrono/kernel` (OSS, MIT) | 0 |
| 共享 schemas | `@chrono/contracts` | 0 |
| 同步状态机 | `@chrono/sync-engine` | 0 |
| 设计 token | `@chrono/design-tokens` | 0 |
| 后端 API | 共用 `chrono-synth-os` 进程；companion 流量走 `/api/v1/companion/*` 路由前缀 | companion 专属路由（成长视图、Widget API、HealthKit ingest 等） |
| Web SPA | React 19 + Vite 8 + design tokens | 独立路由 + 独立品牌主题 |
| Mobile | 现有 `apps/mobile/` Expo + RN | 9-12 屏 + Widget + Live Activities + HealthKit |
| Desktop | 现有 `apps/desktop/` Tauri 2 | 系统 tray + 桌面陪伴 UX 扩屏 |

### D4 — Enterprise / Companion 边界

| 维度 | Enterprise（现有） | Companion（新） |
|------|---|---|
| Tenant 模型 | Multi-tenant (org/team/SCIM) | Single-tenant (1 user = 1 tenant) |
| Audit / SCIM / KMS / Drift | ✅ 强制 | ❌ 隐藏 / 简化 |
| 核心 UX 叙事 | "我的 8 个 agent 上周在干嘛" | "我的数字人在如何成长 / 适应我" |
| 价格 | $299–$2K+/月 SaaS | 免费 + IAP / 订阅 (TBD) |
| 入口 | Web console + Helm self-host | Mobile app + Web fallback + Desktop power user |
| Marketing 渠道 | LinkedIn / cold email / B2B | App Store ASO / 社区 / 个人推荐 |
| 收入合规 | Stripe 自由 | iOS 强制 IAP 30%（订阅 15%）+ Stripe Android web |
| 数据隔离 | per-tenant KMS / 行级 RLS | 单租户简化模型；BYOK 不强求 |

**关键原则**：companion 是 enterprise 内核的**个人化外壳**，不是 fork。Kernel
改进 → 两边都受益。`/api/v1/*` 通用，`/api/v1/governance/*` enterprise 专属，
`/api/v1/companion/*` C 端专属，路由层做产品边界。

### D5 — GA 节奏（并行不阻塞）

| 里程碑 | 时间窗 | 范围 |
|------|--------|------|
| Enterprise v2.0.0 GA | 现路径（1-3 月）| Web + 后端 + Helm + Desktop power-user 模式 + design partner #1 |
| Companion v0.1.0-alpha | Enterprise GA + 1-2 月 | `apps/companion-web` 出 + `apps/mobile` 扩到完整 9-12 屏；仅内测，不上商店 |
| Companion v0.5.0-beta | + 2 月 | TestFlight + Play Internal Test + 1 个 native 增强（推送）|
| Companion v1.0.0 GA | + 3 月 | App Store + Play Store 公开 + Widget + Live Activities + HealthKit |
| **总计到 Companion GA** | **~6-9 月** | |

**硬铁律**：
- Enterprise GA 不被 companion 阻塞
- Companion GA 不被 enterprise 阻塞
- 一旦发现彼此互相伤害（比如 kernel 改动一边受益一边崩），由内核维护者按 OSS
  dual-track strategy 第 4 节"upstream-first"原则裁决

## Consequences

### 正面

- 内核 80% 能力两边都吃到（C 端做出 PMF 反过来强化 enterprise drift baseline 的
  真实数据）
- OSS dual-track 价值真正兑现（`@chrono/kernel` 现在有 2 个 reference impl 而
  不是 1 个）
- 风险分散：B2B 销售周期慢但客单高 + C 端获客快但 ARPU 低，组合 portfolio
- 招聘叙事变好：候选人可以选 "做 enterprise infra" 或 "做 consumer AI"
- 复用现有 monorepo 工具链（`file:` 引用、design tokens 共享、schema-dsl）

### 负面 / 风险

| 风险 | 缓解 |
|------|------|
| Monorepo 变大、CI 翻倍 | `apps/companion-*` 独立 workflow，按 `paths:` 过滤，PR 只跑相关 job |
| GTM / 品牌 / 市场团队认知精分（"我们到底卖什么"）| ADR + PR-FAQ 双锁；marketing copy 严格按 PR-FAQ 走 |
| API 路由前缀膨胀导致后端代码混乱 | `src/server/routes/companion/` 与 `src/server/routes/governance/` 分目录组织 |
| Apple Dev / Play Store 账号 / 30% IAP 抽成 | 接受为 companion 进入 C 端的必要成本，记入 `.claude/gtm/04-pricing.md` 修订 |
| 内核为了 enterprise drift detection 改动可能不适配 companion 的"成长视图" | UX 层抽象：drift detection 的同一数据，enterprise 渲染为 "policy violation"，companion 渲染为 "你最近探索的方向" |
| Companion 上 App Store 审核可能被拒（AI agent / 数据隐私）| GA 前先用 TestFlight + Play Internal Test 试跑 4 周，找 1-2 个合规审核顾问 |

### 反向影响（要更新的现有文档）

| 文档 | 改动 |
|------|------|
| 4 个仓的 README | 加"双产品架构"段落 |
| `.claude/gtm/01-pr-faq.md` | 增加 Companion 简介段（不替换 enterprise PR-FAQ）|
| `.claude/gtm/13-oss-dual-track-strategy.md` | 加第 5 节"Companion as second OSS-kernel host" |
| `.claude/gtm/04-pricing.md` | 增加 Companion 定价 sub-doc（独立 PR）|
| `apps/mobile/README.md` | 从 "PoC" 升级到 "Companion mobile primary host" |

### 不在本 ADR 范围

- Companion 定价（独立 doc）
- Companion brand identity / logo / app icon（marketing 团队负责）
- 与 Apple/Google 开发者账号注册（需 founder 法律签字）
- C 端 GDPR / CCPA / 儿童保护合规（COPPA 若做 18- 用户）—— 独立 ADR

## Implementation Plan

参见 `docs/plan/companion-roadmap.md`（与本 ADR 同 commit 引入），作为
后续工作的 backlog。该文档可迭代；本 ADR 锁定的是 D1-D5 五个决策，不锁定
implementation 细节。

## Authors

- Decision driver: Ryan Pang (founder)
- ADR author: Claude (recorded after Option C selection on 2026-05-25)

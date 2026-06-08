# ChronoCompanion Roadmap

> 配套 ADR-0046（双产品并行）。本文件是 backlog，**可迭代**；ADR 锁定的是
> D1-D5 五个决策，本 plan 锁定的是"做哪些事 / 谁先 / 多长"。

## 当前状态（2026-05-25）

- ✅ ADR-0046 立项
- ✅ `@chrono/kernel` 已有完整三层架构 + 演化合并（companion 立刻能用）
- ✅ `@chrono/contracts` + `@chrono/sync-engine` + `@chrono/design-tokens` 三件套都已发布并消费
- ⚠️ `apps/mobile` 现有 4 屏 Expo 骨架 + 推送 / 后台同步 / 安全存储 plumbing — 是 PoC
- ⚠️ `apps/desktop` 现有 178 行 Tauri 骨架 + SQLCipher / CRDT — 是 enterprise PoC，需要加 companion 模式
- ✅ `apps/companion-web` 已建（React 18.3.1 + Vite 8 SPA：登录 + 主页 + 成长 + 记忆 tab，
  PR #62/#63）；Service Worker 待补
- ✅ 后端 `/api/v1/companion/{me, me/growth, me/memories}` 已上线（复用慢层 + drift 分析器 +
  MemoryFacade，plan/主体门控），Phase 2.1 完成（PR #62/#63）
- ❌ Apple Dev / Google Play 账号 — 需 founder 法律签字注册
- ❌ Companion 品牌资产（logo / app icon / 商店截图） — 需 marketing
- ❌ Companion 定价 sub-doc — 待写

---

## Phase 0 — 立项（本周）

| # | 任务 | 拥有者 | 状态 |
|---|------|--------|------|
| 0.1 | 写 ADR-0046 | Claude | ✅ |
| 0.2 | 写本 roadmap | Claude | ✅ |
| 0.3 | 4 仓 README 加"双产品架构"段落 | Claude | ✅ |
| 0.4 | 创建 `apps/companion-web/` 占位 + README | Claude | ✅ |
| 0.5 | 创建 `apps/companion-mobile/` 占位（或决定复用 `apps/mobile/`） | Claude | ✅ 决定复用 `apps/mobile/` |
| 0.6 | 更新 `apps/mobile/README.md`（PoC → "Companion primary mobile host"） | Claude | ⏳ |

---

## Phase 1 — Enterprise GA（不被 companion 阻塞，1-3 月）

按现有 `.claude/plan/ga-critical-remediation-2026-05.md` 推进：

- ✅ §8 #1 Critical/Major 三个修复落地
- ⏳ NAS / OCI 内测（CF Tunnel 路径）
- ⏳ Design partner #1 接入
- ⏳ v2.0.0 GA tag（去掉 `-beta` 后缀）

→ **本 ADR 不改变 enterprise GA 计划**。所有 companion 工作在 Phase 1 期间
**仅做立项 + 草图**，不写 production UI 代码。

---

## Phase 2 — Companion v0.1.0-alpha（Enterprise GA + 1-2 月）

**目标**：companion 三个 host（web/mobile/desktop）能各自跑起来一个 "我的数字人"
最小可用页面，仅内测，不上商店。

### 2.1 后端

- [x] `src/server/routes/companion/` 目录建出 (PR #62)
- [x] `/api/v1/companion/me` — 当前用户的数字人状态（值 + 记忆 + 叙事摘要）(PR #62)
- [x] `/api/v1/companion/me/growth` — "你最近探索的方向" 视图（drift detection
      数据的 C 端渲染）(PR #62)
- [x] `/api/v1/companion/me/memories` — 个人记忆**分页只读浏览**（复用 MemoryFacade.listMemories；
      写入/删除暂不开放，待 C 端"添加记忆"UX 定义）(PR #63)
- [x] 路由层 plan 切换：`/api/v1/companion/*` 要求账号 plan ≠ enterprise（并收紧拒绝
      API-key / service 主体——companion 仅个人会话）(PR #62)

### 2.2 Web (`apps/companion-web/`)

- [x] Vite + React + design tokens 启动（React **18.3.1** 而非 19——对齐 apps/mobile 既有
      React，避免一个 monorepo 两个 React 大版本；plugin-react@5 适配 Vite 8）(PR #62)
- [x] 3 屏：登录、我的数字人主页、成长视图（+ 记忆 tab）(PR #62 / #63)
- [x] PWA manifest（独立 brand color / icon）(PR #62)
- [x] Service Worker（vite-plugin-pwa injectManifest + 自写 src/sw.ts，复用 apps/web 策略；
      app shell precache + /companion/me* StaleWhileRevalidate 离线浏览 + auth NetworkOnly）

### 2.3 Mobile (`apps/mobile/` 扩屏)

- [ ] 在现有 4 屏（Dashboard / SimulationWizard / ConflictInbox / Billing）之上
      新增 5-7 屏 companion 专属：
  - [ ] CompanionHomeScreen — 我的数字人主页
  - [ ] GrowthScreen — 成长视图
  - [ ] MemoryDetailScreen — 单条记忆详情
  - [ ] SimulationResultScreen — 实验结果
  - [ ] SettingsScreen — 简化版设置
- [ ] Plan-based 路由切换：enterprise 用户进现有 4 屏，companion 用户进新 5-7 屏

### 2.4 Desktop (`apps/desktop/` companion 模式)

- [ ] 同 binary，登录后按账号 plan 切换 UX
- [ ] 系统 tray 添加 "数字人当前状态" 显示
- [ ] 占用率 / 资源消耗调优（一直在后台跑要省电）

### 2.5 退出条件

- [ ] 3 个 host 都能登录看到自己的数字人主页
- [ ] Drift detection 数据成功渲染为 "你最近探索" 而非 "policy violation"
- [ ] 内测 5 个用户跑 7 天无 critical bug

---

## Phase 3 — Companion v0.5.0-beta（+2 月）

**目标**：进 TestFlight + Play Internal Test，加 1 个 native 增强能力（推送）。

- [ ] Apple Dev / Google Play 账号注册 + Apple 法律签字
- [ ] Bundle id 钉死 `com.wontlost.companion`
- [ ] 推送（`expo-notifications` 已经在 deps 里，只缺业务逻辑）：
  - [ ] 数字人 "今天想跟你说" 每日推送
  - [ ] 提醒类（任务到期 / 记忆复习）
- [ ] TestFlight 50 人内测 + Play Internal Test 50 人
- [ ] Bug bash 2 周

---

## Phase 4 — Companion v1.0.0 GA（+3 月）

**目标**：App Store + Play Store 公开发布。

- [ ] Widget（iOS WidgetKit / Android Glance）
- [ ] Live Activities（iOS 16.1+）
- [ ] HealthKit 集成（睡眠 / 运动作为数字人 "自学习" 信号源）
- [ ] Face ID / Touch ID 登录（`expo-local-authentication`）
- [ ] App Store 审核 + Play Store 审核
- [ ] Marketing：landing 页、launch tweet、TikTok 30 秒 demo
- [ ] 定价 + IAP 接入（合规：iOS 强制 IAP 30%/15%）

---

## 关键非工程依赖（founder 负责）

| 事 | 必须 by | 否则后果 |
|----|---------|---------|
| Apple Developer Program 注册（$99/yr）| Phase 3 开始前 | TestFlight 进不去 |
| Google Play Developer 注册（$25 一次性）| Phase 3 开始前 | Play Internal Test 进不去 |
| Companion 品牌名最终拍板（D1 钉死 `ChronoCompanion`，但 logo / icon / 主色还要做）| Phase 2 末 | App Store metadata 没法填 |
| Companion 定价模型决策 | Phase 4 前 | 上不了 IAP |
| 隐私政策 + ToS（与 enterprise 不同的 C 端版本）| Phase 3 前 | 苹果审核必拒 |
| GDPR / CCPA 数据请求流程 C 端化 | Phase 4 前 | EU 合规事件 |

---

## 风险与缓解

| 风险 | 缓解 |
|------|------|
| Enterprise GA 拖延导致 companion phase 2 延后 | 接受 — ADR 已明文 enterprise 不被阻塞，反之亦然 |
| Monorepo CI 跑越来越慢 | `paths:` 过滤 + 拆 workflow，让 companion-only PR 不跑 enterprise full ga:check |
| Kernel 改动一边受益一边崩 | OSS dual-track 第 4 节 "upstream-first" + 每个 kernel PR 强制双 host smoke test |
| Apple Store 拒绝（AI 数字人合规） | TestFlight 期间找 1-2 个 App Store 审核顾问预审 |
| Companion UX 与 enterprise 共享 design tokens 但视觉感受冲突（一个是合规工具，一个是陪伴 app）| design tokens 加 `brand` 子命名空间：`tokens.enterprise.*` + `tokens.companion.*`；只共享语义 token（spacing / radius / type scale）|

---

## 决策日志

| 日期 | 决策 | 来源 |
|------|------|------|
| 2026-05-25 | Option C（双产品并行）正式立项 | founder ack + ADR-0046 |
| 2026-05-25 | 代号 `chrono-companion`、bundle id `com.wontlost.companion` | ADR-0046 D1 |
| 2026-05-25 | 进 `apps/companion-web/` + 扩 `apps/mobile/`，不开新仓 | ADR-0046 D2 |
| 2026-05-25 | Enterprise GA / Companion GA 互不阻塞 | ADR-0046 D5 |
| 2026-06-08 | 不冻结企业版、与企业 beta→GA 并行启动 Companion（路径 3 的"建"去掉"冻结"，守 D5）| founder |
| 2026-06-08 | Companion web 用 React 18.3.1（非 roadmap 写的 19）对齐 apps/mobile，避免双 React 大版本 | 实现取舍 |
| 2026-06-08 | Phase 2.1 后端完成 + Phase 2.2 web 三屏+记忆 tab 完成（PR #62/#63）；mobile/desktop（2.3/2.4）+ SW 待做 | 进度 |

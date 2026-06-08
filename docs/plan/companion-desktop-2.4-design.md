# Phase 2.4 — Desktop ChronoCompanion 模式（设计方案）

> 配套 companion-roadmap.md Phase 2.4。本文件**只是设计**，供 founder 选定做哪些再实施。
> 决策前提（Ryan 已定）：**plan 服务端权威 + companion 视图本地数据（混合）**；先出设计再定范围。

## 0. 现状（apps/desktop）

- 本地优先：SQLCipher DB 经 Rust `tauri-commands`。可用本地数据：`queryPersonas()`→`PersonaRow`
  （含 `growth_index`/`reputation`/`wallet_balance`）、`queryMemories()`→`MemoryNodeRow`、
  `getLatestDriftReport()`→`DriftReport`（与服务端同形，含 `valueDrifts`/`alertLevel`/
  `overallDriftScore`；Rust 未接时优雅返回 `null`）、`getSyncState()`、`crdtGetPersonaState()`。
- HTTP：`apiFetch`（base URL + JWT 存 localStorage），今仅用于 agent OAuth / pending-confirmations。
- 路由：`MemoryRouter` + 企业页（PersonaList / Conflicts / SafetyDrift / Settings / Onboarding /
  AgentOauth）。Boot gate：openDatabase → first-run → ready。**无 plan 概念。**
- tray.rs（36 行）：Open / Force Sync / Quit。**无「数字人状态」。**
- 本环境约束：**不能跑 cargo / Tauri 构建**——Rust 侧（tray/省电）只能写+review，不能编译验证；
  TS 侧可 vitest + typecheck 验证。

## 1. 三个子项拆解 + 可验证性

| 子项 | 内容 | 语言 | 本环境可验证性 |
|------|------|------|----------------|
| **2.4(a) plan-based UX 切换** | 登录后按 plan 切：enterprise→现有页；companion→精简「我的数字人/成长」视图 | **TS** | ✅ vitest + typecheck 全可验证 |
| **2.4(b) tray「数字人状态」** | 系统 tray 显示数字人当前状态（如 growth/alert/sync） | **Rust** + TS emit | ⚠️ Rust 不能 cargo 验证；TS emit 侧可测 |
| **2.4(c) 省电/资源调优** | 后台常驻省电（降低轮询、按电源状态调节） | **Rust** + TS | ⚠️ Rust 不能 cargo 验证；策略可 review |

## 2. 2.4(a) plan-based UX 切换（核心，TS 可验证）

### 2.1 plan 探测（服务端权威 + 本地缓存）

新增 `src/plan/account-plan.ts`：
- `resolveAccountPlan(): Promise<'enterprise' | 'companion' | 'unconfigured'>`
  1. 若 HTTP 未配置（无 base URL/token）→ `'unconfigured'`（引导去 Settings 配，或默认 enterprise 行为）。
  2. 调既有 `/api/v1/companion/me`（GET）：
     - **200** → `'companion'`（该账号是个人版，companion 路由放行）。
     - **403** → `'enterprise'`（companion 路由拒绝 enterprise = 该账号是企业版）。
     - 其他（网络失败等）→ 回退**本地缓存**的上次结果（`getAppSetting('account.plan')`）。
  3. 成功探测后 `setAppSetting('account.plan', plan)` 缓存（离线/下次启动用）。
- 复用我已建的服务端 plan 门控语义（`assertCompanionAccess` 对 enterprise 返 403），**零新后端**。
- 权威来自服务端、缓存在本地——满足「混合」决策。

### 2.2 路由切换

`App.tsx` 的 ready 态根据 plan 渲染不同 router：
- `enterprise` → 现有 `<Routes>`（PersonaList/Conflicts/...，不动）。
- `companion` → 新精简 `<Routes>`：`/`（我的数字人）+ `/growth`（成长）+ `/settings`（精简）。
- `unconfigured` → 现有 onboarding/settings 引导（先配 API）。
- gate 增加一个 `resolving-plan` 态（在 ready 之后、渲染路由之前探测一次 plan）。

### 2.3 companion 视图（**渲染本地数据**，离线可用）

新增组件（渲染 `tauri-commands` 本地数据，非 HTTP——符合「视图本地数据」决策）：
- `CompanionHomePage.tsx`：`queryPersonas()` 取主 persona → 显示 display_name + growth_index +
  最近 `queryMemories(personaId, N)`。空态友好。
- `CompanionGrowthPage.tsx`：`getLatestDriftReport()` → 复用 companion-web 已验证的
  **drift→「你最近探索的方向」** 映射逻辑（`driftReportToGrowth`：alertLevel→探索强度、delta 符号→
  toward/away）。⚠️ 该映射现在 `src/server/routes/companion/me.ts`（后端）——**建议抽到一个
  共享纯函数包/模块**（如 `@chrono/contracts` 或新 `packages/companion-domain`），让 desktop 本地
  渲染与服务端共用同一映射，避免两份分叉。这是本子项唯一的「跨层」改动，需单独评估。
- `CompanionSettingsPage.tsx`：精简设置（API 配置 + 登出 + plan 显示）。

### 2.4 可验证测试（vitest）

- `account-plan.test.ts`：mock apiFetch → 200/403/网络失败 各分支 + 本地缓存回退 + 缓存写入。
- companion 视图组件测试：mock tauri-commands 返回 → 渲染断言（含空态、drift→探索映射）。
- 路由切换测试：mock plan → 断言渲染 enterprise vs companion router。

## 3. 2.4(b) tray「数字人状态」（Rust，不能 cargo 验证）

### 设计
- `tray.rs` 增加一个**禁用的状态菜单项**（label 动态更新），如「🟢 数字人：成长中」/「🟡 探索活跃」/
  「🔴 需关注」/「⚪ 离线」。
- 前端→Rust 协议：前端定期（或状态变化时）`invoke('set_tray_status', { label })`，Rust 侧
  `set_tray_status` 命令更新菜单项文本（`MenuItem::set_text`）。或反向用 tauri `emit` + Rust 监听。
- 状态来源：前端用本地 `getLatestDriftReport()` 的 alertLevel + `getSyncState()` 的 online/offline
  合成一个 label（纯 TS 逻辑，**这部分可 vitest**：`computeTrayStatusLabel(drift, sync)`）。
- Rust 部分（`set_tray_status` 命令 + 持有 MenuItem 句柄）：**写但本环境编译不了**。

### 风险
Tauri 2 的 tray MenuItem 文本动态更新 API、命令注册、句柄持有跨 setup/command 边界——这些需 cargo
编译验证，本环境给不了保证。建议放到有 cargo 的环境做，或本轮只做**可测的 TS 合成逻辑**
（`computeTrayStatusLabel`）+ 留 Rust 接口 stub + 注释。

## 4. 2.4(c) 省电/资源调优（Rust + TS，不能 cargo 验证）

### 设计
- 前端：把 `getSyncState`/`getLatestDriftReport` 的轮询间隔做成**电源感知**——窗口隐藏/电池供电时
  拉长间隔（如 30s→5min），可见/插电时恢复。纯 TS 策略（`computePollInterval(visible, onBattery)`，
  **可 vitest**）。
- Rust：通过 tauri 监听窗口 focus/blur + （可选）电源状态插件，向前端 emit。Rust 部分不能 cargo 验证。
- 这是 2.4 里最虚的一项（「省电」无明确指标）——建议**最后做或先只做 TS 轮询策略**。

## 5. 跨层改动提示（需单独评估）

- **drift→exploration 映射共享**：`driftReportToGrowth` 现在后端 route 文件里。desktop 本地渲染要
  复用它 → 应抽成共享纯函数（contracts 或新包）。这会动到已合并的后端 route（把映射移走 + import）。
  收益：companion-web（服务端）、desktop（本地）共用一套映射，零分叉。成本：一次小重构 + 回归。

## 6. 建议的分期（一项一 PR，Codex 审）

1. **PR-A（2.4a 核心，纯 TS 可验证）**：plan 探测 + 路由切换 + companion 本地视图 +（先复制或抽共享）
   drift 映射 + vitest。**本轮最稳、价值最高。**
2. **PR-B（drift 映射共享重构）**：若 PR-A 选择「抽共享」，单独做这个跨层重构。
3. **PR-C（tray 状态 + 省电的 TS 合成逻辑）**：`computeTrayStatusLabel` / `computePollInterval` +
   vitest；Rust 接口留 stub。
4. **PR-D（Rust tray/省电落地）**：**待 cargo 环境**——`set_tray_status` 命令、MenuItem 动态文本、
   电源监听。本环境不做。

## 7. 待 founder 定的点

- 选做哪几个 PR（建议至少 PR-A）。
- drift 映射：PR-A 里**先复制一份**到 desktop（快、低风险、但两份），还是**抽共享**（PR-B，正确但动后端）？
- companion 视图渲染本地数据已定；是否要 desktop 也能像 companion-web 那样**可选**走服务端 /me（在线时更新）？还是纯本地？
- tray/省电的 Rust 部分确认放到 cargo 环境后续做（本环境只能写不能验证）。

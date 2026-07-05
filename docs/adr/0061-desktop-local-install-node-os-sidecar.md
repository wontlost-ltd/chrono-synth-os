# 0061 — 桌面本地安装包：完整 Node OS 内嵌为 Tauri sidecar（双击即用，无需 Docker）

**Status:** Accepted + **Implemented**（架构；分阶段——S0-S6 全部实现：S1 服务器可分发化+local profile / S2 Tauri sidecar 接线+握手 guard / S3 JWT secret keyring 持久 / S4 多平台构建 CI / S5 前端单机自动 provision / S6 端到端全链冒烟；11 红线闭环。follow-up：**单机 `local` 同步态 + 崩溃 auto-restart 已实现**——`local` 态修「本地无远端却永久 Syncing」(#262)；supervisor 线程 `try_wait` 侦测崩溃→有限次退避重启→轮换握手 token/复用持久 JWT secret→刷新端点 + emit `sidecar://restarted`（红线 4/5/11），前端失效缓存与重试解耦（任何 sidecar 网络错都失效端点缓存，让下次重取活端口）。⚠️ 剩余 follow-up：跨平台真机矩阵 + 签名/公证 = 生产发版前须实机 + 签名凭据）

**Date:** 2026-07-04

**Scope:** `apps/desktop`（Tauri v2 壳 + Rust sidecar 生命周期）、`src/`（Node OS 服务器单机 profile）、新桌面构建/发布 CI。

**关联：** [[0018]] Tauri over Electron（桌面壳选型）、[[0008]] IDatabase implements UoW、[[0047]] 运行时零-LLM 根基（内嵌不改运行时形态）、[[0056]] per-persona 认知内核隔离、[[0060]] 工具学习（内嵌后同样本地可用）。

---

## Context（背景）

ChronoSynth OS 的全部核心能力（零-LLM 人格内核、自主学习/劳动/工具学习、数字员工组织、企业治理）都在 **Node 服务器**（`dist/main.js`）里。现有 `apps/desktop`（Tauri v2）是**瘦客户端**：硬连 `http://localhost:3000`，`externalBin` 未配置，本地 SQLCipher 只存「离线查看人格/记忆 + 排队同步」的服务器 schema 子集，**不含 OS 引擎**。

后果：消费者要用完整 ChronoSynth，必须**另外**跑一个服务器（Docker `podman compose` 或 `node dist/main.js`）——这是给自托管/开发者的路径，不是「双击安装、无需懂 Docker」的消费级体验。

**scout 确认的关键事实（决定本 ADR 可行性远高于预期）**：

- **SQLite 无原生依赖**：服务器用 **Node 24 内置 `node:sqlite`（DatabaseSync）**（`src/storage/database.ts:12`），非 `better-sqlite3`（后者仅测试用）。零 `.node` 数据库依赖，完全可打包。
- **服务器可完全自包含启动**：任务队列是 **SQLite 支持的进程内队列**（`src/queue/task-queue.ts`），**不需要 Redis**。Redis/Kafka/PG/Stripe/OTEL 全部可选（默认关）。SQLite 文件 + 进程内队列 = 完整本地运行时。
- **唯一原生 blocker**：`@node-rs/argon2`（521KB 平台 `.node`，密码哈希）——须按平台随附对应预编译二进制。
- **Tauri 侧已就绪**：v2 + **`tauri-plugin-shell` 已装并初始化**（sidecar spawn 基础设施现成）；app-data-dir 解析已实现（跨平台）；CSP 已允许 `http://localhost:*`；默认 server URL 已是 `localhost:3000`。
- **缺口就三处**：`externalBin` 未配 / Rust 侧无 sidecar 生命周期管理 / 无桌面构建 CI（release.yml 只发服务器 Docker）。

---

## Decision（决策）

把**完整 Node OS 服务器**作为 **Tauri sidecar** 内嵌进桌面安装包：安装包自带后端可执行 + Node runtime + argon2 平台二进制；桌面壳启动时拉起本地 sidecar（绑 `127.0.0.1` 随机高端口，SQLite 落 app-data-dir），前端连它；退出时优雅关停。用户**双击安装即得完整 ChronoSynth，无需 Docker/Redis/PG，全本地**。

**单机 profile**：单用户单租户（`tenant=local` 固定），运行时零-LLM 铁律不变（[[0047]]）；多租户/billing/RBAC 等 B 端 SaaS 关注点在单机**配置关闭但代码不删**（保持一份代码库，服务器/桌面同源）。

---

## 红线（MUST）

1. **运行时零-LLM 不破**（[[0047]]）：内嵌只改**分发形态**，不改运行时——sidecar 里是同一 `dist/main.js`，仍确定性、蒸馏门、无运行时 LLM。（可选）连外部 LLM 老师仅在学习期、经 BYOK 显式配置。
2. **sidecar 只绑 loopback**：后端绑 `127.0.0.1`（**非** `0.0.0.0`），端口动态分配（避冲突）并传给前端；绝不对局域网/公网监听（单机 app 无多租户边界，暴露=越权面）。
   > ⚠️ **待实现硬验收项**（Codex 复审补事实）：服务器**现状** `server.host` 默认 `0.0.0.0`（`src/config/schema.ts:27`），loopback 是 desktop-local profile **必须显式设** `CHRONO_SERVER_HOST=127.0.0.1`——不能依赖默认，S2 须验收实际监听地址。
3. **数据落 app-data-dir，不落安装目录**：SQLite (`CHRONO_DB_PATH`) + 媒体 + 密钥落平台标准用户数据目录（macOS `~/Library/Application Support/<id>`、Win `%LOCALAPPDATA%`、Linux XDG）；卸载不误删用户数据（除非显式选择）；升级不覆盖数据。
4. **sidecar 生命周期严格绑 app**：壳启动拉起、退出优雅 SIGTERM 关停、崩溃可重启（有限次+退避）；**绝不留孤儿进程**（app 关了后端还在=资源泄漏+端口占用）。健康未就绪前前端不发业务请求（复用 `/readyz`）。
5. **单机认证仍在，但本地化**：JWT 仍启用（`CHRONO_JWT_ENABLED=true`），secret 首启随机生成存平台 keyring（**不硬编码**、不进安装包明文）；单用户免注册流可自动 provision 本地 admin，但 token 仍走既有鉴权链（不旁路 requireRole/owner 门）。
6. **原生二进制按平台随附**：`@node-rs/argon2` 的 `.node` 必须匹配安装包目标平台/架构（darwin-arm64/darwin-x64/win-x64/linux-x64 各一份）；缺失/错架构 → 启动 fail-closed 明确报错，不静默降级到弱哈希。
7. **构建可复现 + 供应链**：桌面安装包构建须锁定 Node 版本（≥24，`.nvmrc`）、锁 lockfile（跨平台 `npm ci`，注意既有 rolldown/emnapi lockfile 陷阱）、签名（macOS codesign+notarize / Windows Authenticode），产物经 CI 出，不手工打。
8. **单机 profile 不删企业代码**：多租户/billing/RBAC/PG/Redis/Kafka 全部**配置关闭**（既有默认已关），不 fork、不裁剪代码库——桌面与服务器发行版同源，只差配置 + 打包。裁剪只在**构建期**（可选 tree-shake 未用 SaaS 依赖减体积），不在源码。
9. **迁移与首启幂等**：sidecar 首启对本地 SQLite 跑全量迁移（幂等）；升级安装包→迁移向前兼容（不破坏既有本地数据）；迁移失败 fail-closed（不带半迁移状态启动，对齐 [[0024]] no-auto-restart-on-migration-fail）。
10. **离线优先，联网可选**：核心（人格/companion/自主学习内化已学/工具执行）**全本地可用离线**；仅「找 LLM 老师学新知识」「感知多模态老师」「对外工具真实副作用」需联网——离线时确定性降级（登记异步学习请求 / honest_offline），不崩。
11. **本地调用者绑定，loopback≠鉴权边界**（Codex 复审补，MUST）：`127.0.0.1` 上**同机任意进程都能打 sidecar**——CORS/CSRF 只约束浏览器不约束本地进程（既有 CSRF 插件明确 Bearer/API-key 不覆盖）。故除 JWT 外，非 public 端点**必须**再要求 **per-launch sidecar 握手 token**：Rust 首启生成随机 secret → 经 env 传 sidecar + 经 Tauri invoke 传前端 → 前端每请求带 `X-Chrono-Desktop-Session`（或等价）→ 后端校验。握手 token **不进 localStorage、不落盘、不写日志**，app 重启轮换；`/readyz` 返回 instance nonce，前端连接前校验（防本地端口劫持 / 误连旧进程）。**威胁模型诚实边界**：keyring + JWT + 握手 token 防安装包硬编码、跨-app 误用、端口劫持；**不防同 OS 用户级恶意软件**（能读 keyring/内存/env 的同用户进程超出本地 app 防护范围）——只做最小暴露 + fail-closed，不宣称防同用户 malware。

---

## 分片路线（S0-S6）

| 阶段 | 内容 | 依赖 | 状态 |
|---|---|---|---|
| **S0** | 本 ADR：内嵌形态 + 11 红线 + 路线（spec-only） | — | ✅ 本 ADR（#255） |
| **S1** | **local profile 契约 + 服务器可分发化**：先定 desktop-local profile config 契约（`CHRONO_SERVER_HOST=127.0.0.1`、动态端口、`CHRONO_DB_PATH`→app-data、JWT secret 来源、queue in-process、Redis/PG/OTEL off、offline defaults、握手 token 来源）；再把 ESM `dist/main.js` + **生产裁剪 node_modules**（`npm ci --omit=dev`，含 `@node-rs/argon2` 平台 `.node`，**不含** dev/test/build 的 rolldown/lightningcss/better-sqlite3 等 `.node`）打成随附 sidecar 产物（优先随附 Node runtime，SEA 为可选优化）。本地起停 + `/readyz` 冒烟 | S0 | ✅ 已实现（#256） |
| **S2** | **Tauri sidecar 接线**：`externalBin` 配置 + Rust 侧 spawn/健康等待(轮询 `/readyz`)/优雅关停/崩溃重启（tauri-plugin-shell）；动态端口分配传前端；**per-launch 握手 token 生成→env 传 sidecar + invoke 传前端**（红线 11）；前端 API base 指向本地 sidecar + 带握手头（替换手工配 server URL）；红线 2/4/11 落地 | S1 | ✅ 已实现（#257） |
| **S3** | **数据与密钥本地化**：SQLite 落 app-data-dir + 首启迁移幂等 + JWT secret keyring 生成 + 单用户自动 provision 本地 admin（token 走 keyring 不进 localStorage，红线 3/5/9/11） | S2 | ✅ 已实现（#258） |
| **S4** | **桌面构建 CI**：新 workflow 多平台 `tauri build`（macos arm64/x64、win x64、linux）+ 按目标架构下载锁版本 Node + SHASUMS 校验；签名/公证凭据经 secrets 注入（**缺省跳过出 unsigned 内测包**——正式签名/公证 + 跨平台矩阵实跑 = follow-up，红线 7）；沿用既有 updater endpoint | S2 | ✅ 已实现（#259，CI 骨架+资源打包；正式签名公证 follow-up） |
| **S5** | **前端单机适配**：companion + enterprise UI 在单机 profile 下的引导（首启无需填 server URL/token）；离线降级 UX（红线 10）；企业面在单机隐藏或标注「本地单租户」 | S2、S3 | ✅ 已实现（#260） |
| **S6** | **端到端 + 冒烟**（本 PR 落地范围）：**便携 sidecar bundle 本地全链冒烟**（`e2e:desktop-local`——拷临时目录断符号链接起 bundle → 握手/红线11 → auto-provision → companion 零-LLM → per-persona 组织出生 → T7 路由接通 → SQLite 落库 → 优雅关停无孤儿）。⚠️ **真·干净机双击安装 / 跨平台安装器矩阵 / 签名公证 / 卸载升级数据保全** = 生产发版前 follow-up（须实机 + 签名凭据 + CI 矩阵实跑）。 | S1-S5 | ✅ 已实现（本 PR，范围=便携 bundle 本地全链；真机/矩阵/签名 follow-up） |

---

## Consequences（后果）

**正面**：
- 消费级「双击即用」的完整 ChronoSynth——无 Docker/Redis/PG 门槛，全本地隐私（数据不出机）。
- 与 [[0047]] 零-LLM 根基天然契合：本地确定性内核**本就不需要联网**，离线可用是自然属性而非额外工程。
- 桌面/服务器同源（红线 8），一份代码库两种分发；企业 SaaS 不受影响。

**负面 / 权衡**：
- 安装包体积含 Node runtime + node_modules（~40-80MB 量级），比瘦客户端大。
- 跨平台构建/签名/公证是真复杂度（macOS notarize、Windows Authenticode、Linux 多格式），须 CI 自动化（红线 7）。
- sidecar 生命周期（孤儿进程、端口冲突、崩溃重启）是有状态工程，须严谨（红线 4）。
- 单机 profile 里多租户/billing/RBAC 是「配置关闭的死重」——接受（红线 8，不 fork 换取单一代码库）。

**不承诺**：
- 移动端（iOS/Android）本地内嵌完整 Node OS——移动无法跑 Node sidecar，移动仍是连服务器/本地精简的独立路径（本 ADR 只管桌面）。
- 把单机 SQLite 数据自动云同步/多设备——超出本地安装包范畴（既有 desktop sync 引擎是另一条线）。

---

## 实现规格备注（S1+ 落地时明确）

- **sidecar 打包选型**（S1 定）：优先「随附 Node runtime + **生产裁剪** node_modules（`npm ci --omit=dev`，只含运行时依赖 + argon2 平台 `.node`，剔除 dev/test/build 的 `.node`）」（最稳，argon2 `.node` 直接可用），SEA/单文件为可选优化（须解决 argon2 native asset + Node 24 ESM/SEA 现状复杂度）。避免 pkg（Node 24 ESM 支持弱）。
- **端口**：sidecar 绑 `127.0.0.1:0`（内核分配）→ 读实际端口 → 经 Tauri 命令/环境传前端；不用固定 3000（避已运行的开发服务器/其他 app 冲突）。
- **首启 provision**：单机检测「无用户」→ 自动建本地 admin（随机密码存 keyring 或免密本地会话），token 仍走 JWT 链（红线 5）。
- **健康门**：Rust 侧 spawn 后轮询 `http://127.0.0.1:<port>/readyz` 直至 ok 再放行前端（红线 4），超时 fail 明确报错。
- **argon2 平台矩阵**：构建期按 target 只随附对应 `@node-rs/argon2-<platform>` 包（红线 6），减体积 + 防错架构。

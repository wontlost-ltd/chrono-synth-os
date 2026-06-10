# Desktop ChronoCompanion 成长数据点亮 — 设计方案（ADR-0046 ②）

> 目标：让 desktop companion 的「你最近探索的方向」(Growth) 从**永远空态**变成**真实数据**。
> 本文件只是设计，供 founder 选路线再实施。

## 0. 现状与根因

- desktop Growth 视图（`CompanionGrowthPage`）调本地桥接 `getLatestDriftReport()` + `queryTenantSnapshotCount()`，
  喂给共享纯函数 `driftReportToGrowth`（@chrono/contracts）。
- **根因**：desktop 本地 SQLCipher schema（由 `@chrono/schema-dsl` 生成，desktop migrations v001–v007）
  **没有 `snapshots` 表，也没有 drift 数据**。两个桥接命令优雅降级（count→0、report→null）→ `hasBaseline=false`
  → 永远渲染「还在认识你」空态。
- 服务端 drift **不是存表**，而是 `PersonaDriftAnalyzer.analyze()` **实时**读 `snapshots` 表计算出 `DriftReport`
  （含 valueDrifts/alertLevel/overallDriftScore）。即「快照是数据，drift 是算出来的」。

## 1. 两条路线

### 路线 A：本地优先（mirror snapshots + 本地算 drift）

把服务端那套搬到 desktop，真正离线可算。

步骤：
1. `@chrono/schema-dsl` 加 desktop **v008**：`snapshots(id, data_json, reason, created_at)`（镜像服务端子集）
   + 可选 drift 缓存表。加入 `DESKTOP_MIGRATIONS`，跑 parity test，`build.rs` 重新生成 Rust migrations。
2. desktop 同步引擎新增拉取 snapshots：`force_sync` 增 `fetch_remote_snapshots()`（HTTP `/api/v1/...`，
   需服务端暴露 snapshots 列表端点或复用现有）→ 持久化到本地 `snapshots`。
3. **把 `PersonaDriftAnalyzer` 的计算逻辑移植**到能在 desktop 跑的地方：
   - 选项 A1：抽成 TS 纯函数（`@chrono/contracts` 或新包），desktop 前端读本地 snapshots 后算 drift。
   - 选项 A2：在 Rust `get_latest_drift_report` 命令里用 Rust 重写分析器。
4. `count_snapshots` 命令真实实现（`SELECT COUNT(*) FROM snapshots`）。

- **优点**：真离线、与「desktop 渲染本地数据」决策一致、drift 计算复用为跨端能力（A1 还能给别处用）。
- **成本**：大。动 schema-dsl（影响生成管线）+ 同步管线 + 移植分析器（A2 还要 Rust 重写 + cargo 验证）。
  多 PR、跨层。snapshots 的 data_json 体积/同步频率也要设计。

### 路线 B：在线取 + 本地缓存（复用已上线端点）

desktop Growth 在线时直接取服务端**已映射**的 growth DTO，缓存最后一次供离线显示。

步骤：
1. desktop Growth 改为：在线时 HTTP 取 `/api/v1/companion/me/growth`（已上线，返回 `CompanionGrowthV1`，
   服务端已做 drift→探索映射）——和 **mobile 完全一样**的数据来源。
2. 把最后一次成功的 `CompanionGrowthV1` 持久化（app_settings 或小表），离线/启动时先显示「上次」。
3. 不需要 v008、不需要 snapshots 同步、不需要移植分析器。`driftReportToGrowth` 在 desktop 不再用
   （但服务端仍用它；共享抽取 PR-B 不白做）。

- **优点**：小、快、低风险，复用 PR #62 已上线端点；与 mobile 数据来源统一。
- **成本/取舍**：drift 不在本地算（违背「本地优先」纯粹性）；离线只能看「上次同步的」成长，不是实时。
  desktop 已有 HTTP 客户端（`apiFetch`，今用于 agent OAuth），加这个调用不突兀。

## 2. 关键权衡（需 founder 定）

| 维度 | 路线 A（本地算） | 路线 B（在线取+缓存） |
|------|------------------|------------------------|
| 离线能力 | 真·离线实时算 | 离线看上次缓存 |
| 与 desktop「本地优先」决策 | 一致 | 部分偏离 |
| 工作量 | 大（schema-dsl+同步+移植，多 PR） | 小（1 PR） |
| 与 mobile 一致性 | 不同（mobile 在线取） | 一致（都取 /me/growth） |
| 复用 `driftReportToGrowth` | 是（本地） | 否（仅服务端） |
| 风险 | 高（动生成管线/Rust 重写） | 低 |

## 3. 折中（路线 C）：B 先上，A 作为后续

先做 **B** 让 desktop Growth 立刻有真实数据（小 PR、低风险、与 mobile 统一）；把 **A** 列为「真离线」
的后续增强（等有明确离线需求再投入 schema-dsl + 分析器移植）。`getLatestDriftReport`/`count_snapshots`
的本地桥接保留（已优雅降级），A 落地时再接真实数据源——两条路不冲突。

## 4. 待 founder 定

- 选 A / B / C？（建议 C：先 B 点亮，A 留后续）
- 若选含 A：`PersonaDriftAnalyzer` 移植走 A1（TS 纯函数共享）还是 A2（Rust 重写）？
- 若选含 B：缓存放 app_settings（KV，简单）还是新建 `companion_growth_cache` 小表？
- 是否需要服务端新增「raw snapshots 列表」端点（仅路线 A 需要）。

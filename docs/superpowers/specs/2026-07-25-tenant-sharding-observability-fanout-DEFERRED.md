# 租户分片 · Observability worker 独立进程跨 shard fan-out（DEFERRED 子设计）

> **状态：DEFERRED**。从 Plan 2（`2026-07-24-tenant-sharding-phase0-plan2-fanout-design.md`）拆出——Plan 2 原 spec §范围含 observability worker，但其独立进程跨 shard fan-out 复杂度显著高于其余 worker（Kafka consumer-group 跨 shard 路由是真子设计），故拆为**本独立 spec，待 Plan 2（其余 5 块）完成后单独 brainstorm→spec→plan→实现**。Plan 2 的 Self-Review 据此排除 observability。

## 为何独立

`main-observability-worker.ts` 是**独立进程入口**（非 createApp 内），装配链：
```
createDatabase(config) → ObservabilityPipelineService(db) → ObservabilityWorkerMonitorServer({ db, pipeline })
```
`ObservabilityPipelineService` 内部持单一 db，按 config 建：① 单 direct worker；或 ② 单 Kafka producer + consumer。跨 shard fan-out 涉及以下**未定型**的子设计（非「每 shard new 一个 pipeline」可简单解决）：

1. **resolver 来源**：`buildResolver(config, hostDb)` 多库当前 `throw MultiShardRuntimeNotReadyError`（fail-closed，Plan 3 才放开）——独立进程如何拿多-shard resolver？（Plan 3 放开后从 config 构造，还是独立进程有自己的装配路径？）
2. **Kafka consumer-group 跨 shard 路由**：多 consumer 如何按 tenant 路由到正确 shard？consumer-group 语义会不会导致某事件只被其中一个随机实例消费？direct 模式（各 shard 各 drain outbox + rollup）相对简单，但 Kafka 模式需定 per-shard consumer 归属 / topic-per-shard / tenant-key 分区。
3. **多 pipeline 生命周期**：每 shard 一个 pipeline 的 start/stop/健康聚合；`ObservabilityWorkerMonitorServer` 如何聚合多 shard 的健康与 backlog（照 MediaRetention 的模块级 degraded state 模式？）。
4. **direct vs Kafka 两模式**都要 fan-out 定型。

## 待定型（brainstorm 时展开）

- direct 模式：`ObservabilityPipelineService` 收 resolver，各 shard 各 drain observability outbox（`obsQueryPendingEvents` 无 tenant 过滤=跨 shard）+ 各 rollup，逐 shard 隔离（照 Plan 2 fan-out 铁律 + ShardAggregate）。
- Kafka 模式：consumer-group 跨 shard 路由 / topic 归属 / 分区键——需 brainstorm。
- monitor 多 shard 健康聚合：照 Plan 2 MediaRetention 模块级 degraded state 模式。
- 与 Plan 3 依赖：resolver 来源可能需 Plan 3 放开 fail-closed 后才有真多-shard resolver——**本子设计可能依赖 Plan 3**，实现顺序 brainstorm 时定。

## 验收（brainstorm 后细化）
- direct 模式：两 shard 各 seed pending observability event → 各 drain + rollup（仅 home drain 会漏 s1，断言抓）；per-shard 隔离。
- Kafka 模式：跨 shard 事件路由到正确 shard 消费；无重复/无漏。
- monitor 聚合多 shard 健康。

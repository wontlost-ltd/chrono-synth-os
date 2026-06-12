# 架构文档

> 延伸阅读：[零-LLM 精度、蒸馏门、提速、成长历程与企业接入](zero-llm-precision-and-growth.md)
> —— 解释数字人在无 LLM 时如何不失精度、蒸馏门如何防幻觉污染内核、响应如何提速、空白人格
> 如何成长为领域大师、以及如何接入企业级系统（均引真实代码）。

## 三层架构详解

ChronoSynth OS 采用三层架构，模拟人格系统中「稳定身份」与「快速适应」之间的动态平衡。

### 慢层 — Core Rhythm Layer

**职责**：维护数字人格的核心身份——价值体系、记忆网络和身份叙事。

**核心组件**：

| 组件 | 类 | 说明 |
|------|----|------|
| 价值存储 | `ValueStore` | CRUD 核心价值维度，权重 0-1 |
| 记忆图谱 | `MemoryGraph` | 图结构管理三类记忆和关联边 |
| 叙事存储 | `NarrativeStore` | 维护身份叙事文本 |
| 层门面 | `CoreRhythmLayer` | 统一入口，协调三个存储并发射事件 |

**数据流**：
```
外部输入
  ↓
CoreRhythmLayer
  ├→ ValueStore ──→ core_values 表
  ├→ MemoryGraph ──→ memory_nodes + memory_edges 表
  └→ NarrativeStore ──→ narrative 表
  ↓
EventBus (core:value-updated / core:memory-added / core:narrative-changed)
```

**设计原则**：
- 所有写入操作通过 `CoreRhythmLayer` 门面进入，确保事件一致性
- `ValueStore` 和 `MemoryGraph` 直接操作数据库，保证持久化
- 记忆图谱支持三种类型：`episodic`（情节）、`semantic`（语义）、`procedural`（程序性）
- 记忆节点通过 `MemoryEdge` 建立加权关联

### 快层 — Accelerated Layer

**职责**：运行并行人格实验，评估不同价值调整方案的适应度。

**核心组件**：

| 组件 | 类 | 说明 |
|------|----|------|
| 人格引擎 | `PersonaEngine` | 管理人格版本的生命周期 |
| 模拟运行器 | `SimulationRunner` | 执行场景模拟，计算适应度 |
| 层门面 | `AcceleratedLayer` | 统一入口，协调分叉/暂停/模拟 |

**数据流**：
```
慢层核心价值（只读复制）
  ↓
AcceleratedLayer.forkPersona()
  ↓
PersonaEngine ──→ persona_versions 表
  ↓
SimulationRunner.run(persona, scenario)
  ↓
SimulationResult { fitnessScore, valueAdjustments, insights }
  ↓
EventBus (persona:created / persona:simulation-completed)
```

**人格版本状态机**：
```
active ──→ paused ──→ active
  │                      │
  ├──→ completed         ├──→ completed
  └──→ failed            └──→ failed
```

**模拟评估**：
- 默认评估器通过匹配人格价值与场景参数计算适应度分数
- 支持注入自定义 `EvaluatorFn` 实现业务特定的评估逻辑
- 输出包括适应度分数（0-1）、价值调整建议和洞察文本

### 元调控层 — Meta-Regulation Layer

**职责**：仲裁快层实验与慢层身份之间的关系——检测冲突、分配资源、决定集成。

**核心组件**：

| 组件 | 类 | 说明 |
|------|----|------|
| 冲突解析器 | `ConflictResolver` | 检测价值分歧和资源争用 |
| 集成引擎 | `IntegrationEngine` | 评估和应用实验结果到核心层 |
| 资源分配器 | `ResourceAllocator` | 按策略分配实验资源配额 |
| 层门面 | `MetaRegulationLayer` | 统一入口 |

**数据流**：
```
所有活跃人格版本
  ↓
ConflictResolver
  ├→ 价值分歧检测（阈值比较）
  └→ 资源争用检测（配额总和 > 1.0）
  ↓
EventBus (meta:conflict-detected / meta:conflict-resolved)

SimulationResult
  ↓
IntegrationEngine.propose()
  ↓
IntegrationProposal { valueChanges, confidence }
  ↓
IntegrationEngine.evaluate() → 是否超过 minFitness + minConfidence
  ↓
IntegrationEngine.apply() → 受 maxWeightDelta 限制写入慢层
  ↓
EventBus (meta:integration-proposed / meta:integration-decided)

活跃人格列表
  ↓
ResourceAllocator.allocate(strategy)
  ├→ 'equal' — 平均分配
  ├→ 'fitness_weighted' — 按适应度加权
  └→ 'priority_based' — 按创建时间加权
  ↓
EventBus (meta:resources-allocated)
```

**冲突类型**：
- `value_divergence`：两个人格版本在同一价值维度上分歧超过阈值（默认 0.3）
- `resource_contention`：所有活跃人格的资源配额总和超过 1.0
- `narrative_inconsistency`：叙事文本不一致（保留类型，由扩展实现）

**冲突去重**：对相同人格版本对的冲突自动去重，避免重复调控周期产生冗余冲突。

### 层间交互模式

```
     ┌─────────────────────────┐
     │      ChronoSynthOS      │  ← 编排器
     │  start/stop/close       │
     │  createSnapshot         │
     │  runEvolutionCycle      │
     │  runRegulationCycle     │
     │  forkAndSimulate        │
     └──┬──────┬──────┬────────┘
        │      │      │
   ┌────▼─┐ ┌─▼────┐ ┌▼──────────┐
   │ Core │ │Accel │ │   Meta    │
   │Layer │ │Layer │ │  Layer    │
   └──┬───┘ └──┬───┘ └──┬────────┘
      │        │        │
      └────────┼────────┘
               │
         ┌─────▼─────┐
         │  EventBus │  ← 解耦层间通信
         └─────┬─────┘
               │
         ┌─────▼──────┐
         │  SQLite DB │  ← 共享持久层
         └────────────┘
```

**通信规则**：
- 各层不直接引用彼此，通过 `EventBus` 发射和监听事件
- `ChronoSynthOS` 编排器持有所有层引用，负责跨层协调操作
- 共享 `IDatabase` 实例，通过事务保证跨表一致性

---

## 事件驱动通信

`SystemEventMap` 定义了 17 种类型化事件，编译时保证类型安全。

### 核心节律层事件（4 种）

| 事件名 | 载荷 | 触发时机 |
|--------|------|---------|
| `core:value-updated` | `{ value: CoreValue }` | 添加或更新核心价值 |
| `core:memory-added` | `{ memory: MemoryNode }` | 添加新记忆节点 |
| `core:memory-accessed` | `{ memoryId: string }` | 访问记忆（更新时间戳） |
| `core:narrative-changed` | `{ narrative: string; previousNarrative: string }` | 叙事文本变更 |

### 加速认知层事件（3 种）

| 事件名 | 载荷 | 触发时机 |
|--------|------|---------|
| `persona:created` | `{ persona: PersonaVersion }` | 创建新人格版本 |
| `persona:status-changed` | `{ personaId: string; oldStatus: PersonaStatus; newStatus: PersonaStatus }` | 人格状态变更 |
| `persona:simulation-completed` | `{ result: SimulationResult }` | 模拟运行完成 |

### 元调控层事件（5 种）

| 事件名 | 载荷 | 触发时机 |
|--------|------|---------|
| `meta:conflict-detected` | `{ conflict: Conflict }` | 检测到新冲突 |
| `meta:conflict-resolved` | `{ conflictId: string; resolution: string }` | 冲突已解决 |
| `meta:resources-allocated` | `{ allocations: readonly ResourceAllocation[] }` | 资源重新分配 |
| `meta:integration-proposed` | `{ proposal: IntegrationProposal }` | 生成集成提案 |
| `meta:integration-decided` | `{ proposalId: string; accepted: boolean }` | 集成决策结果 |

### 系统级事件（5 种）

| 事件名 | 载荷 | 触发时机 |
|--------|------|---------|
| `system:snapshot-created` | `{ snapshot: SystemSnapshot }` | 快照创建完成 |
| `system:snapshot-restored` | `{ snapshotId: string }` | 快照恢复完成 |
| `system:evolution-completed` | `{ mergedVersionIds: readonly string[] }` | 演化周期完成 |
| `system:started` | `{ timestamp: number }` | 系统启动 |
| `system:stopping` | `{ timestamp: number }` | 系统停止中 |

---

## 数据模型

### 核心价值 (CoreValue)

表示人格在某一维度上的重视程度。

```typescript
interface CoreValue {
  readonly id: ValueId;      // UUID
  readonly label: string;    // 维度标签（如 "curiosity"）
  weight: number;            // 0-1，重要性权重
  updatedAt: number;         // 时间戳
}
```

### 记忆图谱 (MemoryNode + MemoryEdge)

图结构存储记忆节点和关联关系。

```typescript
// 节点
interface MemoryNode {
  readonly id: MemoryId;
  readonly kind: 'episodic' | 'semantic' | 'procedural';
  readonly content: string;
  valence: number;           // -1 到 1，情感色调
  salience: number;          // 0-1，重要性
  readonly createdAt: number;
  lastAccessedAt: number;    // 访问时更新
}

// 边
interface MemoryEdge {
  readonly source: MemoryId;
  readonly target: MemoryId;
  strength: number;          // 0-1，关联强度
  readonly relation: string; // 关系描述
}
```

### 人格版本 (PersonaVersion)

快层中的并行实验实体。

```typescript
interface PersonaVersion {
  readonly id: PersonaVersionId;
  readonly label: string;
  readonly values: ReadonlyMap<string, number>;  // 实验价值权重
  status: PersonaStatus;                         // 生命周期状态
  readonly results: SimulationResult[];           // 模拟结果列表
  resourceQuota: number;                         // 0-1，资源配额
  readonly createdAt: number;
  updatedAt: number;
}
```

### 冲突 (Conflict)

元调控层检测到的版本间冲突。

```typescript
interface Conflict {
  readonly id: string;
  readonly kind: ConflictKind;
  readonly severity: ConflictSeverity;           // low / medium / high / critical
  readonly involvedVersions: readonly PersonaVersionId[];
  readonly affectedValues: readonly ValueId[];
  readonly description: string;
  readonly detectedAt: number;
  resolvedAt?: number;
  resolution?: string;
}
```

### 系统快照 (SystemSnapshot)

完整的系统状态切面，用于恢复。

```typescript
interface SystemSnapshot {
  readonly id: SnapshotId;
  readonly coreSelf: CoreSelfState;              // 核心层完整状态
  readonly personas: readonly PersonaVersion[];  // 所有人格版本
  readonly activeConflicts: readonly Conflict[];  // 未解决冲突
  readonly allocations: readonly ResourceAllocation[];
  readonly createdAt: number;
  readonly reason: 'scheduled' | 'manual' | 'pre_evolution' | 'shutdown';
}
```

### 演化记录 (EvolutionRecord)

记录一次演化周期的变更详情。

```typescript
interface EvolutionRecord {
  readonly id: string;
  readonly beforeSnapshotId: SnapshotId;
  readonly afterSnapshotId: SnapshotId;
  readonly mergedVersionIds: readonly string[];
  readonly valueDelta: ReadonlyMap<string, number>;
  readonly evolvedAt: number;
}
```

---

## 存储层设计

### SQLite Schema

使用 Node.js 24 内置 `node:sqlite`，零外部依赖。

**8 张表 + 4 个索引**：

| 表名 | 主键 | 说明 |
|------|------|------|
| `core_values` | `id TEXT` | 核心价值维度 |
| `memory_nodes` | `id TEXT` | 记忆节点 |
| `memory_edges` | `(source, target)` | 记忆关联（复合主键） |
| `narrative` | `id INTEGER CHECK(id=1)` | 单行叙事文本 |
| `persona_versions` | `id TEXT` | 人格版本 |
| `conflicts` | `id TEXT` | 冲突记录 |
| `snapshots` | `id TEXT` | 系统快照（data_json 存储完整状态） |
| `evolution_records` | `id TEXT` | 演化历史 |

**索引**：
- `idx_persona_status` — 按状态查询人格版本
- `idx_conflicts_resolved_at` — 查询未解决冲突
- `idx_snapshots_created_at` — 按时间查询快照
- `idx_memory_edges_target` — 反向查询记忆关联

**约束检查**：
- `weight` / `quota` / `salience` / `strength`：`CHECK(val >= 0 AND val <= 1)`
- `valence`：`CHECK(valence >= -1 AND valence <= 1)`
- `kind`：`CHECK(kind IN ('episodic', 'semantic', 'procedural'))`
- `status`：`CHECK(status IN ('active', 'paused', 'completed', 'failed'))`

### 事务保护

- 快照创建在单个事务内读取所有表，保证状态一致性
- 快照恢复在单个事务内清空并重写所有表，失败时自动回滚
- `IDatabase.transaction()` 封装了 `BEGIN/COMMIT/ROLLBACK` 语义

### Map 序列化

`ReadonlyMap` 类型在存储时通过自定义序列化处理：

```typescript
// 序列化：Map → JSON
mapToJson(map)    // { "__type": "Map", "entries": [...] }

// 反序列化：JSON → Map
jsonToMap(json)   // 恢复为 Map 实例
```

`deepStringify` / `deepParse` 支持嵌套 Map 的递归序列化。

---

## 依赖注入模式

系统通过构造函数注入三个核心接口，实现可测试性和可替换性：

### Clock

```typescript
interface Clock {
  now(): number;
}
```

| 实现 | 用途 |
|------|------|
| `realClock` | 生产环境，使用 `Date.now()` |
| `TestClock` | 测试环境，支持 `advance(ms)` 和 `set(ms)` |

### Logger

```typescript
interface Logger {
  debug(layer: string, message: string, data?: unknown): void;
  info(layer: string, message: string, data?: unknown): void;
  warn(layer: string, message: string, data?: unknown): void;
  error(layer: string, message: string, data?: unknown): void;
}
```

| 实现 | 用途 |
|------|------|
| `ConsoleLogger` | 生产环境，输出到控制台（可配置最低级别） |
| `SilentLogger` | 测试环境，静默捕获日志到 `entries` 数组 |

### IDatabase

```typescript
interface IDatabase {
  exec(sql: string): void;
  prepare<T>(sql: string): IPreparedStatement<T>;
  close(): void;
  transaction<T>(fn: () => T): T;
}
```

| 实现 | 用途 |
|------|------|
| `SqliteDatabase` | 生产环境，文件持久化 |
| `createMemoryDatabase()` | 测试/开发，内存数据库 |

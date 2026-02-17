# API 参考

## ChronoSynthOS — 主编排器

系统入口，协调三层架构和恢复/演化机制。

### 构造函数

```typescript
new ChronoSynthOS(config?: ChronoSynthOSConfig)
```

所有配置项可选，默认创建内存数据库、真实时钟和控制台日志。

### 公开属性

| 属性 | 类型 | 说明 |
|------|------|------|
| `bus` | `EventBus` | 系统事件总线 |
| `core` | `CoreRhythmLayer` | 慢层：核心价值、记忆、叙事 |
| `accelerated` | `AcceleratedLayer` | 快层：并行人格、模拟 |
| `meta` | `MetaRegulationLayer` | 元调控层：冲突、资源、集成 |
| `snapshots` | `SnapshotStore` | 快照持久化 |
| `evolution` | `EvolutionMerger` | 演化合并 |

### 生命周期方法

```typescript
// 启动系统，发射 system:started 事件
start(): void

// 停止系统（幂等），创建 shutdown 快照并清除事件监听
stop(): void

// 关闭数据库连接（幂等），自动调用 stop()
close(): void
```

### 快照与恢复

```typescript
// 创建系统快照（事务读取保证一致性）
createSnapshot(reason?: 'scheduled' | 'manual' | 'pre_evolution' | 'shutdown'): SystemSnapshot

// 从快照恢复系统状态（事务保护，失败回滚）
// 返回 true 表示恢复成功，false 表示快照不存在或恢复失败
restoreFromSnapshot(snapshotId: string): boolean
```

### 演化与调控

```typescript
// 运行演化周期：快照 → 合并最佳实验结果 → 快照
runEvolutionCycle(): {
  mergedCount: number;         // 合并的人格版本数
  beforeSnapshotId: string;    // 演化前快照 ID
  afterSnapshotId: string;     // 演化后快照 ID
}

// 运行调控周期：冲突检测 → 资源分配 → 写回人格配额
runRegulationCycle(allocationStrategy?: AllocationStrategy): void
```

### 便捷方法

```typescript
// 创建人格分支并运行模拟（一步完成）
forkAndSimulate(
  label: string,                // 人格标签
  scenario: SimulationScenario, // 模拟场景
  resourceQuota?: number,       // 资源配额，默认 0.2
): { personaId: string; fitnessScore: number }
```

---

## 慢层 — Core Rhythm Layer

### CoreRhythmLayer

```typescript
// 添加核心价值维度
addValue(label: string, weight: number): CoreValue

// 更新价值权重
updateValue(id: ValueId, weight: number): CoreValue | undefined

// 添加记忆节点
addMemory(kind: MemoryKind, content: string, valence: number, salience: number): MemoryNode

// 访问记忆（更新 lastAccessedAt）
accessMemory(id: string): MemoryNode | undefined

// 建立记忆间关联
linkMemories(source: string, target: string, relation: string, strength: number): MemoryEdge

// 更新身份叙事
updateNarrative(content: string): void

// 获取核心自我完整状态
getState(): CoreSelfState

// 从快照恢复价值（清空后重建）
restoreValues(values: ReadonlyMap<ValueId, CoreValue>): void

// 从快照恢复记忆和边（清空后重建）
restoreMemories(memories: ReadonlyMap<MemoryId, MemoryNode>, edges: readonly MemoryEdge[]): void
```

**子组件直接访问**：

| 属性 | 类型 |
|------|------|
| `values` | `ValueStore` |
| `memories` | `MemoryGraph` |
| `narrative` | `NarrativeStore` |

### ValueStore

```typescript
create(label: string, weight: number): CoreValue         // 创建价值（weight: 0-1）
updateWeight(id: ValueId, weight: number): CoreValue | undefined
getById(id: ValueId): CoreValue | undefined
getAll(): Map<ValueId, CoreValue>
delete(id: ValueId): boolean
deleteAll(): void
insert(value: CoreValue): void                           // 原始插入（恢复用）
```

### MemoryGraph

```typescript
addMemory(kind: MemoryKind, content: string, valence: number, salience: number): MemoryNode
accessMemory(id: MemoryId): MemoryNode | undefined       // 更新 lastAccessedAt
getMemory(id: MemoryId): MemoryNode | undefined           // 只读获取
getAllMemories(): Map<MemoryId, MemoryNode>
addEdge(source: MemoryId, target: MemoryId, relation: string, strength: number): MemoryEdge
getAllEdges(): MemoryEdge[]
getEdgesFor(id: MemoryId): MemoryEdge[]                   // 获取节点相关的所有边
deleteMemory(id: MemoryId): boolean                       // 级联删除关联边
deleteAll(): void
insertMemory(mem: MemoryNode): void                       // 原始插入（恢复用）
```

### NarrativeStore

```typescript
get(): string                   // 获取当前叙事
set(content: string): string    // 设置叙事，返回旧值
```

---

## 快层 — Accelerated Layer

### AcceleratedLayer

```typescript
// 从核心价值分叉出新人格版本
forkPersona(
  label: string,
  coreValues: ReadonlyMap<string, number>,
  resourceQuota?: number,         // 默认 0.2
): PersonaVersion

// 暂停/恢复人格
pausePersona(id: string): boolean
resumePersona(id: string): boolean

// 运行模拟
runSimulation(personaId: string, scenario: SimulationScenario): SimulationResult

// 在所有活跃人格上运行模拟
runOnAllActive(scenario: SimulationScenario): SimulationResult[]

// 标记人格为已完成
completePersona(id: string): boolean

// 查询
getActivePersonas(): PersonaVersion[]
getAllPersonas(): PersonaVersion[]

// 从快照恢复
restorePersonas(personas: readonly PersonaVersion[]): void
```

**子组件直接访问**：

| 属性 | 类型 |
|------|------|
| `personas` | `PersonaEngine` |
| `simulator` | `SimulationRunner` |

### PersonaEngine

```typescript
create(label: string, values: ReadonlyMap<string, number>, resourceQuota: number): PersonaVersion
setStatus(id: PersonaVersionId, status: PersonaStatus): boolean
addResult(id: PersonaVersionId, simResult: SimulationResult): boolean
setQuota(id: PersonaVersionId, quota: number): boolean
getById(id: PersonaVersionId): PersonaVersion | undefined
getActive(): PersonaVersion[]
getAll(): PersonaVersion[]
delete(id: PersonaVersionId): boolean
deleteAll(): void
insertRaw(persona: PersonaVersion): void              // 原始插入（恢复用）
```

### SimulationRunner

```typescript
// 运行单次模拟
run(persona: PersonaVersion, scenario: SimulationScenario): SimulationResult

// 批量运行多个场景
runBatch(persona: PersonaVersion, scenarios: readonly SimulationScenario[]): SimulationResult[]

// 静态工厂方法：创建模拟场景
static createScenario(description: string, params: Map<string, unknown>): SimulationScenario
```

**自定义评估函数签名**：

```typescript
type EvaluatorFn = (
  persona: PersonaVersion,
  scenario: SimulationScenario,
) => {
  fitnessScore: number;                    // 0-1
  valueAdjustments: Map<string, number>;   // 建议的价值调整
  insights: string[];                      // 洞察文本
};
```

---

## 元调控层 — Meta-Regulation Layer

### MetaRegulationLayer

```typescript
// 检测所有活跃人格之间的冲突
detectConflicts(personas: readonly PersonaVersion[]): void

// 从模拟结果生成集成提案
proposeIntegration(result: SimulationResult): IntegrationProposal

// 评估并执行集成决策
decideIntegration(
  proposal: IntegrationProposal,
  fitnessScore: number,
  coreLayer: CoreRhythmLayer,
): boolean

// 分配资源配额
allocateResources(
  personas: readonly PersonaVersion[],
  strategy?: AllocationStrategy,           // 默认 'equal'
): ResourceAllocation[]

// 解决指定冲突
resolveConflict(conflictId: string, resolution: string): boolean
```

**子组件直接访问**：

| 属性 | 类型 |
|------|------|
| `conflicts` | `ConflictResolver` |
| `integrator` | `IntegrationEngine` |
| `allocator` | `ResourceAllocator` |

### ConflictResolver

```typescript
// 检测价值分歧（阈值默认 0.3）
detectValueDivergence(
  personas: readonly PersonaVersion[],
  threshold?: number,
): Conflict[]

// 检测资源争用（配额总和 > 1.0）
detectResourceContention(personas: readonly PersonaVersion[]): Conflict | undefined

// 解决冲突
resolve(conflictId: string, resolution: string): boolean

// 查询
getUnresolved(): Conflict[]
getAll(): Conflict[]

// 从快照恢复
restoreConflicts(conflicts: readonly Conflict[]): void
```

### IntegrationEngine

```typescript
// 从模拟结果生成集成提案
propose(result: SimulationResult): IntegrationProposal

// 评估提案是否应被接受
evaluate(proposal: IntegrationProposal, fitnessScore: number): boolean

// 将已接受的提案应用到核心层（受 maxWeightDelta 限制）
apply(proposal: IntegrationProposal, coreLayer: CoreRhythmLayer): void
```

**配置 (IntegrationConfig)**：

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `minFitness` | `number` | `0.6` | 最低接受适应度 |
| `minConfidence` | `number` | `0.7` | 最低接受置信度 |
| `maxWeightDelta` | `number` | `0.1` | 最大单次权重调整幅度 |

### ResourceAllocator

```typescript
// 按策略分配资源配额（所有活跃人格配额总和 = 1.0）
allocate(
  personas: readonly PersonaVersion[],
  strategy?: AllocationStrategy,
): ResourceAllocation[]
```

**分配策略**：

| 策略 | 说明 |
|------|------|
| `'equal'` | 平均分配给所有活跃人格 |
| `'fitness_weighted'` | 按平均适应度分数加权 |
| `'priority_based'` | 按创建时间加权（越早创建优先级越高） |

---

## 恢复与演化

### SnapshotStore

```typescript
// 保存快照
save(snapshot: SystemSnapshot): void

// 加载快照
load(id: SnapshotId): SystemSnapshot | undefined

// 获取最新快照
getLatest(): SystemSnapshot | undefined

// 列出快照元数据
list(): Array<{ id: string; reason: string; createdAt: number }>

// 删除快照
delete(id: SnapshotId): boolean
```

### EvolutionMerger

```typescript
// 合并已完成人格的最佳实验结果到核心层
merge(
  completedPersonas: readonly PersonaVersion[],
  coreLayer: CoreRhythmLayer,
  metaLayer: MetaRegulationLayer,
): {
  mergedVersionIds: string[];
  valueDelta: Map<string, number>;
}

// 持久化演化记录
persistRecord(
  beforeSnapshotId: string,
  afterSnapshotId: string,
  mergedVersionIds: string[],
  valueDelta: Map<string, number>,
): EvolutionRecord
```

---

## 事件系统

### EventBus

继承自 `TypedEventEmitter<SystemEventMap>`，提供类型安全的事件发射和监听。

```typescript
const bus = new EventBus();

// 监听事件
bus.on('core:value-updated', (payload) => {
  console.log(payload.value.label, payload.value.weight);
});

// 单次监听
bus.once('system:started', (payload) => {
  console.log('系统启动于', payload.timestamp);
});

// 移除监听
bus.off('core:value-updated', handler);

// 发射事件
bus.emit('system:started', { timestamp: Date.now() });

// 查询监听器数量
bus.listenerCount('core:value-updated');

// 移除所有监听器
bus.removeAllListeners();
bus.removeAllListeners('core:value-updated');  // 仅移除指定事件
```

### TypedEventEmitter\<TMap\>

通用类型化事件发射器，可用于自定义事件映射。

```typescript
interface MyEvents {
  'user:login': { userId: string };
  'user:logout': { reason: string };
}

const emitter = new TypedEventEmitter<MyEvents>();
emitter.on('user:login', ({ userId }) => { /* ... */ });
```

---

## 存储

### SqliteDatabase

```typescript
// 创建文件数据库
const db = new SqliteDatabase('/path/to/data.db');
```

### createMemoryDatabase

```typescript
// 创建内存数据库（测试/开发）
const db = createMemoryDatabase();
```

### runMigrations

```typescript
// 初始化所有数据库表（幂等，CREATE IF NOT EXISTS）
runMigrations(db);
```

### IDatabase 接口

```typescript
interface IDatabase {
  exec(sql: string): void;
  prepare<T>(sql: string): IPreparedStatement<T>;
  close(): void;
  transaction<T>(fn: () => T): T;  // 自动 BEGIN/COMMIT/ROLLBACK
}
```

---

## 工具类

### ID 生成

```typescript
generateId(): string                          // UUID v4
generatePrefixedId(prefix: string): string    // 如 "snap-xxxx", "proposal-xxxx"
```

### 时钟

```typescript
// 真实时钟
const clock = realClock;
clock.now();  // Date.now()

// 测试时钟
const clock = new TestClock(1000);  // 初始时间 1000ms
clock.now();        // 1000
clock.advance(500); // 前进 500ms
clock.now();        // 1500
clock.set(3000);    // 设置为 3000ms
```

### 日志

```typescript
// 控制台日志（可配置最低级别）
const logger = new ConsoleLogger('info');  // 'debug' | 'info' | 'warn' | 'error'
logger.info('Core', '价值已更新', { id: 'xxx' });

// 静默日志（测试用，捕获到 entries 数组）
const logger = new SilentLogger();
logger.info('Core', '价值已更新');
console.log(logger.entries);
// [{ level: 'info', layer: 'Core', message: '价值已更新', data: undefined, timestamp: ... }]
```

---

## 类型定义速查

### 导入方式

```typescript
// 导入类
import { ChronoSynthOS, CoreRhythmLayer, AcceleratedLayer } from 'chrono-synth-os';

// 导入类型
import type {
  CoreValue,
  MemoryNode,
  MemoryEdge,
  MemoryKind,
  CoreSelfState,
  PersonaVersion,
  PersonaStatus,
  SimulationScenario,
  SimulationResult,
  Conflict,
  ConflictKind,
  ConflictSeverity,
  AllocationStrategy,
  ResourceAllocation,
  IntegrationProposal,
  SystemSnapshot,
  EvolutionRecord,
  SystemEventMap,
  SystemEventName,
} from 'chrono-synth-os';
```

### 数值约束汇总

| 字段 | 范围 | 说明 |
|------|------|------|
| `CoreValue.weight` | 0 - 1 | 价值重要性 |
| `MemoryNode.valence` | -1 - 1 | 情感色调 |
| `MemoryNode.salience` | 0 - 1 | 记忆重要性 |
| `MemoryEdge.strength` | 0 - 1 | 关联强度 |
| `PersonaVersion.resourceQuota` | 0 - 1 | 资源配额 |
| `SimulationResult.fitnessScore` | 0 - 1 | 适应度分数 |
| `IntegrationProposal.confidence` | 0 - 1 | 提案置信度 |
| `ResourceAllocation.quota` | 0 - 1 | 分配配额 |

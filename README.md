# ChronoSynth OS

**The governance layer for enterprise AI agents.**

When your team ships LangChain / CrewAI / OpenAI Agents SDK into production,
ChronoSynth OS is the backend that controls which tools each agent can call,
records every invocation to an immutable audit log, and detects when an
agent's behavior drifts from its policy baseline. Self-hosted via Helm or
run as SaaS — your data, your KMS keys, your audit retention.

> Why this exists, who it's for, what's in / out of scope: see
> [`.claude/gtm/01-pr-faq.md`](.claude/gtm/01-pr-faq.md).

The agent-governance product is built on top of a portable persona kernel
(`@chrono/kernel`, MIT) — a TypeScript domain core for persona identity,
memory graph, value alignment, and tool permissioning. The kernel is
runtime-agnostic (Node / Web Workers / Tauri / React Native via adapter
PoCs) and stays open-source as the reference implementation of the
Portable Persona Format v1 spec.

## Architecture

```
┌─────────────────────────────────────────────────┐
│   Agent governance surface (the product)        │
│  Tool permission · Audit log · Drift detector   │
│  Confirmation tokens · Per-tenant KMS · SCIM    │
├─────────────────────────────────────────────────┤
│   @chrono/kernel — portable persona core (OSS)  │
│  Identity · Memory graph · Value alignment      │
│  Decision engine · Persona drift baseline       │
├─────────────────────────────────────────────────┤
│   Storage adapters (Postgres + pgvector / SQL)  │
│   Event ledger · Outbox · KMS envelope crypto   │
└─────────────────────────────────────────────────┘
```

关键架构决策记录在 [`docs/adr/`](docs/adr/README.md)：内核零依赖、同步 UoW、字段级加密、MCP 工具协议、可移植 JSON-LD 包等。

## 快速开始

```bash
# 环境要求：Node.js >= 24.0.0
node -v  # 确认版本

# 安装依赖
npm install

# 编译
npm run build

# 运行全部测试（类型检查 + 编译 + 单元测试 + 集成测试）
npm run test:golden
```

## Observability Worker

仓库现在支持独立 `observability-worker` 进程，用于异步消费 `observability_outbox` 并聚合租户级 rollup 指标。镜像构建阶段会安装 `kafkajs`，因此 `OBS_KAFKA_ENABLED=true` 时可直接进入 Kafka 模式。

本地完整 Podman 拓扑已经收敛到同级仓库 `../chrono-synth-deploy` 的原生脚本入口，标准路径如下：

```bash
cd ../chrono-synth-deploy
cp podman/.env.example podman/.env
./deploy.sh podman build
./deploy.sh podman up
./scripts/e2e-test.sh
```

该路径会默认拉起：

- 前端控制台
- 后端 API
- PostgreSQL / Redis
- Redpanda
- 独立 `observability-worker`
- Prometheus / Grafana / Jaeger

若只想在宿主机验证 `direct` worker 模式，则直接在本仓库内构建并运行进程即可，不再维护旧的容器编排入口：

```bash
npm install
npm run build
node dist/main.js
# 新终端
node dist/main-observability-worker.js
```

worker monitor 默认暴露在 `http://localhost:3100`，详细运维说明见 [docs/observability-worker-runbook.md](docs/observability-worker-runbook.md)。

## Disaster Recovery

仓库内置了基础灾备脚本：

```bash
bash scripts/backup_db.sh
bash scripts/restore_db.sh ./backups/db/<file>
bash scripts/backup_storage.sh
```

完整说明见 [docs/disaster-recovery-runbook.md](docs/disaster-recovery-runbook.md)。

## Production Baseline

根目录 `k8s/` 中的清单已废弃，仅供本地参考（详见 [k8s/README.md](k8s/README.md)）。生产 K8s / Podman 编排统一由同级仓库 `../chrono-synth-deploy` 维护：

```bash
cd ../chrono-synth-deploy
# K8s
./deploy.sh secrets && ./deploy.sh build --push && ./deploy.sh k3s dev

# Podman
cp podman/.env.example podman/.env
./deploy.sh podman build && ./deploy.sh podman up
```

上线前请先阅读 [docs/production-readiness.md](docs/production-readiness.md)。

## 核心概念

### 三层架构

| 层级 | 职责 | 特性 |
|------|------|------|
| **慢层** (Core Rhythm Layer) | 维护核心价值、记忆图谱和身份叙事 | 稳定、持久、变化缓慢 |
| **快层** (Accelerated Layer) | 运行并行人格实验和适应度模拟 | 快速、实验性、可丢弃 |
| **元调控层** (Meta-Regulation Layer) | 检测冲突、分配资源、集成实验结果 | 仲裁、治理、平衡 |

### 恢复与演化

- **快照恢复**：事务保护的完整状态快照，支持系统崩溃后恢复
- **演化周期**：将已完成人格实验的最佳结果合并回核心层，驱动身份演进

## API 速览

```typescript
import { ChronoSynthOS, SimulationRunner, TestClock, SilentLogger } from 'chrono-synth-os';

// 创建系统实例（默认使用内存数据库）
const os = new ChronoSynthOS();
os.start();

// 1. 建立核心价值
const curiosity = os.core.addValue('curiosity', 0.7);
const honesty = os.core.addValue('honesty', 0.9);
os.core.updateNarrative('我是一个追求真理的数字人格');

// 2. 添加记忆
const mem1 = os.core.addMemory('episodic', '第一次探索', 0.8, 0.9);
const mem2 = os.core.addMemory('semantic', '知识库基础', 0.5, 0.7);
os.core.linkMemories(mem1.id, mem2.id, 'enriched_by', 0.6);

// 3. 创建人格分支并运行模拟
const scenario = SimulationRunner.createScenario(
  '高好奇心实验',
  new Map<string, unknown>([[curiosity.id, 1.0]]),
);
const { personaId, fitnessScore } = os.forkAndSimulate('Explorer-v1', scenario, 0.3);

// 4. 完成实验，运行调控和演化
os.accelerated.completePersona(personaId);
os.runRegulationCycle('equal');
const { mergedCount } = os.runEvolutionCycle();

// 5. 创建快照、恢复
const snap = os.createSnapshot('manual');
os.restoreFromSnapshot(snap.id);

// 6. 关闭系统
os.close();
```

## 配置选项

`ChronoSynthOSConfig` 所有字段均为可选：

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `db` | `IDatabase` | 内存 SQLite | 数据库实例 |
| `clock` | `Clock` | `realClock` | 时钟（测试时可注入 `TestClock`） |
| `logger` | `Logger` | `ConsoleLogger('info')` | 日志记录器 |
| `integrationConfig` | `Partial<IntegrationConfig>` | 见下 | 集成引擎配置 |
| `evaluator` | `EvaluatorFn` | 默认评估器 | 自定义模拟评估函数 |

**IntegrationConfig 默认值：**

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `minFitness` | `0.6` | 最低接受适应度 |
| `minConfidence` | `0.7` | 最低接受置信度 |
| `maxWeightDelta` | `0.1` | 最大单次权重调整幅度 |

## 类型系统

### 核心类型速查

| 类型 | 说明 | 关键字段 |
|------|------|---------|
| `CoreValue` | 核心价值维度 | `id`, `label`, `weight` (0-1) |
| `MemoryNode` | 记忆节点 | `kind`, `content`, `valence` (-1~1), `salience` (0-1) |
| `MemoryEdge` | 记忆关联 | `source`, `target`, `strength` (0-1), `relation` |
| `MemoryKind` | 记忆类型 | `'episodic' \| 'semantic' \| 'procedural'` |
| `CoreSelfState` | 核心自我状态 | `values`, `memories`, `edges`, `narrative` |
| `PersonaVersion` | 人格版本 | `label`, `values`, `status`, `results`, `resourceQuota` |
| `PersonaStatus` | 人格状态 | `'active' \| 'paused' \| 'completed' \| 'failed'` |
| `SimulationScenario` | 模拟场景 | `description`, `params` |
| `SimulationResult` | 模拟结果 | `fitnessScore` (0-1), `valueAdjustments`, `insights` |
| `Conflict` | 冲突记录 | `kind`, `severity`, `involvedVersions`, `affectedValues` |
| `ConflictKind` | 冲突类型 | `'value_divergence' \| 'resource_contention' \| 'narrative_inconsistency'` |
| `AllocationStrategy` | 分配策略 | `'equal' \| 'fitness_weighted' \| 'priority_based'` |
| `ResourceAllocation` | 资源分配 | `versionId`, `quota` (0-1), `strategy` |
| `IntegrationProposal` | 集成提案 | `sourceVersionId`, `valueChanges`, `confidence` (0-1) |
| `SystemSnapshot` | 系统快照 | `coreSelf`, `personas`, `activeConflicts`, `allocations` |
| `EvolutionRecord` | 演化记录 | `mergedVersionIds`, `valueDelta` |
| `SystemEventMap` | 事件类型映射 | 17 种类型化事件 |

## 项目结构

```
chrono-synth-os/               # monorepo 根
├── packages/                  # 可移植跨运行时包
│   ├── contracts/             # @chrono/contracts — 类型、Zod schema、文案字典、设计 token
│   ├── kernel/                # @chrono/kernel — IDatabase 抽象、UnitOfWork、query executor
│   ├── kernel-testkit/        # @chrono/kernel-testkit — 测试工具：内存 DB、迁移助手
│   ├── data-plane/            # @chrono/data-plane — 平台密钥解析器等数据层接口
│   ├── sync-engine/           # @chrono/sync-engine — deriveRuntimeSyncState 纯状态机
│   └── design-tokens/         # @chrono/design-tokens — chronoDesignTokens（颜色/间距/字型）
├── apps/
│   ├── desktop/               # Electron/Tauri 桌面端（SyncStatusBadge、本地加密）
│   └── mobile/                # React Native 移动端（RuntimeSyncBadge、离线队列）
├── src/                       # 后端主服务
│   ├── core/                  # 慢层：核心价值、记忆图谱、叙事
│   ├── accelerated/           # 快层：并行人格、模拟引擎
│   ├── meta/                  # 元调控层：冲突、资源、集成
│   ├── recovery/              # 快照恢复与演化合并
│   ├── server/                # Fastify HTTP 服务（路由、插件、API v1/v2）
│   ├── data-plane/            # SQLite 事件账本、双写 flush worker
│   ├── enterprise/            # KMS 客户端、信封加密、密钥审计
│   ├── storage/               # 数据库抽象、迁移、字段级加密
│   ├── test/
│   │   ├── unit/              # 单元测试（79 个文件）
│   │   ├── integration/       # 集成测试（25 个文件）
│   │   └── contract/          # 路由 schema 快照测试
│   ├── main.ts                # 后端主入口
│   ├── main-observability-worker.ts
│   └── index.ts               # 公开 API 入口
├── scripts/
│   ├── check-forbidden-imports.sh
│   ├── rollback-dual-write.ts
│   └── backup_db.sh / restore_db.sh / backup_storage.sh
├── docs/
│   ├── observability-worker-runbook.md
│   ├── disaster-recovery-runbook.md
│   └── production-readiness.md
└── k8s/                       # ⚠️ 已废弃，见 k8s/README.md
```

## 脚本命令

| 命令 | 说明 |
|------|------|
| `npm run build` | TypeScript 编译 |
| `npm run typecheck` | 类型检查（不生成产物） |
| `npm run test:unit` | 运行单元测试（~756 个） |
| `npm run test:integration` | 运行集成测试（~214 个） |
| `npm run test:contract` | 运行路由 schema 快照测试 |
| `npm run test:packages` | 运行所有 packages/ 包测试 |
| `npm run test:ops` | 运行运维脚本 smoke 测试 |
| `npm run test` | 运行全部测试 |
| `npm run test:golden` | 完整验证（类型检查 + 编译 + 全部测试） |
| `npm run check:forbidden-imports` | 扫描禁止的跨层导入（IDatabase 泄漏等） |
| `npm run start` | 启动后端主服务 |
| `npm run start:observability-worker` | 启动独立 observability worker |

## 技术栈

- **运行时**：Node.js >= 24.0.0
- **语言**：TypeScript 5.9 (strict, ES2024)
- **数据库**：SQLite（本地/测试） + PostgreSQL（生产/多副本）
- **测试**：`node:test`（Node.js 内置）
- **运行时依赖**：Fastify / PostgreSQL / Redis / Kafka / Stripe / OpenTelemetry

## 许可证

MIT

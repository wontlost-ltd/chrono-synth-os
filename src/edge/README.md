# src/edge — 端侧自治（Edge autonomy）

让 zero-LLM 人格内核在**非 Node runtime 端侧**运行（ADR-0052 Edge 路线）。这是「可植入机器人 /
Edge 设备」产品的技术地基：云 LLM 当老师训练 → 蒸馏出确定性人格 → 植入设备独立运行。

## 模块结构

| 目录 | 内容 | Phase |
| --- | --- | --- |
| `host/` | 端侧确定性 host adapter：`DeterministicClock`/`DeterministicRandom`（零 node:*）+ `InMemoryValueUnitOfWork`（纯 Map 实现 kernel value 域 query/command，语义对齐真实 SQL/adapter-web executor） | Edge-P2 |
| `kernel-runtime-proof.ts` | 用端侧 adapter 驱动**真实 kernel value-service** 跑确定性闭环 + golden replay | Edge-P2 |
| `json-clone.ts` | edge 本地 JSON 深拷贝 util（payload JSON 安全；非全仓库通用） | — |
| `sync/` | 端侧持久化（`EdgePersistence`）+ `SyncOutbox`（deviceId+单调 seq）+ `resolveConflict` 冲突三分法 | Edge-P3 |
| `growth/` | `GrowthJobQueue` 离线成长队列 + `TeacherJobRunner`（联网批量消费，失败隔离不阻断 runtime） | Edge-P4 |

相关：`src/perception/environment`（Edge-P1 确定性环境感知）、`src/perception/media`（Edge-P5 媒体
引用 + GDPR）、ADR-0052（Edge 路线）、ADR-0053（固件子集规格 Edge-P6）。

## 核心不变量

- **zero-LLM 运行时**：端侧 runtime 只靠确定性核（kernel value/rule/环境状态），绝不调多模态/LLM。
- **身份核绝不自动改**：多设备冲突中身份核（value/narrative/规则）变更 → pending 人工审批，
  绝不 last-write-wins（`resolveConflict`）；`classifyOpKind` 用真实 kernel op 前缀防误标。
- **teacher 不阻断 runtime**：teacher job 只在联网/成长阶段跑，失败隔离（`TeacherJobRunner`）。
- **确定性可回放**：host adapter 确定性 + golden replay（为未来 WASM/MCU 回放打基础）。
- **零 node:***：`host/` adapter 零 node:* import（ratchet 锁住），可移植到 Web Worker/RN/Tauri。

## 证明边界（诚实）

本目录是 **Node-hosted source-level 可移植性证明**——adapter 零 node:* + kernel zero-dep
contract + 真实 value-service 确定性闭环。**还不是**完整 Web Worker/browser runtime proof
（未经 bundler/Worker global/真非 Node 引擎加载）。

## 已知边界 / 登记债（收口审查收拢）

### 合理工程边界（部署 / 独立工程，非本仓库技术债）
- **真 Web Worker harness**：浏览器端真实加载 kernel（vite/worker 打包基建）——Edge-P2 的延伸。
- **真对象存储 driver**（S3/R2/minio）：`ObjectStorageEraser` 接口已就绪，driver 部署期接入。
- **真 MCU firmware**：Rust/C/RTOS 跨工具链工程（ADR-0053 规格已定）。
- **独立 `'perception'` artifact source + `perception_events` 落库**：待感知层 Phase 推进。

### 已知技术债（低优先，可接受）
- `deep clone` / `fromSerialized` 校验 / 状态机在各 edge 模块各一套——经评估**不抽象**（语义边界
  不同，DRY 反损可读；deep clone 已抽 `json-clone.ts`）。
- `DELETE_ALL.rowsAffected` cross-adapter 不统一（SQL=0 vs adapter-web=count）——既有，无人用返回值。

### 待产品决策（非技术债）
- BYOK fallback opt-out（「所有流量必须用租户 key」vs「优先用租户 key」）。
- 租户是否允许配置 `base_url`（若开放须先有 SSRF allowlist + 已加的「自定义 endpoint 不继承平台 key」门）。
- perception BYOK provider 配额、媒体 retention class 用户语义、firmware 路线选型（WASM vs Rust 重写）。

## 序列化版本

`SyncOutbox` / `GrowthJobQueue` / `InMemoryValueUnitOfWork` 的 serialize 都带 `schemaVersion`
（当前 1）。不兼容格式变更须升版本 + 迁移；fromSerialized 拒绝未知版本（早期无版本落盘视为 v1）。

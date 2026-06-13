# 0053 — Embedded firmware persona subset spec (Edge-P6)

**Status:** Accepted (spec only — firmware itself is a separate cross-toolchain project)
**Date:** 2026-06-14
**Scope:** 规格文档（不含固件实现）。informed by Edge-P2..P5（PR #102–#105）的真实证明。
**Relates to:** [0001](0001-kernel-zero-runtime-deps.md)（kernel zero-deps），
[0047](0047-llm-as-distillable-teacher.md)（zero-LLM 运行时），
[0052](0052-edge-autonomy-and-perception-phase-rerank.md)（Edge 路线 + Phase 重排）。

## Context（背景）

ADR-0052 把 Edge 路线分为三层：端侧 app 自治（A）> Edge 计算盒子（B）> 嵌入式固件（C）。
C 层（机器人 MCU/SoC/RTOS 上直接跑人格子集）是「可植入机器人」的真正终态，但**最远**：
当前 kernel 是 TypeScript/ESM portable JS，**不是**可直接编译到 MCU 的 Rust/C core；MCU 还有
功耗、内存、实时性、flash wear、secure boot、硬件 RNG/AES 等强约束。

backend 研究（`.ccg/tasks/edge-robot-productization/research/`）明确：C 层应**等 A/B 层证明
「哪些人格能力真的需要在设备上运行」后，再做裁剪规格**。Edge-P2..P5 已提供这个证明基础：

- **Edge-P2**：kernel 领域逻辑（value-service）能在非 Node 端侧 adapter 上**确定性运行**+
  golden replay——证明「确定性人格状态机可移植」。
- **Edge-P3**：端侧持久化 + outbox + 冲突三分法——证明「本地状态 + 同步边界」的最小集。
- **Edge-P4**：teacher 只在联网/成长跑、失败隔离不阻断 runtime——证明「runtime 不依赖 teacher」。
- **Edge-P5**：媒体引用元数据 + 对象存储（原始媒体绝不进设备主存）——划清「设备不该存什么」。

本 ADR 据此**定义固件人格子集规格**（Edge-P6）——哪些进 MCU 首版固件，哪些**不进**。
本 ADR 是规格，**不含固件实现**：真实 firmware 是独立的 Rust/C/RTOS 跨工具链工程，超本仓库。

## Decision（决策）：固件人格子集（MCU 首版只承载 deterministic reflex subset）

固件人格 = **deterministic reflex co-processor**：承载人格的偏好与本地反射，从完整人格 runtime
同步而来。它**不是**完整人格成长引擎。承诺 bounded autonomous loop，不承诺完整成长。

### 进固件首版（IN — 确定性、定长、低功耗）

「来源」分两类：**[已证明]** = Edge-P2..P5 / ADR-0047 已在本仓库实现并验证的能力；
**[新规格]** = 本 ADR 据已证明能力推断的 firmware-local 规格，**待固件工程验证**（非已实现事实）。

| 能力 | 来源 | MCU 形态 |
| --- | --- | --- |
| **核心 value 权重（只读快照）** | [已证明] Edge-P2 value-service 确定性运行 | 定长 struct 数组，从云/盒子同步，固件期只读用于打分 |
| **规则引擎子集（if-then）** | [已证明] ADR-0047 rule-engine（zero-LLM 离线决策） | 定长规则表 + 关键词匹配，无动态 schema |
| **确定性环境状态机** | [已证明] ADR-0052 Edge-P1（光/声/运动确定性提取 + 滞回） | 传感器 ISR → 低维状态（dark/quiet/still…），定点运算 |
| **决策节律（注意力/打扰阈值/低功耗）** | [新规格] MCU 版 deterministic attention/power 状态机（**非 Edge-P1 已实现**——P1 只做环境感知→记忆，未碰节律集成；本条是固件待建规格） | 状态机：是否提示/记录/进低功耗 |
| **短期记忆摘要（ring buffer）** | [新规格] 借鉴 Edge-P3 append-only 语义，但 MCU 定长 ring buffer 是新规格（P3 是 JS Map/序列化，非 ring buffer） | 定长 ring buffer（littlefs-backed），覆盖最旧 |
| **本地 append-only 事实事件 + outbox** | [已证明] Edge-P3 outbox（device+单调 seq+冲突三分法）语义 | 定长 outbox，联网时上送，溢出背压 |
| **compiled persona snapshot loader（安全加载）** | [新规格] 固件安全必需 | 加载云/盒子下发的已编译人格快照时：**验签**（防篡改）+ **版本单调**（epoch 不回退）+ **防回滚**（拒绝旧版本快照）；无硬件 secure boot 时安全等级须标注 |

### 不进固件首版（OUT — 留在云/盒子）

| 能力 | 为何不进 | 留在 |
| --- | --- | --- |
| 完整 memory graph（边/salience 衰减/检索） | 动态结构 + 浮点衰减，MCU 内存/算力不支持 | 盒子/云 |
| distillation + update gate + 蒸馏候选审批 | 改身份核须 gate + snapshot + rollback，复杂 | 盒子/云（ADR-0047） |
| 多模态 teacher（LLM/视觉/ASR） | 绝不进 runtime（ADR-0051/0052），更不进 MCU | 云/盒子（Edge-P4 离线成长） |
| 冲突解决 + 跨设备身份核合并 | 身份核冲突须 pending 人工审批（Edge-P3） | 盒子/云 |
| 原始媒体 / 媒体引用 + 对象存储 | 原始媒体绝不进设备主存（Edge-P5 红线） | 对象存储 |
| audit chain / 完整 GDPR **导出** + 跨系统擦除编排 | 重，且需持久审计存储 | 云 |
| 身份核**写入**（value/narrative/规则的成长变更） | 成长经 gate 在盒子/云完成，固件只同步已编译结果 | 盒子/云 |

**注（隐私合规边界，Codex 复审）**：「GDPR 导出/擦除编排 OUT」**不等于**固件不删本地 PII——
固件**必须**提供**本地擦除 / 出厂重置**：清空 ring buffer 短期记忆、value 快照、outbox 待同步
事实、本地密钥。即「完整 GDPR 工作流（导出报告/跨系统编排）在云，但设备本地 PII 的物理擦除是
固件必备能力」。被遗忘权要求设备上的人格数据也能被抹除。

### 固件 host adapter 规格（对照 ADR-0001 ports）

| port | MCU 实现 |
| --- | --- |
| `KernelClock` | 单调 tick + RTC 校准（不假设 wall clock 正确） |
| `KernelRandom` | 硬件 RNG；无则 seed 管理（安全等级下降，须标注） |
| `KernelEventStore` | append-only ring buffer / littlefs log（断电一致） |
| `KernelProjectionStore` | 定长 KV（value 快照 + 环境状态） |
| `KernelCrypto` | 硬件 AES/Hash 或 mbedTLS/tinycrypt |
| `KernelLogger` | stub 或定长本地诊断 ring（无远程日志；audit 在云） |
| `EventPublisher` / `EventSubscriber` | 替代为固件内事件队列（无 node:events）；跨设备发布经 outbox 上送，不在固件做 pub/sub fanout |
| `UnitOfWork`（read/write） | 固件用同步定长 UoW 包装 ring buffer/KV（无动态事务；写失败即丢弃当帧，断电一致由 littlefs 保证） |
| sensor → feature | 中断采样**不跑人格逻辑**，只推低维事件队列（ISR → feature queue） |

## Consequences（后果）

**正面**：
- 固件子集边界清晰：[已证明] 条目有 Edge-P2..P5 / ADR-0047 的真实实现背书，[新规格] 条目据
  已证明能力推断、待固件工程验证——不是凭空裁剪。
- 确定性 + 定长 + 无动态 schema/JSON/通用 query registry → 适配 MCU 约束。
- zero-LLM 论点在 MCU 上达到极致：纯确定性反射，无任何模型，断网断云仍运行 bounded loop。

**负面 / 红线**：
- 固件**只读身份核快照**，绝不在 MCU 上做身份核成长（成长经 gate 在盒子/云）。
- 浮点确定性跨 JS↔WASM↔native↔MCU 需 golden replay 验证（Edge-P2 的 golden 是基础）。
- 真实 firmware 需 flash wear leveling / 断电一致 / secure boot / OTA rollback / 硬件 crypto——
  这些是 **MCU 工程**，本 ADR 不覆盖实现。
- TS kernel → MCU 路径未定（AssemblyScript/QuickJS WASM vs Rust/C 重写 deterministic subset）——
  作为固件工程的首要技术选型，超本仓库范围。

## Status of Edge route（路线收尾）

ADR-0052 的 Edge 路线 Phase 状态：
- ✅ **Edge-P1**（确定性环境感知，PR #101）
- ✅ **Edge-P2**（非 Node kernel runtime proof，PR #102）
- ✅ **Edge-P3**（端侧持久化 + 同步边界，PR #103）
- ✅ **Edge-P4**（离线成长队列 + teacher job，PR #104）
- ✅ **Edge-P5**（媒体引用 + retention + GDPR，PR #105）
- 📄 **Edge-P6**（固件裁剪规格，本 ADR）——规格完成；真实固件是独立跨工具链工程。

所有**可在本仓库本地验证**的 Edge Phase 已实现并合并；纯硬件/跨工具链工作（真浏览器
Worker harness、真对象存储 driver、真 MCU firmware）诚实划为部署/独立工程，规格已定。

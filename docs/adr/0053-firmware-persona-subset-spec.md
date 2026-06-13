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

| 能力 | 来源（已证明） | MCU 形态 |
| --- | --- | --- |
| **核心 value 权重（只读快照）** | Edge-P2 value-service（确定性） | 定长 struct 数组，从云/盒子同步，固件期只读用于打分 |
| **规则引擎子集（if-then）** | ADR-0047 rule-engine（zero-LLM） | 定长规则表 + 关键词匹配，无动态 schema |
| **确定性环境状态机** | ADR-0052 Edge-P1（光/声/运动确定性提取 + 滞回） | 传感器 ISR → 低维状态（dark/quiet/still…），定点运算 |
| **决策节律（注意力/打扰阈值/低功耗）** | core-rhythm（确定性） | 状态机：是否提示/记录/进低功耗 |
| **短期记忆摘要（ring buffer）** | Edge-P3 持久化（append-only 事实） | 定长 ring buffer（littlefs-backed），覆盖最旧 |
| **本地 append-only 事实事件 + outbox** | Edge-P3 outbox（device+单调 seq） | 定长 outbox，联网时上送，溢出背压 |

### 不进固件首版（OUT — 留在云/盒子）

| 能力 | 为何不进 | 留在 |
| --- | --- | --- |
| 完整 memory graph（边/salience 衰减/检索） | 动态结构 + 浮点衰减，MCU 内存/算力不支持 | 盒子/云 |
| distillation + update gate + 蒸馏候选审批 | 改身份核须 gate + snapshot + rollback，复杂 | 盒子/云（ADR-0047） |
| 多模态 teacher（LLM/视觉/ASR） | 绝不进 runtime（ADR-0051/0052），更不进 MCU | 云/盒子（Edge-P4 离线成长） |
| 冲突解决 + 跨设备身份核合并 | 身份核冲突须 pending 人工审批（Edge-P3） | 盒子/云 |
| 原始媒体 / 媒体引用 + 对象存储 | 原始媒体绝不进设备主存（Edge-P5 红线） | 对象存储 |
| audit chain / 完整 GDPR 导出擦除 | 重，且需持久审计存储 | 云 |
| 身份核**写入**（value/narrative/规则的成长变更） | 成长经 gate 在盒子/云完成，固件只同步已编译结果 | 盒子/云 |

### 固件 host adapter 规格（对照 ADR-0001 ports）

| port | MCU 实现 |
| --- | --- |
| `KernelClock` | 单调 tick + RTC 校准（不假设 wall clock 正确） |
| `KernelRandom` | 硬件 RNG；无则 seed 管理（安全等级下降，须标注） |
| `KernelEventStore` | append-only ring buffer / littlefs log（断电一致） |
| `KernelProjectionStore` | 定长 KV（value 快照 + 环境状态） |
| `KernelCrypto` | 硬件 AES/Hash 或 mbedTLS/tinycrypt |
| sensor → feature | 中断采样**不跑人格逻辑**，只推低维事件队列（ISR → feature queue） |

## Consequences（后果）

**正面**：
- 固件子集边界清晰，且**每条都有 Edge-P2..P5 的真实证明背书**（不是空想裁剪）。
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

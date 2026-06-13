# 0052 — Edge/on-device autonomy route, and perception Phase rerank

**Status:** Accepted (route + Phase-1 of Edge)
**Date:** 2026-06-14
**Scope:** `packages/kernel`（portability thesis），`src/perception`（环境感知旁路），
产品路线（apps/ 端侧自治）。
**Relates to:** [0001](0001-kernel-zero-runtime-deps.md)（kernel zero-deps，端侧可移植地基），
[0047](0047-llm-as-distillable-teacher.md)（zero-LLM 运行时），
[0051](0051-external-perception-as-sensory-teacher.md)（感知层；本 ADR 重排其 Phase）。

## Context（背景）

目标：把 ChronoSynth 数字人格升级为**可植入机器人 / Edge 设备**产品。这是 zero-LLM
论点（ADR-0047）的**终极兑现**——若人格运行时依赖云 LLM 则无法真正植入设备（断网即失能）；
只有确定性内核才能 Edge 化：**云 LLM 当老师训练 → 蒸馏出确定性人格 → 植入设备独立运行**。

双模型研究（`.ccg/tasks/edge-robot-productization/research/`）取证后两个独立视角收敛：

1. **kernel 可移植性是「架构承诺」而非「已证明」**：`packages/kernel` 零 npm 依赖、零
   `node:*` import、已有 ports/host-adapters 架构（Clock/Random/Crypto/EventStore/
   ProjectionStore/UnitOfWork 全可注入）。但**没有任何 app 在非 Node runtime 加载 kernel**。
   现状准确说法是 **portable JS kernel，不是 WASM kernel**（不可过早宣称）。
2. **三层 Edge 目标优先级**：端侧 app 自治（最近、复用 apps/）→ Edge 计算盒子（树莓派/Jetson）
   → 嵌入式固件（MCU/RTOS，最远）。
3. **感知层 Phase 优先级需重排**（见下）。

## Decision（决策）

### 一、Edge 路线 = 端侧自治优先

产品 MVP **不从机器人硬件/MCU 开始**，从**端侧 app 自治**开始（手机/桌面离线跑人格核）。
验收命题：「当网络断开时，用户是否仍相信『这个人格在我的设备里，并属于我』？」机器人/Edge
盒子只是未来 host，不是首版定义。这能用零硬件依赖证明「人格是可携带、可离线、可拥有的资产」。

### 二、感知层 Phase 重排（Edge 目标下）

ADR-0051 原 Phase 顺序是「云感官老师摄取」路线（适合 C 端短音频成长），不适合 Edge/机器人
运行时。Edge 的最低可用闭环是：**传感器采样 → 端侧确定性 feature extraction → 环境状态 →
影响人格 → 本地持久化 → 可选同步**。云多模态对此闭环不必需甚至矛盾（依赖网络、最敏 PII、
断网失明、不能当 runtime sense）。故重排：

| Edge 优先级 | 内容 | 对应 ADR-0051 原 Phase |
| --- | --- | --- |
| **Edge-P1（本 ADR 落地）** | 确定性环境感知旁路（光/声/运动低维信号纯确定性提取 → 环境状态 → 事实记忆） | Phase 4 **提前** |
| Edge-P2 | Non-Node kernel runtime proof（Web Worker 加载 kernel + 端侧 adapter + golden replay） | 新（ADR-0001 兑现） |
| Edge-P3 | 端侧持久化 + 云同步边界（本地 event/projection store、outbox、冲突解决） | Phase 3 部分 |
| Edge-P4 | 云/本地多模态老师作为离线**成长**通道（非 runtime sense） | Phase 2 **推迟** |
| Edge-P5 | 原始媒体引用/retention/GDPR/对象存储（默认 process-and-delete） | Phase 3 余项 |
| Edge-P6 | 嵌入式固件裁剪版（从 A/B 层观测裁剪 deterministic subset） | 新 |

### 三、Edge-P1 实现：确定性环境感知旁路（本 ADR）

`src/perception/environment/`（与感知层同 bounded context）：

- **`EnvironmentSignalExtractor`**：纯确定性 DSP——输入光强/声压/运动等时间序列样本 →
  窗口聚合（rolling avg/peak/min）+ 阈值分级（如 dim/normal/bright、quiet/moderate/noisy）
  + **去抖滞回**（hysteresis，防状态在阈值边界抖动）+ 置信度 → 输出低维 `EnvironmentState`。
  **零 LLM、零硬件、零外部依赖**——输入是数组，golden 可验证。
- **`EnvironmentObserver`**：把环境**状态变化**（如 room_became_quiet）写为事实记忆
  （episodic，第一人称「环境变安静了」），**复用 ADR-0051 Phase 1 安全范式**——
  只 append 事实记忆，**绝不自动改身份核**（value/narrative/L0-L3/规则）。

### 不变量（与 ADR-0047 / ADR-0051 一致）

1. **runtime sense 只接受确定性低维 feature**——绝不在 runtime 同步调多模态 provider。
2. 环境感知**不调 LLM、不上传媒体、不依赖硬件**；输入是采集层（client/edge）给的信号样本。
3. 环境状态变化只 **append 事实记忆**，绝不自动改身份核（节律/注意力集成是后续，不在本切片）。
4. 去抖滞回保证状态稳定（不因单个噪声样本翻转）。确定性契约 = `extract(lastLevel, samples)`：
   **同初始滞回状态 + 同输入序列 → 同输出**（滞回的跨窗状态依赖是必要特性，golden replay 须从
   同一初始态或先 `reset()`）——为未来 WASM/MCU 确定性回放打基础。

## Consequences（后果）

**正面**：
- Edge 核心论点获得本地可验证的真实证明：**人格能在端侧无云无 LLM 确定性感知环境并沉淀记忆**。
- 复用感知层 Phase 1 的「事实→记忆，不改身份核」安全范式，架构连续、零新核心机制。
- 纯确定性 → golden replay → 为未来 WASM/MCU 的确定性回放打基础。

**负面 / 红线**：
- 现状是 portable JS kernel，**不宣称 WASM kernel**（Edge-P2 才证明 non-Node runtime）。
- 环境信号「喂节律/注意力」是更深集成——本切片**不碰** CoreRhythmLayer 核心写路径（红线一致）。
- 真实传感器硬件接入（GPIO/USB/ALSA）是 Edge 盒子阶段（Edge-P3+），本切片只吃 fixture/采集层信号。

## Product framing（产品定位）

C 端叙事：「这是一个你能拥有的数字人格。它可以在云端学习，但不依赖云端活着。」
对外一句话：「大模型负责教会它，ChronoSynth 负责把学到的东西沉淀成你能拥有、能离线运行、
能植入设备的人格。」完整产品/架构研究见 `.ccg/tasks/edge-robot-productization/research/`。

# 0051 — External perception is a sensory teacher, not a runtime sense

**Status:** Accepted (Phase 1)
**Date:** 2026-06-13
**Scope:** `src/perception` (new bounded context), `packages/kernel`
(core-self distilled-artifact source), reuses `src/intelligence`
(DistillationService), `src/core` (memory-graph)
**Relates to:** [0047](0047-llm-as-distillable-teacher.md)（LLM 是可蒸馏的老师），
[0001](0001-kernel-zero-runtime-deps.md)（kernel zero runtime deps），
[0046](0046-dual-product-companion.md)（ChronoCompanion C 端）。

## Context（背景）

用户要求给数字人格添加「外部感知层——光、波、音视频等」，并澄清意图为
**多模态内容理解**：让人格能真正「看懂视频、听懂音频」（语义级），而非仅采集
低维环境信号。

这一需求与项目最核心的论点直接碰撞：

- ADR-0047 确立 **zero-LLM 运行时论点**——数字人运行时不靠 LLM 做决策；LLM 只是
  「可蒸馏的老师」，喂成长后被蒸馏进确定性内核。
- 但「理解一段音视频在说什么」无法用确定性算法做到，必然需要多模态大模型。

若把多模态模型接成「人格每次感知/对话时实时推理」，论点就被架空——人格变成
「其实靠多模态模型实时运行」。这是必须避免的论点漂移。

## Decision（决策）

**多模态模型是「感官老师」（sensory teacher），不是人格的运行时感官。** 它只在
**摄取/成长阶段**被调用一次，把音视频翻译成结构化感知分析；该分析**整体视为不可信**，
经硬校验后才可能沉淀为记忆/成长候选，绝不直接进确定性核。运行时人格仍只依赖已沉淀的
记忆/规则/确定性状态——对话引用感知记忆时**不再调用**多模态老师。

这把感知层完全纳入 ADR-0047 已确立的「老师 → 蒸馏门 → 确定性核」范式，与
`LlmReflectionDistiller` 同构：

```
媒体表征(transcript/关键帧)  ← 采集层(client/edge)，原始媒体不进业务流
  → PerceptionProvider.analyze()        感官老师，不可信输出
  → PerceptionDistiller                 硬校验 + 编排（不写核心状态）
      ├─ 事实型观察 → memory graph（episodic/semantic 记忆，append-only，低风险）
      └─ 身份层提案 → DistillationService.ingest → core-update-gate
            · value_shift：delta 封顶 0.05 + patternAgrees=false → 必 pending
            · narrative_patch：改「我是谁」→ 默认 pending 人工审批
  → 确定性核（运行时不再调老师）
```

### 不变量（与 ADR-0047 D3 一致）

1. `PerceptionDistiller` 绝不调 `CoreRhythmLayer` / value-store / narrative-store 等
   核心写方法；只经 memory graph append + `DistillationService.ingest`（后者经
   `core-update-gate` 把关）。
2. 老师的 value_shift 提案 delta **封顶**到自动门上限（0.05）且 `patternAgrees=false`
   （感知是单源，不冒充确定性 pattern-extractor 的交叉验证）→ 故感知单源的 value_shift
   **永远 pending**，不会被自动改 value。
3. 身份层（narrative/value）变更默认人工审批；只有事实型记忆 append 是自动的。
4. 老师抛错 / 分析畸形 / 空表征 → 安全降级为「未产记忆」，绝不抛进调用方主流程。
5. `DecisionEngine` / `RuleEngine` / `CoreRhythmLayer` 运行时**绝不**同步依赖多模态 provider。

## Phasing（分阶段）

本 ADR 当前落地 **Phase 1**（论点兼容性的真实证明，零外部依赖、本地可验证）：

- `src/perception/`：`PerceptionProvider` 契约 + `MockPerceptionProvider`（确定性、可测、
  无需外部 key）+ `PerceptionDistiller`。
- 蒸馏候选 source **暂复用 `'knowledge_import'`**（感知 provenance 体现在记忆内容第一人称
  「我听到/我看到」+ evidence 指向真实记忆 id）。**刻意不**为一个 provenance 标签触发
  `distilled_artifacts.source` CHECK 约束的 SQLite table-rebuild migration——独立
  `'perception'` source 待 Phase 3 落 `perception_events` 表时随 migration 一并引入。

后续阶段（未实现，登记）：

- **Phase 2**：BYOK perception provider（用户自带多模态 key，沿用 BYOK fail-closed 语义）+
  配额（perception_minutes/frames）+ 真实云/本地 ollama-llava provider。
- **Phase 3**：`perception_events` / `perception_media_refs` 落库 + GDPR 导出/擦除 +
  对象存储引用 + retention worker + 引入 `'perception'` artifact source。
- **Phase 4**：确定性环境旁路（光强/声压等低维信号纯确定性提取 → 环境状态喂节律，无 LLM）。
- **Phase 5**：实时流（分片/websocket，异步处理不阻塞决策主循环）。

## Consequences（后果）

**正面**：

- zero-LLM 论点**完整保住**——多模态模型是老师不是运行时感官；离线时人格仍靠已沉淀的
  感知记忆回应。市场叙事自洽：「Train with models, run as your owned persona」。
- 感知层是独立 bounded context（`src/perception/`），不污染 conversation 同步路径、
  不膨胀 CoreRhythmLayer。
- 复用既有蒸馏门 + memory graph，零新核心机制；身份类变更默认审批，防多模态幻觉污染内核。

**负面 / 红线**：

- 原始音视频是最敏感 PII，**绝不进主库**（Phase 3 对象存储引用 + process-and-delete）。
- 不存人脸/声纹生物模板（除非另开合规 ADR）。
- 多模态推理成本高（Phase 2 配额 + 上传前 duration/size 上限 + 异步 job）。
- 第一阶段**不做** getUserMedia / 实时流 / 硬件 / 多人会议 / 自动改写身份。

## Product framing（产品定位，来自 ADR-0046 C 端）

首版产品落点是 C 端 ChronoCompanion 短音频：用户「让 TA 听一段」，人格用第一人称
「我听到 / 我理解 / 我准备记住」反馈，用户确认后写入 episodic memory，后续对话自然引用。
产品价值不是「音视频分析工具」，而是给人格**可审阅、可删除、可蒸馏的经历来源**——
从「我告诉你」到「你陪我经历过」。完整产品/UX 分析见
`.ccg/tasks/add-perception-layer/research/frontend-analysis.md`，
架构分析见 `backend-analysis.md`。

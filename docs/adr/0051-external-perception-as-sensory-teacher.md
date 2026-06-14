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
经硬校验后才可能沉淀为记忆/成长候选，**绝不自动改身份核**（value/narrative/L0-L3/规则模板——
见下文「不变量」对「核」的精确定义；事实记忆 append 与记忆边链接是自动的）。运行时人格仍只依赖
已沉淀的记忆/规则/确定性状态——对话引用感知记忆时**不再调用**多模态老师。

这把感知层完全纳入 ADR-0047 已确立的「老师 → 蒸馏门 → 确定性核」范式，与
`LlmReflectionDistiller` 同构：

```
媒体表征(transcript/关键帧)  ← 采集层(client/edge)，原始媒体不进业务流
  → PerceptionProvider.analyze()        感官老师，不可信输出
  → PerceptionDistiller                 硬校验 + 编排（不自动改身份核；只 append 事实记忆 + 记忆边）
      ├─ 事实型观察 → memory graph（episodic/semantic 记忆，append-only，低风险）
      └─ 身份层提案 → DistillationService.ingest → core-update-gate
            · value_shift：delta 封顶 0.05 + patternAgrees=false → 必 pending
            · narrative_patch：改「我是谁」→ 默认 pending 人工审批
  → 确定性核（运行时不再调老师）
```

### 不变量（与 ADR-0047 D3 一致）

「核」在此特指**身份核**：value 权重 / narrative / L0-L3 决策风格·认知模型 / 规则·模板。

1. **绝不自动改身份核**：感知的 value_shift / narrative_patch 提案一律走蒸馏门且**必 pending**
   人工审批——`PerceptionDistiller` 绝不调 `CoreRhythmLayer` 的身份写方法
   （updateValueParams/updateNarrative/setDecisionStyle 等）。
2. 老师的 value_shift 提案 delta **封顶**到自动门上限（0.05）且 `patternAgrees=false`
   （感知是单源，不冒充确定性 pattern-extractor 的交叉验证）→ 而 `core-update-gate` 对
   distilled value_shift 要求 `patternAgrees===true` 才自动 → 故感知单源 value_shift
   **永远 pending**，不会被自动改 value。
3. **会自动写的只有事实层**：事实型观察 append 为 memory node；相邻事实间的 memory_edge 候选
   满足门（confidence≥0.75∧evidence≥2）会自动编译为记忆边——但**只链接刚写入的两条真实记忆**，
   不创造身份、不改 value/narrative，与 ADR-0047 既有 memory_edge 自动编译同属「仅链接真实记忆，
   安全」。即：感知会自动沉淀事实记忆与记忆关联，但绝不自动改身份核。
4. **老师调用失败**（analyze 抛错 / 空表征 / 分析畸形）安全降级为「未产记忆」，不抛进主流程；
   记忆写入与蒸馏门是基础设施操作，其失败按常规抛出由调用方处理（append 语义非事务，已写记忆有效）。
5. `DecisionEngine` / `RuleEngine` / `CoreRhythmLayer` 运行时**绝不**同步依赖多模态 provider。

## Phasing（分阶段）

本 ADR 当前落地 **Phase 1**（论点兼容性的真实证明，零外部依赖、本地可验证）：

- `src/perception/`：`PerceptionProvider` 契约 + `MockPerceptionProvider`（确定性、可测、
  无需外部 key）+ `PerceptionDistiller`。
- 蒸馏候选 source 用独立的 **`'perception'`**（v088 已扩 `distilled_artifacts.source` CHECK，
  SQLite table-rebuild / PG alter constraint），与 `'knowledge_import'`（读文档/导入知识库）区分
  血缘——溯源/审计能分清一条候选源自「听了段经历」还是「读了篇文档」。感知 provenance 也体现在
  记忆内容第一人称「我听到/我看到」+ evidence 指向真实记忆 id。

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

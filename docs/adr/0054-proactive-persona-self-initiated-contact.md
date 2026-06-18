# 0054 — Proactivity is a deterministic gate over existing signals, not a new reasoning loop

**Status:** Accepted (architecture; phased — Phase 1 spec only)
**Date:** 2026-06-18
**Scope:** `src/proactivity`（new bounded context，规划中），订阅既有
`src/events`（EventBus）、复用 `src/conversation`（OfflineConversationResponder）、
`src/safety`（persona-drift-analyzer）、`src/server/routes/companion`（outbound surface）。
**Relates to:** [0047](0047-llm-as-distillable-teacher.md)（zero-LLM 运行时论点），
[0046](0046-dual-product-companion.md)（ChronoCompanion C 端），
[0048](0048-autonomous-earning-loop-governance.md)（自主劳动循环——自主行动的先例），
[0051](0051-external-perception-as-sensory-teacher.md)（感知即老师——同构「信号→门→确定性核」）。

## Context（背景）

用户提问：「数字人格如何**自主学习、主动交流、主动响应**，而非被动问答？」

对照现有能力（均已落地，非空想）：

| 维度 | 现状 | 证据 |
|------|------|------|
| **自主学习** | ✅ 已实现 | earn→distill 自演化闭环（ADR-0047/0048）、感知即老师（ADR-0051）、`learning-benchmark` 把「真的在变好吗」变成可回归 accuracy |
| **自主行动（劳动）** | ✅ 已实现 | `persona-earning-service`（自主发现→匹配→确定性决策→经济门控→申请→执行→提交）、`avatar-autorun`（调度器→认知周期） |
| **主动交流 / 主动响应** | ❌ 缺口 | companion chat 是纯请求-响应（`POST /companion/me/chat` 被动）；**无 persona 主动发起对话的路径** |

即：**学习侧与劳动侧已「自主」，对话侧仍「被动」**。真正缺的是——让数字人**据自己的内部状态变化（学到新东西、人格漂移、记忆巩固、里程碑）主动开口**，而不是等用户问。

这一需求与 ADR-0047 的 zero-LLM 运行时论点直接相关：若「主动说什么」由 LLM 实时生成，论点被架空（人格变成「靠 LLM 实时运行」）。必须避免这一漂移。

### 关键洞察：触发主动性的内部信号已经全有

系统已有一条完整 **EventBus**（`src/types/events.ts`）：`core:memory-added`、
`core:narrative-changed`、`core:memory-consolidated`、`system:evolution-completed`、
`system:artifact-compiled`、`persona:simulation-completed` 等。这些就是「数字人内部发生了
什么」的信号——目前只驱动 observability/audit。

且 **drift 已能渲染成「你最近探索的方向」**（`driftReportToGrowth`，ADR-0046）——但它是
**pull**（`GET /companion/me/growth`），不是 **push**。

主动性 = 把**已有信号源** 接到一个**确定性的「该不该开口」门控** + 一条 **outbound 通道**。
无需新增推理机制。

## Decision（决策）

**主动性是「对既有内部信号的确定性门控」，不是新的推理循环。** 引入独立 bounded context
`src/proactivity`，由三段组成，全程零 LLM：

```
既有 EventBus 信号(memory-added / narrative-changed / evolution-completed / artifact-compiled …)
  → ProactiveEngine.onSignal(event)          订阅，不轮询；信号已是「内部真发生的事」
  → ProactiveGate（纯函数，确定性）           该不该开口？
      ├─ 显著性阈值：信号够不够「值得说」（如巩固了 ≥N 条记忆 / drift 越过 warning / 蒸馏编译了身份层）
      ├─ 静默期：距上次主动消息 < quietPeriodMs → 抑制（不骚扰）
      ├─ 频率上限：每窗口最多 K 条主动消息（per-persona 可配，0 = 关闭主动性）
      └─ 用户开关：persona/租户级 proactivity_enabled（默认保守）
  → ProactiveComposer（零-LLM）              说什么？
      └─ 复用 OfflineConversationResponder + drift→「你最近探索」既有渲染，
         据信号类型选确定性模板 + 已沉淀记忆/叙事填充；过 never_discuss 输出自检
  → outbound 队列（proactive_messages 表，未读/已读）
  → 客户端拉取或推送（GET /companion/me/nudges + 既有 SSE/WS）
```

与 ADR-0051 同构：**信号（不可控来源）→ 确定性门 → 确定性产出**。这里信号是「内部状态变化」
（本就可信，无需像感知那样硬校验来源），门控的职责是**节制**（值不值得说、会不会骚扰），
而非**真伪校验**。

### 不变量（红线）

1. **零-LLM 运行时论点完整保住**：「该不该开口」「开口说什么」**全程确定性**——门是纯函数，
   生成复用 `OfflineConversationResponder`（相同状态 → 相同主动消息，可复现）。**绝不**调 LLM
   决定主动行为。LLM 在主动性路径中**无角色**。
2. **主动 ≠ 改身份**：ProactiveEngine **只读**人格状态 + 写 outbound 队列，**绝不**调
   `CoreRhythmLayer` 身份写方法（value/narrative/L0-L3/规则）。主动开口不改「我是谁」。
3. **主动 ≠ 骚扰**：静默期 + 每窗口频率上限 + per-persona 开关（含 0=完全关闭），是门的
   一等约束，不是事后补丁。默认配置保守（宁可少说）。
4. **主动消息走同一边界自检**：主动文本同样过 `OfflineConversationResponder` 的 `never_discuss`
   输出自检（同 companion chat 的 response_template 路径），不因「主动」而绕过边界。
5. **信号驱动，非轮询人格**：订阅 EventBus，不新建「定时扫所有人格问要不要说话」的循环
   （那会是规模化性能债 + 无意义空转）。仅在内部真发生事时评估一次。失败隔离：主动性评估
   抛错**绝不**污染触发它的主流程（记忆写入 / 蒸馏 / 演化照常完成）。
6. **租户隔离**：proactive_messages 是 per-tenant 表，进 TenantDatabase 自动隔离集 + 隐私
   分类（GDPR 导出/擦除），同既有 companion 表。
7. **信号租户归属（Codex 审查补强）**：`TenantTagged<T> = T & { tenantId?: string }`——`tenantId`
   在类型上**可选**。ProactiveEngine **只处理带明确 `tenantId` 的信号**；缺 `tenantId` 的事件必须
   **drop**（或进显式单租户路径），**绝不**默认归到 `'default'`。否则「per-tenant 表」不足以防错误
   归属导致的跨租户 nudge——隔离必须在**信号入口**就成立，而非只靠落库表。
8. **幂等去重（Codex 审查补强）**：EventBus 在重试 / 重放 / 双订阅 / 服务重启时可能重复投递同一信号。
   outbound 写入必须用**确定性幂等键**（`tenantId + personaId + signalType + sourceId + signalVersion`），
   同一信号**最多生成一条**主动消息（DB 唯一约束 + upsert-ignore）。
9. **投递同意与安静时间（Codex 审查补强）**：频率上限 / 静默期防「多」，但**不等于**用户同意被推送。
   Phase 6 push 投递必须有**通道级 opt-in**（per-channel）+ **quiet hours**（用户本地夜间不推）+
   **unsubscribe/disable**——尤其移动推送不能只靠 per-persona 频率门。in-app 未读 nudge（拉取）默认
   开启可接受；主动 push（移动/桌面通知）默认关闭、显式同意才开。
10. **订阅回调自包裹（实现注记）**：Node `EventEmitter.emit()` 默认会向上传播 listener 异常。
    红线 5 的「失败隔离」必须由 ProactiveEngine 的订阅回调**自身 try/catch** 落实（捕获→记日志→吞），
    不能仅在 ADR 声明——否则一条主动性评估异常会炸穿触发它的记忆写入 / 蒸馏主流程。

## 三种「主动性」的精确区分

用户问题含三个相关但不同的诉求，本 ADR 分别定位：

- **自主学习** → 已由 ADR-0047/0048/0051 实现，本 ADR **不重复**，只在 composer 里**引用**
  「我最近学到/探索了什么」作为主动话题来源。
- **主动交流（self-initiated）** → 本 ADR 核心：persona 据内部信号**主动发起**新对话（push）。
- **主动响应（proactive reply）** → 被动回答时更主动——回答后**主动追问 / 提及自己最近学到的 /
  关联起过往记忆**。这是 `OfflineConversationResponder` 的增量增强（同确定性路径），可独立于
  push 通道先做。

## Phasing（分阶段）

**Phase 1（本 ADR 落地：spec only）**：确立架构与红线，不写实现。产出本文档 + 在
`.ccg/tasks/proactivity-adr/` 登记信号清单与门控参数草案。

后续阶段（未实现，登记）：

- **Phase 2 — Outbound 通道 + 拉取**：`proactive_messages` 表（schema-dsl 迁移 + 隐私分类 +
  隔离集 + **幂等键唯一约束** `tenantId+personaId+signalType+sourceId+signalVersion`，红线 8）+
  `GET /companion/me/nudges`（未读主动消息）+ web/mobile 小红点。先打通管道，触发逻辑用最小规则。
  in-app 未读 nudge 默认开启；移动/桌面 push 默认关闭（红线 9）。
- **Phase 3 — ProactiveEngine + Gate**：订阅 EventBus 信号子集（memory-consolidated /
  narrative-changed / evolution-completed / drift 越阈），订阅回调**自身 try/catch**（红线 10）+
  **入口 drop 无 tenantId 信号**（红线 7）。确定性门（阈值 + 静默期 + 频率上限 + per-persona 开关，
  复用 persona-governance 配置模式）。
- **Phase 4 — ProactiveComposer**：据信号类型选确定性模板，复用 OfflineResponder + drift 渲染，
  过 never_discuss 自检；主动消息可复现性测试。
- **Phase 5 — 主动响应增强**：OfflineResponder 回答后确定性追问 / 关联记忆 / 提及近期成长
  （独立于 push，可与 Phase 2-4 并行）。
- **Phase 6 — Push 投递**：复用既有 SSE/WS 把未读主动消息实时推到在线客户端（离线则下次拉取）。

## Consequences（后果）

**正面**：

- zero-LLM 论点**完整保住**——主动「要不要说、说什么」全确定性；信号源是人格自己内部真发生的事。
- **零新核心机制**：复用 EventBus（已有信号）+ OfflineConversationResponder（已有零-LLM 生成）+
  drift 渲染（已有）+ persona-governance 配置模式（已有）+ companion outbound surface（已有 SSE/WS）。
- 主动性是独立 bounded context（`src/proactivity`），不污染 conversation 同步路径、不膨胀
  CoreRhythmLayer——同 perception 层的隔离原则。
- 补齐「自主」的最后一块：学习 ✓ 劳动 ✓ 对话主动性 ✓ → 产品叙事完整「TA 会自己成长，也会主动找你」。

**负面 / 红线**：

- 主动性最大风险是**骚扰**——故频率上限 + 静默期 + 用户开关是门的一等约束，默认保守。
- 不做「LLM 生成主动话术」（违反零-LLM 论点）。若未来要更自然的主动话术，仍走「LLM 当老师→
  蒸馏成确定性模板」范式（ADR-0047），不在运行时实时生成。
- 不做跨用户主动联系 / 营销推送 / 通知轰炸（这是骚扰，非人格主动性）。
- Phase 1 **不写实现**，仅定架构与红线；管道（Phase 2）先于触发逻辑（Phase 3）以隔离风险。

## Product framing（产品定位，来自 ADR-0046 C 端）

从「我问 TA 答」到「TA 会主动跟我说」。落点是 C 端 ChronoCompanion：数字人巩固了一段记忆、
探索方向发生漂移、或自演化完成后，**主动**用第一人称开口——「我最近一直在想……」「我发现自己
越来越在意……」——用户打开 app 看到一条未读 nudge，而非空白的输入框等他先问。产品价值是
**陪伴感的质变**：人格有自己的内部生活，并愿意主动分享，而不只是一个有问必答的工具。

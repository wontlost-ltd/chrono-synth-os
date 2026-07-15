# 数字人如何使用工具 —— 完整调用链路与时序图

> 本文用一句话概括：**运行时零-LLM**。数字人使用工具，靠的是「学习期由 LLM 老师蒸馏出的确定性规则 + 运行时一串确定性门」，真跑的时候一次都不调 LLM。
>
> 关联 ADR：[ADR-0047](adr/0047-*)（零-LLM 内核根基）、[ADR-0055](adr/0055-*)（数字员工真实执行 D 链）、[ADR-0057](adr/0057-*)（按职能进修学习闭环）、[ADR-0060](adr/0060-tool-action-compiler-and-eligibility.md)（工具动作编译器 + eligibility）。

---

## 1. 三层分离（ADR-0060 核心心智模型）

数字人「使用工具」被拆成三件互不等价的事——**会做 ≠ 会正确安全调 ≠ 被授权做**。任何一层都不能自动推出下一层。

| 层 | 名称 | 回答的问题 | 谁产出 | 落点 |
|---|---|---|---|---|
| **L-cap** | 会做（capability） | 「这个数字人会不会做这类事？」 | ADR-0057 学习闭环（LLM 老师 → 蒸馏门 → 确定性能力索引） | `capability_index` |
| **L-elig** | 会正确安全调（eligibility） | 「据它学到的规则，能不能建议授某工具？」——**只建议不授权** | `ToolEligibilityProjector`（订阅 `capability-learned`，读活跃规则溯源） | `tool_eligibility`（建议） |
| **L-perm** | 被授权做（permission） | 「治理层到底授没授权它调这个工具？」 | 人工授予 / `ToolAutoAuthorizationBridge`（白名单+低险自动授，高险建待审批） | `tool_permissions` |

**铁律**：「会做」永远不会自动变成「被授权做」。中间的 eligibility 层只产建议，且只桥「已通过工具考试」的 capability——纯知识型 capability（没学会怎么调工具）不解锁任何工具。

---

## 2. 两个时期（学习期 vs 运行时）

```
════════════════ 学习期（离线，用 LLM 老师）════════════════
  数字人学会一个 capability（ADR-0057）
        │
        ├─▶ LLM 老师产出「任务字段 → 工具参数」候选映射规则
        │        │
        │        ▼  ToolRuleLearningService 四道蒸馏门
        │     ① provenance（sourceArtifactId 非空，红线6）
        │     ② 规则 lint（DSL 形状合法）
        │     ③ 考试 lint（ExamSpec 合法）
        │     ④ 真跑一遍工具考试（scoreToolExam 达标）
        │        │
        │        ▼  过门 → 原子落表（停旧 active 再插新，红线10）
        │     tool_action_rules（确定性 ToolActionRule）
        │
        └─▶ capability-learned 事件
                 │
                 ▼  ToolEligibilityProjector（只建议不授权）
              tool_eligibility ── ToolAutoAuthorizationBridge ──▶ tool_permissions
                                   （白名单+低险自动授 / 高险建待审批）

════════════════ 运行时（真跑，零-LLM，一次不调 LLM）════════════════
  数字员工被要求执行一个已委派任务
        │
        ▼  ToolActionCompilerService.compile()  ← 纯函数据规则构造参数
     从任务结构化字段 + 确定性规则 → ToolCallPlan{toolId, arguments, 幂等键}
     （fail-closed：无规则/冲突/过期/缺字段/枚举越界 → 要求人工补，绝不猜、绝不调 LLM）
        │
        ▼  ToolInvocationPipeline（所有工具调用的唯一入口，7~8 门）
     真调工具 → 记账 + 审计
```

**零-LLM 边界（讲清楚）**：
- **运行时构造参数是纯函数**：`compileToolCall` 只用 4 种确定性 DSL——`pick`（取任务字段）/`const`（常量）/`enum`（白名单枚举）/`template`（模板插值）。文件级禁 LLM / prompt / eval / 网络 / 时间源 / 随机源。
- **智能只在学习期**：映射规则本身由 LLM 老师产出，但经蒸馏门变成确定性规则后，运行时只查规则、不再有任何推理。
- **ADR-0060 明确不承诺**：运行时让数字人「像人一样临场自由决定调什么工具、怎么拼参数」——那需要运行时推理，违反零-LLM 根基，本 ADR 明确不做。

---

## 3. 运行时端到端时序图

数字员工执行一个已委派任务（`POST /workforce/orgs/:orgId/tasks/:taskId/execute`）：

```
HTTP Route          WorkerExecutionService        Compiler         Pipeline          Tool
(workforce-actions)  (worker-execution-service)   (T1)             (7~8门)           (adapter)
    │                        │                       │                │                 │
    │  execute(task)         │                       │                │                 │
    ├───────────────────────▶│                       │                │                 │
    │                        │ 前置校验              │                │                 │
    │                        │ (task delegated /      │                │                 │
    │                        │  assignee / active)   │                │                 │
    │                        │                       │                │                 │
    │                        │ ⓪ 能力缺口门(L2)       │                │                 │
    │                        │   缺能力→learning_     │                │                 │
    │                        │   required(不硬干)     │                │                 │
    │                        │                       │                │                 │
    │                        │ ① 风险门(只升不降)     │                │                 │
    │                        │ ② 审批门(非low需绑定   │                │                 │
    │                        │   本次执行的已放行审批)│                │                 │
    │                        │ ③ actor 身份(org_worker│                │                 │
    │                        │   + 人类principal非空) │                │                 │
    │                        │ ④ CAS 并发门           │                │                 │
    │                        │   delegated→in_progress│                │                 │
    │                        │   (锁 assignee)        │                │                 │
    │                        │                       │                │                 │
    │                        │ ⑤ 编译参数(零-LLM) ★   │                │                 │
    │                        ├──────────────────────▶│                │                 │
    │                        │   有规则:据 argMappings │                │                 │
    │                        │   从任务字段确定性构造  │                │                 │
    │                        │◀──────────────────────┤                │                 │
    │                        │   ok=ToolCallPlan       │                │                 │
    │                        │   fail-closed=挂起/退回 │                │                 │
    │                        │                       │                │                 │
    │                        │ ⑥ invoke(编译出的args) │                │                 │
    │                        ├──────────────────────────────────────▶│                 │
    │                        │                       │                │ 代理授权书        │
    │                        │                       │                │ ToolPermission   │
    │                        │                       │                │ allow/deny       │
    │                        │                       │                │ 配额             │
    │                        │                       │                │ 预算             │
    │                        │                       │                │ 二次确认         │
    │                        │                       │                │ 断路器           │
    │                        │                       │                ├────────────────▶│
    │                        │                       │                │                 │ 真调
    │                        │                       │                │◀────────────────┤
    │                        │                       │                │ 记账+审计         │
    │                        │◀──────────────────────────────────────┤                 │
    │◀───────────────────────┤ 写回(submitted/blocked)│                │                 │
    │  200 {result}          │                       │                │                 │
```

★ = 本文档配套接线补上的一环（详见 §5）。

---

## 4. 关键文件索引

| 关注点 | 文件 | 说明 |
|---|---|---|
| 工具注册表 | `src/agent/tool-registry.ts` | 启动期注册、`freeze()` 冻结的 toolId→adapter map |
| 工具适配器接口 | `src/agent/tool-adapter.ts` | `ToolMetadata`（inputSchema/schemaVersion/highRisk）+ `invoke` |
| 工具目录 | `src/agent/tools/` | calendar/email/web-search/marketplace/memory 等 |
| **运行时调用管线** | `src/agent/tool-invocation-pipeline.ts` | 所有工具调用唯一入口，7~8 门 |
| 数字员工执行 | `src/workforce/worker-execution-service.ts` | D 链真实执行 + 叠加能力/风险/审批/CAS 门 |
| **参数编译器(纯函数)** | `packages/kernel/src/domain/tool-action/tool-action-compiler.ts` | `resolveActiveRule` + `compileToolCall` |
| 参数编译 service | `src/intelligence/tool-action-compiler-service.ts` | 串「取规则 → 解析 → 构造」 |
| 规则存储 | `src/storage/tool-action-rule-store.ts` | `tool_action_rules` 读写 |
| 规则学习通道 | `src/intelligence/tool-rule-learning-service.ts` | 四门蒸馏候选规则落表 |
| eligibility 投影 | `src/intelligence/tool-eligibility-projector.ts` | 订阅 capability-learned 产建议 |
| 自动授权桥 | `src/intelligence/tool-auto-authorization-bridge.ts` | 白名单+低险自动授 |
| HTTP 执行入口 | `src/server/routes/workforce-actions.ts` | `POST .../tasks/:taskId/execute` |
| 自主挣钱 worker | `src/intelligence/persona-earning-service.ts` | marketplace apply → 执行 |
| MCP 外部入口 | `src/mcp/chrono-mcp-server.ts` | `tools/call` |

---

## 5. 接线现状与本次补齐

### 缺口（补齐前）
参数编译器 `ToolActionCompilerService`（T1）**只在测试中被调用，无生产调用方**——真实执行路径（HTTP body / MCP client / 挣钱周期）的 `arguments` **仍由调用方直接传入**，不是从任务字段确定性编译出来的。这正是 ADR-0060 Context 描述的「运行时零-LLM 参数构造瓶颈」，也是 ADR-0060 T7 诚实标注的边界：**引擎已造好，尚未接进主执行管线**。

已生产接线的：eligibility→授权桥、7~8 门执行、学习通道。
未接线的：**「任务字段 → 工具参数」自动确定性编译**（仅在 e2e 测试 `tool-learning-e2e-t6.test.ts` 中贯通验证）。

### 本次补齐（详见接线实现）
在 `WorkerExecutionService.execute()` 的 CAS 并发门之后、`pipeline.invoke()` 之前插入 **⑤ 编译参数** 一步：
- 注入可选 `ToolActionCompilerService`（未注入 = 旧行为，向后兼容）。
- 有匹配 active 规则 → 用编译出的 `arguments`（确定性，覆盖调用方传入的裸参数）。
- **fail-closed 语义**：区分「压根没规则（no_rule）」与「有规则但构造失败（缺字段/冲突/过期/schema 不符）」：
  - `no_rule`：该 (persona, tool, capability) 尚无学习规则 → **回退调用方传入的 arguments**（向后兼容：规则表为空时不打挂任何现有执行）。
  - 其它 fail-closed（缺字段/冲突/过期/schema 不符/枚举越界）：**不硬干**——退回任务、登记为需人工补，绝不用调用方裸参数蒙混（否则「有规则却构造失败」被裸参数绕过，等于规则形同虚设）。

补齐后，「数字人真正自己会用工具」的最后一环闭合：任务字段经确定性规则编译成工具参数，全程零-LLM。

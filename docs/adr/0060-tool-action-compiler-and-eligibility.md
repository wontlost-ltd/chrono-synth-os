# 0060 — 工具动作编译器 + 能力→工具授权资格：数字人格自主学会用新外部工具

**Status:** Accepted（架构；分阶段——T0 本 ADR 仅定「参数编译 + eligibility 三层分离」模型 + 红线 + 分片路线，T1-T6 后续实现）

**关联：** [[0047]] LLM 是可蒸馏的老师（运行时零-LLM 根基）、[[0055]] 数字员工执行治理（7 门执行）、[[0057]] 按职能学习（能力缺口→蒸馏进核）、本仓库 `feat/tool-learning-r4-examspec-lint`（R4 rubric 健康门，已实现）。

---

## Context（背景）

`tool-learning-deep-research`（deep-research，双模型）发现：数字人格「学会用外部工具」当前**断成两条互不相连的链**，中间缺一座桥。

**用工具**（成熟）：一切经 `ToolInvocationPipeline`（`src/agent/tool-invocation-pipeline.ts`）7 门——代理授权书 → ToolPermission → 配额 → 预算 → 二次确认 → 断路器 → invoke → 记账。工具是 `ToolAdapter`（`src/agent/tools/*`，metadata+invoke）。

**学能力**（成熟，ADR-0057）：GapDetector 确定性算缺口 → 登记学习请求 → 双老师审「该不该学」→ 影子内核验收≥95 → 蒸馏进 per-persona 核 → `capability-learned` 事件。

**两个断点（研究确认，file:line 依据）**：

1. **capability↔tool 解耦**：`capability-learned` 只有 2 个订阅者（CapabilityIndexProjector L7、TaskWakeHandler L8a），**都不授 tool 权限**；ToolPermission 只由**人工**授予（`admin-tools.ts` / `onboarding-v2.ts`）。→ **学会一个 capability（如 `invoice_processing`）不会解锁任何 tool（如 `invoice.issue`）**。`requiredCapabilities`（技能）与 tool adapter（执行入口）是两个概念，无绑定。

2. **运行时零-LLM 参数构造瓶颈（更深）**：`worker-execution-service.ts:215` 的 `arguments: input.arguments`——工具调用参数来自**调用方**（MCP client / HTTP body / 少数硬编码），**没有任何确定性「工具调用计划器 / 参数构造层」**。ReAct 靠 LLM 运行时拼参；本架构运行时零-LLM 却无等价替代。即使学会技能，也没有模块能把任务字段自动映射成 `{toolId, arguments}`。这是接新工具的**真正天花板**。

**为什么现在定这个 ADR**：这两个是地基级变更（新状态机 + 新层 + 新表 + 新事件订阅），研究已定性其价值与权衡，但实现前必须先冻结设计决策与红线（避免 MVP/占位符、避免把「会做」误升成「被授权做」）。

---

## Decision（决策）

### 三层分离（核心）——绝不把 `capability-learned` 直接变成 ToolPermission

| 层 | 语义 | 谁产生 | 现状 |
|---|---|---|---|
| L-cap **capability learned** | 内核学会某技能知识/规则 | ADR-0057 学习闭环 | 已实现 |
| L-elig **tool eligibility** | 该 capability 对某 tool/action 的**确定性调用规则**通过「工具考试」 → 产出**授权建议**（不自动 grant） | 本 ADR T3 | 新增 |
| L-perm **ToolPermission / AgencyAuthorization** | 人工 / 治理策略**授予执行权** | 现有人工授权 + T5 白名单策略 | 部分新增 |

「会做」（cap）→「会正确+安全地调这个工具」（elig）→「被授权代表用户做」（perm）三者**必须分开**。跨过任何一层都是越权。

### R1 · Tool Action Compiler（参数编译层，运行时零-LLM）

新增确定性 `ToolActionCompiler`：
- **输入**：任务结构化字段 + 已学 capability + tool schema + 授权 constraints + 业务模板。
- **输出**：确定性 `ToolCallPlan{ toolId, arguments, riskSignals, idempotencyKey }`。
- **智能来源守零-LLM**：学习期 LLM 产出**候选映射规则** → 经**同一蒸馏门** + lint + fixture exam → **编译成确定性规则**；**运行时不调 LLM 只查规则执行**。
- **fail-closed**：开放文本任务无法结构化抽取参数时，**要求人工补字段**，绝不让内核猜。

**`ToolActionRule` 必须是受限、确定性、可 lint 的 DSL/IR**（Codex 设计复审补，堵零-LLM 暗门）：
- **禁止**运行时 LLM 调用、prompt、`eval`/动态代码、网络调用、时间源、随机源参与 arguments 构造——否则「运行时查规则」会把 LLM/非确定性依赖藏进规则里，破根基铁律。规则只能是「结构化字段 → schema 参数」的纯确定性映射（字段取值/常量/白名单枚举/确定性模板插值）。
- **元数据**（缺 tenant 或版本不匹配 → fail-closed）：`tenantId, personaId, toolId, capability, schemaVersion（tool inputSchema 版本）, ruleVersion, contentHash, createdBy, compiledAt, expiresAt`。
- **冲突决议**：同一 `(persona, capability, tool, schemaVersion)` 只能一个 active 规则；多规则命中 → **fail-closed**（不猜哪个），要求治理消歧。
- 覆盖面诚实：本层只解「**可结构化/可编译**的参数映射」；开放动态任务超出编译层，走 fail-closed 人工补字段（见 Decision 边界段与「不承诺」）。

### R2 · capability→tool eligibility 桥

- `capability-learned` 新增订阅者产出 **eligibility projection**（如 `capability_tool_eligibility` 表），标记「该 persona 学会 X 后，*建议*可授 tool Y（含 constraints）」——**只建议，不 grant**。
- eligibility 条目**必须**带 `expiresAt, sourceRuleVersion, examSpecVersion, riskClass, constraintsHash`（Codex 复审补）；**过期、或 tool schema/riskClass 变化 → 该建议失效**，不得再用于自动授权请求（防陈旧建议授权已变工具）。
- **eligibility 只表达 recommendation，pipeline / permission / authz 服务绝不把它当 allow 条件读取**（红线 2 强化）——授权仍只由 ToolPermission/AgencyAuthorization 决定，eligibility 只驱动「建议/待审批请求」。
- 高风险外部副作用工具：只允许**自动创建待审批授权请求**，不自动写 ToolPermission，更不能自动创建 AgencyAuthorization。
- 低风险只读内部工具（T5）：可配置**显式白名单**自动授权桥（`capability→toolId→constraints`，默认 requireConfirmation + allowList + budget + 过期）。**「低风险」判定由治理白名单维护**（变更需审计+审批）——`tool.metadata.highRisk=false` 只是**输入信号**，**不能单独作为自动授权依据**（防把高险工具标低险绕过红线 3）。

### R3 · 工具专属 ExamSpec

「学会用工具」的验收考的不是知识、是**会不会正确+安全地构造工具调用**：schema 构造（生成合法 arguments）、fixture dry-run（调 mock adapter 断言 payload/幂等键/金额/目标精确匹配）、安全场景（越权/超预算/缺确认/高风险被拒或标高险）、错误恢复（401/429/5xx 确定性处理）、审计字段提取。

---

## 红线（MUST）

1. **运行时零-LLM 铁律不破**（[[0047]]）：所有智能（参数映射规则、eligibility 判定）在**学习/编译期**产生并经蒸馏门变确定性；运行时只查规则执行，绝不调 LLM。
2. **capability ≠ permission**：学会能力**永不**自动授予 ToolPermission/AgencyAuthorization（除低风险白名单显式策略）；默认产出**建议**待人工/治理授权。
3. **最小权限**：高风险/外部副作用/写操作工具的自动授权一律禁止；只能自动创建**待审批请求**。
4. **参数编译 fail-closed**：无法确定性构造合法 arguments → 要求人工补字段，不猜、不放行。
5. **不绕现有 7 门**：编译出的 `ToolCallPlan` 仍全程过 `ToolInvocationPipeline`（授权/权限/配额/预算/确认/断路器），编译层只解决「参数从哪来」，不替代任何执行门。
6. **蒸馏门控纪律唯一，来源可追溯**（T3 实现复审修订）：映射规则**不得**由任意调用方直灌规则表——必须经**等价蒸馏门控纪律**（lint → 工具考试验收 → 过考才落表，与 `DistillationService.ingest` 同纪律）产出，且每条落表规则**必须携带 provenance**（`sourceArtifactId`）指向其上游蒸馏产物，来源可审计。落 per-persona（[[0057]] 红线 8）。
   > **偏离说明**：原措辞要求走**同一物理入口** `DistillationService.ingest`。工具动作规则本质不是「知识 artifact」，且复用该入口需迁移 `distilled_artifacts.kind` CHECK（本仓刻意规避，见 perception/F3 先例）。实现采用**专门的门控通道** `ToolRuleLearningService`（同 lint+验收+落表纪律）+ **强制 provenance 字段**证明来源，实质等价「不绕门」——门的本质是「有据可查的验收产物，非任意直灌」，非物理入口单一性。
7. **per-persona eligibility**：eligibility 投影按 (tenant, persona) 隔离；事件缺 tenantId 直接 drop（不默认 default）。规则表同隔离。
8. **审计完整**：编译出的每次工具调用、每条 eligibility 建议、每次自动授权请求都入审计链。
9. **规则确定性与防篡改**（Codex 复审补）：ToolActionRule 是版本化、内容哈希（contentHash）、可 lint 的确定性 DSL/IR；运行时构造 arguments **禁** LLM/prompt/eval/网络/时间/随机；规则缺元数据或 schemaVersion 与 tool 当前 inputSchema 不匹配 → fail-closed。
10. **规则冲突 fail-closed**：同 (persona, capability, tool, schemaVersion) 多 active 规则命中 → 拒绝构造（不猜），要求治理消歧。
11. **eligibility 失效**：建议带 expiresAt + sourceRuleVersion + examSpecVersion + riskClass + constraintsHash；过期 / tool schema 或 riskClass 变化 → 建议失效，不得用于自动授权。
12. **eligibility ≠ allow**：任何执行门/授权服务**不得**把 eligibility 当放行条件；它只驱动建议与待审批请求，授权仍由 ToolPermission/AgencyAuthorization 决定。
13. **低风险分类治理化**：T5 自动授权桥的「低风险」由**治理白名单**（审计+审批）维护，非 tool metadata 自证；highRisk=false 仅输入信号不作授权依据。

---

## Phased roadmap（分片路线）

（Codex 设计复审调整：工具 ExamSpec 前移为「规则入表」前置门——规则必须先过工具考试才能落表用，否则烂规则会先污染再考。）

| 阶段 | 内容 | 依赖 | 状态 |
|---|---|---|---|
| **T0** | 本 ADR：三层分离模型 + 13 红线 + 路线（spec-only） | — | ✅ 本 ADR |
| **T1** | `ToolActionCompiler` 接口 + 确定性 `tool_action_rules` DSL/IR 表模型（含红线 9 元数据）+ 运行时查规则构造 ToolCallPlan（无规则/冲突/版本不匹配 → fail-closed 要人工） | T0 | 待做 |
| **T2** | **工具专属 ExamSpec + lint + fixture dry-run**（R3 前移）：考 schema 构造 / payload 精确匹配 / 安全场景（越权/超预算/缺确认/高险）/ 错误恢复——**作为 T3 规则入表的前置验收门**（复用 R4 已实现的 rubric lint 门 + 扩 shadow-exam 到工具语义） | T1、R4 | 待做 |
| **T3** | 映射规则学习通道：LLM 候选规则 → 蒸馏门 + lint → **过 T2 工具考试才编译进规则表**（复用 ADR-0057 蒸馏门，红线 6） | T1、T2、[[0057]] | 待做 |
| **T4** | `capability_tool_eligibility` 表（含红线 11 元数据）+ `capability-learned` 新订阅者产出**授权建议**（不 grant，红线 2/12） | T0、T3、[[0057]] L7 | ✅ 已实现（PR：ToolEligibilityProjector + 规则表回填 exam_spec_version/risk_class 供红线 11 陈旧失效溯源） |
| **T5** | 低风险白名单自动授权桥（R5）：治理白名单驱动的显式 `capability→toolId→constraints` 策略，高险仍人工（红线 3/13） | T4 | 待做 |
| **T6** | 端到端接线：新工具（示例 invoice_api）走完 学技能→过工具考试→编译参数规则→eligibility 建议→授权→执行 全链 | T1-T5 | 待做 |

---

## Consequences（后果）

**正面**：
- 补上「学知识」与「治理执行」之间缺失的桥——数字人格能**自主学会用新外部工具**，而运行时仍纯确定性、可审计、可复现（智能全部前移到学习/编译期）。
- 三层分离守住最小权限：「会做」不被误解为「被授权代表用户做」。
- 参数编译 fail-closed + 工具专属验收，杜绝「学会知识但乱调工具」。

**负面 / 权衡**：
- 参数编译层对**高度动态、开放文本**的工具调用仍弱于 ReAct 运行时推理（研究方向一诚实结论）——本架构定位是**可结构化/可编译**的工具使用；开放式探索型 agent 非目标场景。
- 新增规则表 + eligibility 表 + 编译器 + 工具 ExamSpec，是多 PR 地基级工程量（故分 T1-T6）。
- 映射规则的学习依赖 LLM 老师质量（学习期），错误规则靠 fixture exam + lint 挡（R4 已铺垫消费侧兜底）。

**不承诺**：运行时让数字人格「像人一样临场自由决定调什么工具、怎么拼参数」——那需要运行时推理，违反零-LLM 根基铁律，本 ADR 明确不做。

---

## 实现规格备注（T1+ 落地时明确，Codex 设计复审第二轮）

- `contentHash` 取**规范化后的 DSL/IR** 哈希（非原始 JSON 字符串），避免字段顺序造成假变更。
- 「tool schema / riskClass 变化即失效」需明确**检测触发点**：如 tool registry metadata version 或 inputSchema 内容哈希；否则「变化即失效」无落点。
  > **T4 落点（Codex T4 复审补）**：检测触发点定为**消费侧读时校验**，非依赖 registry 变更事件源（本仓无该事件）。
  > `CapabilityToolEligibilityStore.listValidForAuthorization(persona, now, currentToolState)` 是授权侧**唯一**合法消费入口：
  > 对每条 active 建议 fail-closed 校验「过期 / 建议记录的 schemaVersion≠当前 / riskClass≠当前 / 工具已下线」，任一不符即排除。
  > `listActive` 仅审计用（返回 active 全量不过滤，禁授权直接消费）。examSpecVersion=`examId::scorerVersion` 依赖
  > **ExamSpec 生成后冻结不可变**（R4 exam 冻结纪律，tool-exam-types.ts 已载）——同 id+scorer 内容不得覆盖。
- T5 自动授权**强制 `expiresAt` 非空**，避免低风险策略长期漂移成永久授权。

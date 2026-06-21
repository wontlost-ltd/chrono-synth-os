# 0055 — 数字员工的真实执行：worker 是执行 actor，不是法律 principal；高风险必须人类授权

**Status:** Accepted（架构；分阶段——D0 本 ADR 仅定治理模型，D1/D2/D3 后续实现）
**Date:** 2026-06-21
**Scope:** `src/workforce`（数字员工组织 bounded context），复用 `src/agent`
（`ToolInvocationPipeline` / `AgencyAuthorizationService` / `ToolPermissionService`）、
`src/intelligence`（`DecisionEngine` autonomous）。
**Relates to:** [0047](0047-llm-as-distillable-teacher.md)（零-LLM 运行时论点），
[0046](0046-dual-product-companion.md)（enterprise/companion 双产品边界），
[0048](0048-autonomous-earning-loop-governance.md)（自主劳动循环——自主行动+人类批准的先例）。

## Context（背景）

数字员工组织（M1/A0/E1/A1 已落地）目前 IC 的「执行」是**确定性 stub**——产出结构化摘要，不
碰真实工具、无外部副作用。要让数字员工真正「干活」（写文件、调 API、改 CRM、对外沟通），必须把
执行接到既有 `ToolInvocationPipeline`（真工具 + 授权 + 预算 + 确认 + 审计）。

这一步是整个数字员工愿景里**风险最高**的：一旦数字员工能执行真实动作，「谁为这个动作负责」「数字
员工能不能自己批准自己越权」「高风险动作要不要人类点头」就成了不可回避的治理问题。历史上 agent
平台最常见的事故就是「把 agent 当成授权主体，导致越权执行」。本 ADR 在写任何执行代码（D1-D3）
**之前**把治理模型定死，避免事后补救。

现有事实（已验证）：
- `ToolInvocationPipeline.invoke` 的 `invokerType` 只有 `mcp | internal | admin`，没有数字员工
  actor 语义；有 `invokerUserId`（法律 principal）。
- `AgencyAuthorizationService` 的 principal 是**人类** `principalUserId`（承载法律责任）。
- `ToolPermissionService` 是机器粒度刹车（quota/budget/confirmation）。
- ADR-0048 已立先例：自主劳动可自动 apply，但对外承诺/敏感数据/wallet debit 需人类确认。
- A0 已给每个任务落库 `riskLevel`（low/medium/high）+ `allowsToolExecution`——执行治理的输入就绪。

## Decision（决策）

数字员工的真实执行遵循以下治理模型。**核心原则：数字员工是执行 actor，不是法律 principal。**

### D0.1 — 三个 actor 角色分离

| 角色 | 是谁 | 承载什么 |
|---|---|---|
| **法律 principal** | 人类（org owner / 授权的管理员） | 法律责任主体；`AgencyAuthorization.principalUserId` 不变，永远是人 |
| **执行 actor** | 数字员工（worker，绑 persona） | 「谁做的这个动作」的归因；新增 `invokerType='org_worker'` + `invokerId=worker:<id>` |
| **审批 actor** | 上级数字员工 或 人类 | 组织流程批准；**上级 persona 批准 ≠ 法律授权** |

**铁律**：上级数字员工的批准只是**组织流程信号**（记 `org_approvals.approver_worker_id`），它**不能**
替代人类法律授权。任何对外承诺、敏感数据访问、资金动作、不可逆操作，法律 principal 必须是人类，且
高风险动作需要人类审批 actor 点头。

### D0.2 — 风险分级审批矩阵

执行一个任务的工具调用，按**有效风险**决定审批路径：

| 有效风险 | 审批要求 | 谁能放行 |
|---|---|---|
| **low** | 无需审批 | worker policy + tool permission 直接放行 |
| **medium** | 组织内审批 | 上级数字员工 approval（记 org_approvals）**或**人类；默认人类，worker 审批需 enterprise policy 显式开启 |
| **high** / 不可逆 / 对外承诺 / 敏感数据 / 资金 | **必须人类审批** | 人类审批 actor（上级 persona 批准不充分） |

`allowsToolExecution=false` 的任务永远走 stub，不进 pipeline。`allowsToolExecution=true` 的任务才
进入上表的审批路径。

**铁律 1 — 有效风险只升不降（Codex 复审）**：审批用的不是裸的 `task.riskLevel`，而是
`effectiveRisk = max(task.riskLevel, tool 风险元数据, 参数/数据分级, 目标/动作分级, permission.requireConfirmation)`。
任何命中**对外承诺 / 敏感数据 / 资金 / 不可逆**的执行**强制 high**，**不能**被 A0 的 `medium` 标记或
上级 worker approval 降级。即「数据取数 medium + 上级数字员工批准」若实际访问敏感数据，仍走人类审批。
有效风险的判定**必须确定性**（A0 字段 + 工具 metadata + 确定性 action classifier），**禁止用 LLM 判风险等级**。

### D0.3 — 零-LLM 红线保持

审批/路由/风险判定全部是**确定性规则**（读 A0 契约字段 + 配置矩阵），无运行时 LLM。执行本身由
`ToolInvocationPipeline` 跑真实工具——工具可以是任何东西，但**决定要不要执行、要不要审批的逻辑**
是确定性的（ADR-0047 不破）。

### D0.3.1 — medium 上级 worker 审批的确定性边界（Codex 复审 铁律 2）

当 enterprise policy 允许上级数字员工审批 medium 时，approval 必须满足**全部**确定性约束：
- **不得自批**（approver ≠ requester worker）；
- approver worker 必须 **active** + **同 org** + 与 requester 存在**当前有效的 reporting edge**（是其直接上级）；
- 只能批 **medium 且非敏感/非对外/非资金/非不可逆**（命中任一 → 升级人类，见铁律 1）；
- approval **单次绑定**到具体 `(task_id, tool_id, action_hash)`，有**过期**与**可撤销**；
- 默认配置是**人类审批**；worker 审批是 opt-in。

### D0.4 — 法律 principal 必须绑定具体授权 + 落审计（Codex 复审 铁律 3）

`org_worker` 真实执行**不得**以 `invokerUserId=null` 进入 pipeline。每个 invocation 必须固化人类
法律 principal：记录 `agencyAuthorizationId + principalUserId`（pipeline 选定具体授权书并把 principal
写进审计），否则「法律 principal」只是文档语义而非系统不变量。

每个真实执行留可追溯的因果链：`org_task → worker(actor) → org_approval(若需) → agencyAuthorization
→ tool_invocation → principalUserId(人类)`。所有 message/report/delegation/approval/invocation 带
correlation id 互相关联。失败/超时/pending_confirmation 都回写 task + report（不留半成品，延续 M1
原子性原则）。

### D0.4.1 — 人类审批门与 pipeline confirmation 叠加而非替代（Codex 复审 铁律 4）

两者是**两层**，不是二选一：
- **D2 人类审批门**：进入 pipeline **之前**的组织治理门（高风险无人类 approval 不得调用 pipeline）；
- **pipeline confirmation token**（ADR-0048 既有）：工具/动作级的二次确认，在 pipeline **内部**。

高风险执行**必须先有人类 approval**；若 tool permission / adapter 还要求 confirmation，则仍走
`pending_confirmation`。绝不能用 pipeline confirmation 顶替 D2 人类审批门。

### D0.5 — 分阶段实现（D1/D2/D3）

| 阶段 | 内容 | 前置 |
|---|---|---|
| **D1** | `org_worker` actor 语义：`invokerType` 扩展 + worker→persona/tool-permission 映射 + 审计保留人类 principal | 本 ADR |
| **D2** | `org_approvals` 表 + 审批状态机 + 风险→人类审批门（高风险无人类审批不执行；可撤销/过期） | D1 |
| **D3** | IC 执行从 stub 换成按 `allowsToolExecution` + 审批结果调 `ToolInvocationPipeline`；成功/失败/超时/pending 回写 | D2 |

## Consequences（后果）

### 正面
- 数字员工能真正干活，但**永远在人类法律责任 + 高风险人类审批**的边界内——不会变成越权 agent。
- 复用既有 `ToolInvocationPipeline` 全套（授权/预算/确认/审计），不重造执行基建。
- A0 的 `riskLevel`/`allowsToolExecution` 契约直接驱动审批矩阵——前期投资兑现。
- 零-LLM 论点保持（执行决策确定性）。

### 负面 / 风险
| 风险 | 缓解 |
|---|---|
| 上级 persona 批准被误当法律授权 | 本 ADR D0.1 铁律 + 代码层 `org_approvals` 区分 approver_worker_id vs approver_user_id |
| 高风险动作绕过人类审批 | D0.2 矩阵 high 必须人类；D2 实现「无人类审批不执行」硬门 |
| 真实工具副作用不可逆 | 不可逆操作归 high；保留 ADR-0048 的 confirmation token 机制 |
| 审计链断裂 | D0.4 强制 correlation id 全链关联 |

### 不在本 ADR 范围
- 具体工具适配器实现（D3）
- worker→tool-permission 映射的具体 schema（D1）
- approval UI（E 链）

# 0058 — 双边工单市场：组织/数字人格竞标接单，发布者确认委派

**Status:** Accepted（架构；分阶段——M0 本 ADR 仅定双边状态机 + assignee 抽象 + 红线 + 分片路线，M1-M5 后续实现）

**关联：** [[0048]] persona 自主赚钱（已有 persona 市场）、[[0055]] 数字员工执行治理、本仓库 `org-marketplace-wallet`（org wallet + 外部引用接单 S1-S4，已实现）。

---

## Context（背景）

系统已有两套互不相通的工单能力：

1. **persona 工单市场**（ADR-0048）：`marketplace_tasks` 表 + 完整双边流程——发布者 `publishTask` → persona `applyToTask`（申请）→ 发布者 `assignTask`（从申请者里选一个指派）→ persona `submitTaskResult` → 发布者 `acceptSubmittedTask`（验收+结算入 persona 钱包）。**接单方只能是单个 persona。**
2. **org 接单（外部引用模型，本仓库 S1-S4）**：org admin 自己填工单信息直接接单 → `runGoal` 分解 → 结算入 org wallet。**无发布者、无双向确认**——是 admin 单方动作。

### 用户意图（已澄清，对话 3 轮 + AskUserQuestion）

> 「添加 UI，组织的管理员可以领取工单市场的任务，由工单发布者确认委派给哪个组织或单个数字人格。任务待工单发布者确认后实施。后续需对工单发布者验资。」

拆解为四点 + 已选方向：

| 需求 | 已选方向 |
|---|---|
| 组织 admin **领取**工单市场任务 | **扩展现有 persona 市场**收组织接单方（复用 marketplace_tasks 双边状态机），非新建市场 |
| 发布者**确认委派**给「组织 **或** 单个数字人格」 | **assignee 统一抽象**：`{kind: 'org'|'persona', id}` 二选一 |
| 任务**待发布者确认后**才实施 | 复用现有 `assignTask`（open→assigned，发布者鉴权），确认前不实施 |
| **后续验资**（KYC/资质审核发布者） | **留钩子**（加 `publisher_verified` 字段，默认 unverified，不实现 KYC 逻辑） |

### 现有资产可复用度（勘探结论）

- `marketplace_tasks` 双边状态机 open→accepted→completed：**直接复用**
- `assignTask`（发布者从 submitted 申请里选一个指派，校验 `task.publisherUserId === actorUserId`，工单 open→accepted）：**这就是「发布者确认委派」的核心**，扩展 assignee 类型即可
- `applyToTask`（申请，写 task_applications）：扩展 applicant 类型即可
- org wallet + `OrgWalletService.settleOrgTaskPayment`（本仓库 S1-S4 已建）：**org 接单结算直接复用**
- 前端 `apps/web/src/features/marketplace/`：已有市场页（persona 视角），扩展即可

---

## Decision（决策）

### D1 — assignee/applicant 统一抽象：加列而非 polymorphic 重构（向后兼容铁律）

**不**做破坏性的 polymorphic ID 重构（drop `assignee_persona_id`）。用**加列**方案，现有 persona 行零改动：

```
marketplace_tasks:   + assignee_kind('persona'|'org' 默认 persona) + assignee_org_id(nullable)
                     + publisher_verified(integer 默认 0，验资留钩子)
task_applications:   + applicant_kind('persona'|'org' 默认 persona) + applicant_org_id(nullable)
task_assignments:    + assignee_kind('persona'|'org' 默认 persona) + assignee_org_id(nullable)
```

- 全部 nullable + 默认 'persona'：既有行 = persona 接单，行为不变。
- `assignee_kind='persona'` 用 `assignee_persona_id`；`='org'` 用 `assignee_org_id`。**XOR 不变量**：恰好一个非空（service 层守卫 + 可选 CHECK）。
- 申请唯一约束从 `(tenant, task, persona_id)` 扩展为按 applicant 身份去重（org 申请同一工单也只一次）。

### D2 — 双边流程：org 复用 apply→assign，分支按 kind（85% 复用）

| 步骤 | persona 流程（不变） | org 流程（新增分支） |
|---|---|---|
| 1 发布 | `publishTask`（发布者） | 同 |
| 2 领取 | persona owner `applyToTask(personaId)` | **org admin `applyToTask(orgId, kind='org')`** |
| 3 申请记录 | `task_applications.persona_id` | `task_applications.applicant_org_id` + `applicant_kind='org'` |
| 4 **确认委派** | 发布者 `assignTask(personaId)` | **发布者 `assignTask(orgId, kind='org')`**（同一鉴权：`publisherUserId===actorUserId`） |
| 5 指派记录 | `task_assignments.persona_id` | `task_assignments.assignee_org_id` + `assignee_kind='org'`，工单 open→accepted |
| 6 **实施** | persona 跑 runtime session | **org `runGoal` 分解委派给员工**（复用 S4 分解链，工单 assign 后触发） |
| 7 提交 | persona `submitTaskResult` | org admin 代表提交（org 完成后） |
| 8 验收+结算 | 发布者验收 → persona 钱包 | 发布者验收 → **org wallet**（复用 S3 `settleOrgTaskPayment`） |

**关键：第 4 步「发布者确认委派」是已有 `assignTask` 的天然能力**——它本就校验调用者是发布者、从 submitted 申请里选一个。扩展点只是「选的可以是 org 申请」。

### D3 — 执行模型差异：org 接单后触发 runGoal（非 persona runtime session）

persona 接单：persona 自己跑 runtime session 产出。
org 接单：**assign 成功后**，用 org 的 `runGoal`（本仓库 S4 已实现的分解链）把工单变成 org goal，确定性分解委派给组织员工。`sourceMarketplaceTaskId` 溯源到工单。这一步复用已有代码，零新执行引擎。

### D4 — 结算差异：org 走 org wallet，跳过 persona 专属成长

persona 验收结算：三方分账入 persona 钱包 + 更新 persona reputation/growth_index/governance。
org 验收结算：**两方分账入 org wallet**（复用 `settleOrgTaskPayment`，S3 已建），**跳过** persona 专属的 reputation/growth 更新（org 没有 persona 成长模型——不臆造新评分体系）。

### D5 — 验资留钩子（不实现 KYC）

`marketplace_tasks.publisher_verified`（默认 0）。本轮**不实现** KYC 审核逻辑，只：
- 加字段 + 类型
- 预留 service 校验点（注释标 `// 验资钩子：未来在此校验 publisher_verified`）
- UI 展示发布者「未验资」标记（提示性，不阻塞）

未来独立切片做真正的 KYC。

### D6 — applicant 排序分（org）：确定性默认，不引入新评分体系

persona 申请有 `ranking_score`（按 reputation/growth 算）。org 申请：给**确定性默认分**（如固定 0，或按 org 在职员工数/已完成工单数——纯计数，确定性），**不**引入「org capability scoring model」。发布者看到的是申请列表，自己判断委派给谁——排序分只是辅助，不是门槛。

### D7 — 向后兼容

- 既有 persona 市场流程**完全不变**（新列默认 persona）。
- 既有 HTTP 端点签名扩展为「可选 kind/orgId」字段，缺省=persona，旧客户端不受影响。
- 既有前端 persona 市场页保留，新增「组织视角」tab/视图。

---

## 红线（MUST，实现各片必须守）

1. **向后兼容铁律**：persona 市场既有行为零改动；新列默认 persona；旧客户端/旧数据正常工作。
2. **发布者确认才实施**：org 被 assign（发布者确认）**之前**，工单不进入 org 执行。applyToTask 只是登记意向，不触发任何执行/扣费。
3. **发布者鉴权不可绕**：assignTask/acceptSubmittedTask 必须校验 `task.publisherUserId === request.user.sub`，org 接单方不能自己 assign 给自己。
4. **assignee XOR 不变量**：一个工单/申请/指派的 assignee 恰好是 persona 或 org 之一，不可两者都有或都无。
5. **结算入对的账户**：assignee_kind='org' → 结算入 org wallet（org_wallets）；='persona' → persona 钱包。不可错账户。
6. **org 执行复用 runGoal**：org 接单的执行走已有确定性分解链（零-LLM），不新建执行引擎，不在 assign 事务里直接产生对外副作用（涉及对外的环节仍走 D 链审批门）。
7. **租户隔离**：所有新列/新查询带 tenant_id；**市场为租户内**（已定，2026-06-23）——发布者与接单组织同租户，复用现有 TenantDatabase 隔离，零架构风险。跨租户公开市场留未来独立切片。
8. **验资不阻塞但留痕**：publisher_verified 字段存在且默认 unverified；本轮不阻塞流程但 UI 标记，审计可查。
9. **幂等**：org 结算复用 `settleOrgTaskPayment` 的幂等（sourceMarketplaceTaskId 唯一）；org 申请同一工单只一次。
10. **新表/新列注册**：所有改动的表（task_applications/task_assignments/marketplace_tasks）若新增须在 privacy class + TenantDatabase isolation 同步；VERSION_MAP + 版本计数测试同步（参考本仓库 S1-S4 踩坑）。

---

## 分片路线（M0-M5，依赖排序，每片独立验证 + golden）

- **M0（本 ADR）**：冻结双边状态机 + assignee 抽象 + 红线 + 分片。spec-only。
- **M1 数据层**：迁移加列（3 表 + publisher_verified）；扩展唯一约束；row 类型 + kernel command/query 扩展（applicant_org/assignee_org）。向后兼容验证（既有 persona 行不变）。市场范围已定=**租户内**。
- **M2 service 双边扩展**：`applyToTask` 接受 `applicant: {kind, id}`；`assignTask` 接受 `assignee: {kind, id}`，按 kind 写 persona 或 org 列；发布者鉴权复用。org 申请排序分确定性默认。单测。
- **M3 org 执行 + 结算接线**：assign 给 org 成功 → 触发 `runGoal` 分解（S4 链）；submit/accept 流程 org 分支；验收结算入 org wallet（S3）。端到端测试（发布→org 申请→发布者确认→分解→提交→验收→org wallet 入账）。
- **M4 HTTP 路由**：扩展 apply/assign/submit/accept schema（可选 kind/orgId）；org 视角端点（org 看可领工单、org 的申请、org 的指派）。route-schema 快照。
- **M5 前端 UI**：扩展 `apps/web/src/features/marketplace/`——① 组织视角「可领工单列表 + 领取按钮」② 发布者视角「申请者列表（含 org/persona）+ 确认委派给谁」③ 验资标记展示。

**可并行**：M5 前端可在 M4 路由定型后并行；M2/M3 有依赖须串行。

---

## Consequences（影响）

**正面**：组织成为市场一等公民——能与单个数字人格同台竞标接单，发布者双向选择委派对象。复用现有双边状态机 + org wallet，新增代码集中在「按 kind 分支」，不重写市场。验资留钩子，未来可平滑接入 KYC。

**负面/成本**：改动触及 persona-core 核心市场表（marketplace_tasks/task_applications/task_assignments）——虽全向后兼容，仍是核心数据模型扩展，需 golden 全量回归。「市场是否跨租户」是 M1 前必须定的产品决策（发布者与接单 org 可能不同租户）。org 接单的「谁代表 org 提交结果」需明确（M3）。

**不做**：polymorphic ID 重构、org capability scoring model、真正的 KYC 审核、persona 成长模型套用到 org。

---

## 冻结声明

本 ADR 冻结双边工单市场的**状态机、assignee 抽象、执行/结算模型、红线、分片路线**。M1-M5 各片独立实现 + golden 验证（Codex 限额期间 Claude 自审，恢复后补审）。下一步由用户决定是否从 M1 实施，以及定夺「市场是否跨租户」这一 M1 前置产品决策。

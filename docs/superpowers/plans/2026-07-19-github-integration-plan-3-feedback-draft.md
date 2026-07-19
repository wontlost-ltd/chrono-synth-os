# GitHub 集成 Plan 3（反馈起草段 / feedback-draft）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development 逐任务实现。步骤用 `- [ ]` checkbox 跟踪。

**Goal:** 让数字人基于已学的 GitHub 记忆 + 一个 issue/PR 的上下文，**零-LLM 起草**一条评论/review 草稿，存为「待审批草稿」（停在 drafted 态），不发布。手动触发为主（`draft-github-reply` 端点），webhook 接收器作可选入口（签名校验+幂等，本地不阻塞验收）。

**Architecture:** 复用 Plan 1 `GitHubReadPort`（读 issue/PR 上下文）+ 已学 GitHub 记忆（Plan 2 沉淀）+ 参照 `OfflineConversationResponder` 的零-LLM 拼装做 `GitHubResponseComposer`。草稿存**独立轻量表 `github_reply_drafts`**（不走 workforce）。发布留 Plan 4。

**Tech Stack:** Node.js + TypeScript；复用 `GitHubReadPort`(Plan 1)、`OfflineConversationResponder` 拼装模式、companion 路由骨架 + `assembleReadPort`(learn-github.ts)、记忆检索、Stripe webhook 的 preParsing raw-body + ON CONFLICT 幂等模式、schema-dsl 迁移。

## 与 spec §5.3 的偏离（基于真实契约的合理简化，须知悉）

spec §5.3 原设计：webhook → 创建 **workforce 任务**（delegated）→ 起草 → **ApprovalService** 审批门 → 发布。契约核实（Plan 3 探针）发现：
- workforce **无「建单个 task」入口**——唯一路径 `OrgPlanningService.runGoal` 强制 org+positions+workers+reporting edges+playbook 全套；对「手动起草一条回复草稿」是巨大装配负担且**语义不匹配**（草稿不是组织目标）。
- `ApprovalService` 的 subjectType 只有 `task_execution`/`tool_invocation`，绑 org worker/执行风险——与「草稿待审批」语义不符。

**故 Plan 3 首版改用独立轻量 `github_reply_drafts` 表**：起草停 `drafted`（即待审批态），人工 approve = 置 `approved`（无需 workforce/ApprovalService）。**Plan 4（发布）再评估**：把 `approved` 草稿喂 WritePort 发布时，那里是真「执行/对外副作用」——届时 ApprovalService 的执行门 + workforce 才语义匹配（spec §5.3 的审批门在 Plan 4 落地，不在 Plan 3）。这是 YAGNI + 语义匹配的简化，不弱化安全（Plan 3 本就不发布，无对外副作用；真正的不可降级人工审批门在 Plan 4）。playbook（github_issue_triage/pr_review）也随之推迟到 Plan 4（若届时确定走 workforce）。

## Global Constraints（每个任务隐含遵守）

- **零-LLM 内核铁律**：`GitHubResponseComposer` 是**零-LLM 确定性编译器**（参照 `OfflineConversationResponder`，纯拼装，无 LLM/无 IO）。起草只用已沉淀记忆 + issue 上下文，不调模型。
- **不发布**（Plan 3 边界）：本 plan **绝不**对 GitHub 写任何东西（评论/review）。只起草 + 存草稿。无 GitHubWritePort、无写工具（那是 Plan 4）。ReadPort 仍只读。
- **webhook 签名校验 fail-closed**：webhook 接收器（可选）必须校验 `X-Hub-Signature-256`（HMAC-SHA256 + timingSafeEqual），失败直接拒不进流程；无现成助手，自建 `createHmac('sha256', secret)`。
- **webhook 幂等**：用独立 `github_webhook_events` 表（不动 Stripe 的 `webhook_events`），`ON CONFLICT DO NOTHING` + rowsAffected 判重投。
- **installation→tenant 反查 fail-closed**（沿用 Plan 1）：webhook 入站用 `(github_host, installation.id)` 反查租户，多/零行拒。
- **新表双登记**：`github_reply_drafts`、`github_webhook_events` 登记进 `tenant-database.ts` `TENANT_TABLES` + `privacy-service.ts` `TENANT_TABLES`。迁移同步 schema-dsl 全部同步点（**全局迁移号** + **legacy fixture 两数组**——Plan 1/2 教训）。
- **per-persona**：草稿按 `(tenant_id, persona_id)` 隔离；companion 侧 personaId='default'。

## File Structure

- `packages/schema-dsl/src/migrations/server-raw/vNNN.ts`（新迁移，建两表）+ 全部同步点。
- `packages/kernel/src/domain/agent/github-draft-types.ts`（新，两表 Row + Query/Command，kernel 零 SQL）。
- `src/storage/github-draft-store.ts`（新，草稿 CRUD + webhook 幂等 claim）+ executor + 注册。
- `src/integrations/github/github-response-composer.ts`（新，零-LLM 起草——本 plan 唯一新领域逻辑）。
- `src/server/routes/companion/draft-github-reply.ts`（新，`POST /api/v1/companion/me/draft-github-reply` + 草稿列表/审批端点）+ 注册。
- `src/server/routes/github-webhook.ts`（新，可选 webhook 接收器，签名+幂等）+ 注册。
- 测试：各 `src/test/unit/github-draft-*.test.ts` + `src/test/integration/github-draft-e2e.test.ts`。

---

### Task 1：迁移建 `github_reply_drafts` + `github_webhook_events` 两表

**Files:**
- Create: `packages/schema-dsl/src/migrations/server-raw/vNNN.ts`（NNN=全局最新+1，`ls -t` 两家族确认；Plan 2 是 v120/pg v122，故约 v121/pg v123，**必须 ls 核实**）
- Modify: schema-dsl 全部同步点（迁移/index/version-map/parity/**legacy fixture 两数组**/VERSION_MAP range）
- Modify: `tenant-database.ts` `TENANT_TABLES` + `privacy-service.ts` `TENANT_TABLES`
- Test: `test:packages` + `schema-dsl-sqlite-parity.test.ts` + 隔离/隐私 ratchet

**Interfaces:**
- Produces:
  - `github_reply_drafts(id TEXT PK, tenant_id TEXT NOT NULL, persona_id TEXT NOT NULL, repo TEXT NOT NULL, target_type TEXT NOT NULL, target_number INTEGER NOT NULL, draft_body TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`；`target_type` CHECK in (`issue`,`pull`)；`status` CHECK in (`drafted`,`approved`,`rejected`)。
  - `github_webhook_events(delivery_id TEXT, tenant_id TEXT NOT NULL, event_type TEXT NOT NULL, processed_at INTEGER NOT NULL, PRIMARY KEY (tenant_id, delivery_id))`。

- [ ] **Step 1: 确认全局迁移号 + 读 Plan 2 的 v120 做模板**

Run: `ls -t packages/schema-dsl/src/migrations/server-raw/v*.ts packages/schema-dsl/src/migrations/server-simple/v*.ts | head -5`
读 `server-raw/v120.ts`（Plan 2 建的 github 表迁移）做模板——格式、legacy fixture 加法直接照搬。

- [ ] **Step 2: 写迁移文件（两表，双库，SQLite INTEGER / PG BIGINT）**

照 v120。两表 + 各自 CHECK。`github_webhook_events` PK 复合 `(tenant_id, delivery_id)`。

- [ ] **Step 3: 同步全部 schema-dsl 同步点（含 legacy fixture 两数组）**

`server-raw/index.ts` 注册 / version-map / parity 期望 / **`legacy-migrations.ts` 的 LEGACY_SQLITE + LEGACY_POSTGRES 两数组各加一条**（Plan 1 漏过、Plan 2 补对——照 Plan 2 的加法）/ VERSION_MAP range。

- [ ] **Step 4: 双登记 GDPR/隔离**

`tenant-database.ts` `TENANT_TABLES` + `privacy-service.ts` `TENANT_TABLES` 各加两表。

- [ ] **Step 5: 重建 dist + 全套验证（含 parity 集成测试）**

Run:
```
npx tsc -b packages/schema-dsl/tsconfig.json --force
npm run test:packages 2>&1 | tail -6
node --test --import tsx src/test/integration/schema-dsl-sqlite-parity.test.ts 2>&1 | tail -6
node --test --import tsx src/test/unit/tenant-database-isolation-coverage.test.ts src/test/unit/privacy-tenant-table-coverage.test.ts 2>&1 | grep -E "pass|fail"
```
Expected: 全绿。

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(github): 迁移建 github_reply_drafts + github_webhook_events（双登记，含 legacy fixture）"
```

---

### Task 2：kernel 契约 `github-draft-types.ts`

**Files:**
- Create: `packages/kernel/src/domain/agent/github-draft-types.ts`
- Modify: `domain/agent/index.ts` barrel（加 export）
- Test: `src/test/unit/github-draft-types.test.ts`

**Interfaces:**
- Consumes: 照 `github-learn-types.ts`（Plan 2）/`github-app-types.ts`（Plan 1）的 `{kind, params}` 风格，**kernel 零 SQL**。
- Produces:
```typescript
export interface GithubReplyDraftRow { id, tenant_id, persona_id, repo, target_type, target_number: number, draft_body, status, created_at, updated_at }
export interface GithubWebhookEventRow { delivery_id, tenant_id, event_type, processed_at }
export function githubDraftInsert(params: {...}): Command;
export function githubDraftQueryById(params: {id, tenantId}): Query<GithubReplyDraftRow|null>;
export function githubDraftListByPersona(params: {tenantId, personaId, status?}): Query<GithubReplyDraftRow>;  // 多行
export function githubDraftUpdateStatus(params: {id, tenantId, status, now}): Command;  // drafted→approved/rejected
export function githubWebhookEventClaim(params: {tenantId, deliveryId, eventType, now}): Command;  // INSERT ON CONFLICT DO NOTHING
```

- [ ] **Step 1: 读参照 github-learn-types.ts + 写失败测试**

写 `github-draft-types.test.ts`：断言 factory 的 params 携带正确键 + kind 专用（尤其 `githubWebhookEventClaim` 的 claim kind）。先跑确认 FAIL。

- [ ] **Step 2: 写 types.ts + barrel 导出**

按 Produces，紧贴 github-learn-types 工厂风格。

- [ ] **Step 3: 编译 + 测试通过**

Run: `npx tsc -b packages/kernel/tsconfig.json --force && node --test --import tsx src/test/unit/github-draft-types.test.ts`

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat(github): kernel 契约 github-draft-types（reply_drafts + webhook_events）"
```

---

### Task 3：`GithubDraftStore`（草稿 CRUD + webhook 幂等 claim）

**Files:**
- Create: `src/storage/github-draft-store.ts` + `src/storage/executors/github-draft-executors.ts`（+ 注册 index.ts）
- Test: `src/test/unit/github-draft-store.test.ts`

**Interfaces:**
- Consumes: Task 2 的 query/command；`SyncWriteUnitOfWork`。
- Produces:
```typescript
export class GithubDraftStore {
  constructor(tx: SyncWriteUnitOfWork, tenantId?: string);
  createDraft(personaId, repo, targetType, targetNumber, draftBody, now): string;  // 返 draft id
  getDraft(personaId, id): GithubReplyDraftRow | undefined;
  listDrafts(personaId, status?): GithubReplyDraftRow[];
  setStatus(personaId, id, status: 'approved'|'rejected', now): boolean;  // 仅 drafted→approved/rejected
  claimWebhookEvent(deliveryId, eventType, now): boolean;  // INSERT ON CONFLICT DO NOTHING；true=新，false=重投
}
```

- [ ] **Step 1: 写失败测试**

`github-draft-store.test.ts`：
- `createDraft→getDraft 往返，status=drafted`
- `setStatus drafted→approved；已 approved 不可再改`（幂等/状态机）
- `listDrafts 按 status 过滤 + persona 隔离`
- `claimWebhookEvent 首次 true 二次同 delivery_id false`（幂等去重）
- 跨租户隔离

- [ ] **Step 2: 跑测试确认 FAIL**

Run: `node --test --import tsx src/test/unit/github-draft-store.test.ts`

- [ ] **Step 3: 写 store + executor**

`claimWebhookEvent` executor：`INSERT ... ON CONFLICT (tenant_id, delivery_id) DO NOTHING` + rowsAffected 判。`setStatus` 只允许 drafted→approved/rejected（WHERE status='drafted' 保护，或读后判）。照 Plan 1/2 executor 注册模式。

- [ ] **Step 4: 测试通过**

Run: `npx tsc -b tsconfig.src.json && node --test --import tsx src/test/unit/github-draft-store.test.ts`

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(github): GithubDraftStore 草稿 CRUD + webhook 幂等 claim"
```

---

### Task 4：`GitHubResponseComposer`（零-LLM 起草）

**Files:**
- Create: `src/integrations/github/github-response-composer.ts`
- Test: `src/test/unit/github-response-composer.test.ts`

**Interfaces:**
- Consumes: `OfflineConversationResponder`（`src/conversation/offline-conversation-responder.ts`，`respond(input: OfflineResponderInput): OfflineResponse`）——**参照/复用其拼装模式**；已学 GitHub 记忆（`RelevantKnowledge[]` 形状）；issue/PR 上下文。
- Produces:
```typescript
export interface DraftInput { narrative: string; targetTitle: string; targetBody: string; targetType: 'issue'|'pull'; relevantKnowledge: RelevantKnowledge[]; }
export interface DraftResult { body: string; kind: 'knowledge_grounded'|'honest_offline'; groundedCount: number; }
export function composeGithubReply(input: DraftInput): DraftResult;  // 零-LLM 纯函数
```
起草模式：把 issue/PR 标题+正文当"用户输入"，已学记忆当 `relevantKnowledge`，用 `OfflineConversationResponder` 同款拼装（narrative lead + top-3 grounded 记忆 + issue 上下文）生成评论/review 草稿文本。**零-LLM，纯确定性**（同输入同输出）。

- [ ] **Step 1: 写失败测试**

`github-response-composer.test.ts`：
- `有相关记忆 → knowledge_grounded，草稿含记忆内容 + issue 标题呼应`
- `无相关记忆 → honest_offline（不编造）`
- `零-LLM 确定性：同输入同输出`（跑两次断言 body 相同）

- [ ] **Step 2: 跑测试确认 FAIL**

Run: `node --test --import tsx src/test/unit/github-response-composer.test.ts`

- [ ] **Step 3: 写 composer**

复用 `OfflineConversationResponder` 或照其 `composeFromKnowledge` 模式（narrative + knowledgeLeadIn + 每条 content.slice(0,280)）。issue 上下文作 userInput。纯函数无 IO。

- [ ] **Step 4: 测试通过**

Run: `npx tsc -b tsconfig.src.json && node --test --import tsx src/test/unit/github-response-composer.test.ts`

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(github): GitHubResponseComposer 零-LLM 起草评论/review 草稿"
```

---

### Task 5：`draft-github-reply` 端点 + 草稿列表/审批端点

**Files:**
- Create: `src/server/routes/companion/draft-github-reply.ts`
- Modify: `src/server/app.ts`（注册，照 learn-github 位置）
- Test: `src/test/integration/github-draft-e2e.test.ts`

**Interfaces:**
- Consumes: `GitHubReadPort`(Plan 1，list+find 取单个 issue/PR)、`GithubDraftStore`(Task 3)、`composeGithubReply`(Task 4)、记忆检索、companion 骨架 + `assembleReadPort`（照 learn-github.ts）。
- Produces:
  - `POST /api/v1/companion/me/draft-github-reply`，body `{ repo, targetType: 'issue'|'pull', targetNumber }` → 起草 → 存 draft(drafted) → 返 `{ draftId, body, kind, groundedCount }`。无凭据→4xx。
  - `GET /api/v1/companion/me/github-drafts?status=drafted` → 列草稿。
  - `POST /api/v1/companion/me/github-drafts/:id/approve` / `.../reject` → 人工审批（置 approved/rejected；**本 plan 不发布**，只改状态）。

- [ ] **Step 1: 写 E2E**

`github-draft-e2e.test.ts`（真 tenantOS + mock ReadPort 喂固定 issue + 先 seed 些已学记忆）：
- `draft-github-reply：读 issue → 起草 → 存 drafted → 返 body 含 grounded 记忆`
- `起草是零-LLM`（不注入 LLM provider 也能起草——纯确定性）
- `列草稿 + approve → status=approved`（**不触发任何 GitHub 写**——断言无对外调用）
- `无凭据 → 4xx`
- **关键：本 plan 绝不写 GitHub**——断言起草/审批全程无 WritePort/无对外 POST（结构上 Plan 3 就没有写能力）

- [ ] **Step 2: 跑测试确认 FAIL**

Run: `node --test --import tsx src/test/integration/github-draft-e2e.test.ts`

- [ ] **Step 3: 写端点 + 注册**

`draft-github-reply.ts`：装配 ReadPort（复用 assembleReadPort）→ `listIssues/listPulls` + `.find(n)` 取单条 → 检索已学记忆 → `composeGithubReply` → `store.createDraft(...)`。列表/审批端点直接走 store。注册进 app.ts。

- [ ] **Step 4: 测试通过 + 路由快照**

Run: `npx tsc -b tsconfig.src.json && node --test --import tsx src/test/integration/github-draft-e2e.test.ts`
（若 route-schema 快照因新端点红，`UPDATE_SNAPSHOTS=1` 重生——先 build）

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(github): draft-github-reply 端点 + 草稿列表/审批（起草停 drafted，不发布）"
```

---

### Task 6：`github-webhook` 接收器（可选入口，签名+幂等）

**Files:**
- Create: `src/server/routes/github-webhook.ts`
- Modify: `src/server/app.ts`（注册）
- Test: `src/test/integration/github-webhook.test.ts`

**Interfaces:**
- Consumes: `GithubDraftStore.claimWebhookEvent`(Task 3 幂等)、`GithubAppCredentialStore.resolveTenantByInstallation`(Plan 1 反查) + webhook secret 验签、Stripe 的 preParsing raw-body 模式（`billing.ts`）、Node `crypto.createHmac`/`timingSafeEqual`。
- Produces: `POST /api/v1/integrations/github/webhook`——① 拿 raw body（preParsing）② 用 payload `installation.id` 反查租户 + 取 webhook secret ③ 校验 `X-Hub-Signature-256`（HMAC-SHA256，失败→401）④ 幂等 claim（重投→200 直接返）⑤ issue/PR 事件 → 触发起草（复用 Task 5 的起草逻辑，存 drafted）。**不发布**。

- [ ] **Step 1: 写测试（构造带签名的 payload）**

`github-webhook.test.ts`：
- `正确 X-Hub-Signature-256 → 起草任务创建`（真 HMAC 签一个 issue-opened payload）
- **`错误签名 → 401 拒绝，不进流程`**（变异关键）
- `重投同 delivery_id → 幂等，不重复起草`
- `installation 反查不到租户 → 拒绝（fail-closed）`

- [ ] **Step 2: 跑测试确认 FAIL**

Run: `node --test --import tsx src/test/integration/github-webhook.test.ts`

- [ ] **Step 3: 写接收器 + 注册**

preParsing 拿 raw body（照 billing.ts）；自建 `verifyGithubSignature(rawBody, sig, secret)` = `timingSafeEqual(Buffer.from('sha256='+createHmac('sha256',secret).update(rawBody).digest('hex')), Buffer.from(sig))`；反查租户 fail-closed；claimWebhookEvent 幂等；issue/PR opened → 起草存 drafted。注册进 app.ts（路径前缀 `integrations/github`，非 companion）。

- [ ] **Step 4: 测试通过**

Run: `npx tsc -b tsconfig.src.json && node --test --import tsx src/test/integration/github-webhook.test.ts`

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(github): github-webhook 接收器（签名校验+幂等+反查 fail-closed，issue/PR→起草，不发布）"
```

---

## Self-Review（写完计划后自查）

- **Spec 覆盖**：Plan 3 覆盖 spec §5.3 的**起草侧**（webhook 接收器/签名+幂等/反查 fail-closed/零-LLM 起草/待审批态）。**发布侧 + 不可降级人工审批门明确留 Plan 4**（Plan 3 不发布，无对外副作用，故无需 Plan 4 的执行门）✓。
- **偏离标注**：workforce/ApprovalService → 轻量 draft 表的偏离已在「与 spec §5.3 的偏离」节说明理由（真实契约过重 + 语义不匹配）✓。
- **占位符**：无 TBD。Task 2 工厂签名指向 github-learn-types 真实源 ✓。
- **类型一致**：`GithubReplyDraftRow`(Task 2)→store(Task 3)→端点(Task 5)一致；`composeGithubReply`(Task 4)→端点消费；ReadPort/GitHubIssue 消费 Plan 1 已合入真类型 ✓。
- **安全不变量**：不发布（全 plan 无 WritePort/写工具，Task 5 E2E 断言无对外写）、webhook 签名 fail-closed(Task 6)、幂等(Task 3/6)、反查 fail-closed(Task 6)、双登记(Task 1) 全部落到具体 task ✓。
- **Plan 1/2 教训带入**：Task 1 明确全局迁移号 + legacy fixture 两数组 ✓。

## 后续 plan

- **Plan 4（反馈发布）**：`GitHubWritePort` + github 写工具（highRisk，唯一持 WritePort）+ 把 `approved` 草稿经**不可降级人工审批执行门**（此时接 ApprovalService/workforce 才语义匹配）发布到 GitHub + 架构依赖测试（WritePort 只 executor 组合根注入）+ 审批门变异测试。**spec §5.3 的「不可降级人工审批门」在此落地。**

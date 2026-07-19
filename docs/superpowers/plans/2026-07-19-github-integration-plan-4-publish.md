# GitHub 集成 Plan 4（反馈发布段 / publish）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development 逐任务实现。步骤用 `- [ ]` checkbox 跟踪。

**Goal:** 把 Plan 3 起草的 **approved 草稿**真正发布到 GitHub（对 issue 发评论 / 对 PR 发 review），经**不可降级人工审批门**（highRisk 工具 → ToolInvocationPipeline confirmation gate）+ 原子防重复发布。完成整个 GitHub 集成闭环（接→学→起草→发布）。

**Architecture:** `GitHubWritePort`（写：createIssueComment/createReview，与 ReadPort 严格读写分离）由**唯一持有者** github 写工具（highRisk）经 `ToolInvocationPipeline` 调用——pipeline 的 confirmation gate 即「不可降级人工审批门」（token 服务端签发+input-hash 绑定+一次性+不可绕）。发布端点：approved 草稿 → 原子 CAS 占位（status approved→published，防重复）→ pipeline.invoke(highRisk 写工具) → 人工确认 → 真发。**不走 workforce**（Plan 3 draft 非 workforce task，语义不匹配 + 大量假接线）。

**Tech Stack:** Node.js + TS；复用 `github-auth-manager`/`githubFetch`(Plan1)、`ToolAdapter`/`ToolInvocationPipeline`/`ConfirmationTokenStore`(既有)、`GithubDraftStore`(Plan3)、schema-dsl 迁移。

## Global Constraints（每个任务隐含遵守）

- **不可降级人工审批门（本 plan 核心安全命题，spec §5.3）**：github 写工具 `metadata.highRisk=true` → `ToolInvocationPipeline` confirmation gate（`tool-invocation-pipeline.ts:151`）强制签发 `pending_confirmation` token（`confirmation-token-store.ts`）——**服务端签发、与 arguments input-hash 绑定、一次性消费、body 无法伪造/绕过**。无 token 首次调用只签发不执行；带 token 二次调用才真发。**代码路径上不可降级**（body 改不了 highRisk、改 args 使 token 失效）。
- **读写严格分离**：`GitHubWritePort`（写）与 `GitHubReadPort`(Plan1，只读) 是两个独立接口。**WritePort 只被 github 写工具 import**；ReadPort 无写方法。加架构依赖测试锁死（Task 6）。
- **原子防重复发布**：同一 approved 草稿不得发两次。发布前 `UPDATE ... SET status='published' WHERE id=? AND status='approved'`，`rowsAffected===1` 才继续调 WritePort（**先 claim 再发**，非 check-then-act）；0=已发布/未批准→拒。
- **发布只从 approved**：draft 状态机 drafted→approved→published（rejected 终态）。发布端点只接受 approved（Plan 3 的 approve 端点把 drafted→approved）。
- **出站唯一出口 + SSRF**（延续 Plan1）：WritePort 所有写调用经 `githubFetch`（host allowlist api.github.com + https）。
- **人类主体**：发布是对外不可逆副作用——confirmation 的人工确认即人类放行（pipeline 记 invokerUserId 审计）。
- **零-LLM**：发布是纯网络动作，无 LLM。草稿内容是 Plan 3 已确定性起草的 draft_body，发布不改内容。
- **迁移同步 + 双登记**（延续）：`'published'` 态改 CHECK 走迁移，同步 schema-dsl 全部同步点（**全局号 + legacy fixture 两数组 + server-raw 断言列**——Plan 1/2/3 教训）。
- **jwt 豁免精确性**（Plan 3 遗留 Low，本 plan 前置）：发布端点若挂 `/integrations/github/` 前缀，须补测试断言该前缀下非 webhook 路径需鉴权 401（防未来误改宽前缀暴露 highRisk 发布端点）。

## File Structure

- `packages/schema-dsl/src/migrations/server-raw/vNNN.ts`（迁移：draft status CHECK 加 'published' + 可选 published_at/github_ref 列）+ 全部同步点。
- `packages/kernel/src/domain/agent/github-draft-types.ts`（Plan3 已建，改：加 approved→published 的 updateStatus 变体 query/command）。
- `src/storage/github-draft-store.ts`（Plan3 已建，加：`claimForPublish`（原子 CAS）+ `markPublished`）+ executor。
- `src/integrations/github/github-write-port.ts`（新，`GitHubWritePort` 接口 + 实现）。
- `src/agent/tools/github-comment-tool.ts` / `github-review-tool.ts`（新，highRisk，唯一持 WritePort）+ 注册进 ToolRegistry。
- `src/server/routes/companion/draft-github-reply.ts`（Plan3 已建，加：`POST /github-drafts/:id/publish` 端点走 pipeline）。
- 测试：`github-write-port` 单测 + `github-publish-tool` 单测 + `github-publish-e2e`（审批门变异）+ `github-write-port-arch.test.ts`（架构依赖）+ jwt 豁免精确性测试。

---

### Task 1：迁移——draft status 加 'published' 态 + published_at 列

**Files:**
- Create: `packages/schema-dsl/src/migrations/server-raw/vNNN.ts`（NNN=全局最新+1；Plan3 是 v121/pg v123，故约 v122/pg v124，`ls -t` 两家族确认）
- Modify: schema-dsl 全部同步点（迁移/index/version-map/parity server-raw 断言列/**legacy fixture 两数组**/VERSION_MAP range）
- Test: `test:packages` + `schema-dsl-sqlite-parity.test.ts`

**Interfaces:**
- Produces: `github_reply_drafts` 的 `status` CHECK 从 `('drafted','approved','rejected')` 改为 `('drafted','approved','rejected','published')`；加列 `published_at INTEGER`（NULL）、`github_ref TEXT`（NULL，存发布后的 comment/review id 供审计+去重佐证）。

- [ ] **Step 1: 确认全局迁移号 + 读 Plan3 v121 做模板**

Run: `ls -t packages/schema-dsl/src/migrations/server-raw/v*.ts packages/schema-dsl/src/migrations/server-simple/v*.ts | head -5`
读 v121.ts。**注意 CHECK 改动**：SQLite 不能 ALTER CHECK，需重建表（照 v121 若有重建模式，或 v107 的 SQLite 表重建模式：RENAME→新表(新 CHECK)→INSERT SELECT→DROP 旧）；PG `ALTER TABLE ... DROP CONSTRAINT ... ADD CONSTRAINT`。

- [ ] **Step 2: 写迁移（双库，SQLite 重建 / PG alter constraint + 加列）**

SQLite：重建 github_reply_drafts（新 CHECK 含 'published' + 加 published_at/github_ref 列），INSERT SELECT 回填旧数据（旧行 status 都是 drafted/approved/rejected，兼容）。PG：`ALTER TABLE ... DROP CONSTRAINT + ADD CONSTRAINT`（新 CHECK）+ `ADD COLUMN published_at BIGINT` + `ADD COLUMN github_ref TEXT`。两库时间戳 INTEGER/BIGINT。

- [ ] **Step 3: 同步全部 schema-dsl 同步点（含 legacy fixture + server-raw 断言列）**

index 注册 / version-map / parity 期望 / **legacy fixture 两数组各加条目（新 CHECK + 两列）** / **server-raw.test.ts 的 assert.deepEqual(rawVersions,[...]) 加新 pg alias 号** / VERSION_MAP range。（Plan 2 就是漏 server-raw 断言列致 main 红——务必带上。）

- [ ] **Step 4: 重建 dist + 验证（含 parity 集成 + server-raw parity）**

Run:
```
npx tsc -b packages/schema-dsl/tsconfig.json --force
npm run test:packages 2>&1 | tail -6
node --test --import tsx src/test/integration/schema-dsl-sqlite-parity.test.ts 2>&1 | tail -6
node --test --import tsx 'packages/schema-dsl/test/parity/server-raw.test.js' 2>&1 | grep -E "pass|fail" || node --test --import tsx packages/schema-dsl/test/parity/server-raw.test.ts 2>&1 | grep -E "pass|fail"
```
Expected: 全绿（含 server-raw parity——注意它是 packages 内 test，用 test:packages 覆盖）。

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(github): 迁移 draft status 加 published 态 + published_at/github_ref 列（发布审计+去重）"
```

---

### Task 2：kernel 契约 + store 加发布态转换（approved→published 原子 CAS）

**Files:**
- Modify: `packages/kernel/src/domain/agent/github-draft-types.ts`（加 `githubDraftClaimForPublish` command + `githubDraftMarkPublished` command）
- Modify: `src/storage/github-draft-store.ts`（加 `claimForPublish` + `markPublished`）
- Modify: `src/storage/executors/github-draft-executors.ts`（真 SQL）
- Test: `src/test/unit/github-draft-store.test.ts`（扩，加发布态用例）

**Interfaces:**
- Consumes: Plan3 的 GithubReplyDraftRow / setStatus 模式。
- Produces:
```typescript
// store 新方法：
claimForPublish(personaId, id, now): GithubReplyDraftRow | undefined;  // 原子 CAS：UPDATE status='published'(占位) WHERE id AND persona AND status='approved'，rowsAffected===1 才返该行(含 draft_body)，否则 undefined
markPublished(personaId, id, githubRef, now): void;  // 发布成功后回填 github_ref + published_at（若 claimForPublish 已置 published，此处只补 ref）
```
**关键设计**：`claimForPublish` 是**原子占位**——先把 approved→published（`WHERE status='approved'` 保证只一次成功），拿到 draft_body 去发；发失败可留补偿（记 github_ref=null 表示占位但未确认发出，或回滚——Task 5 端点定）。防并发/重复发布靠这个 CAS。

- [ ] **Step 1: 写失败测试**

扩 `github-draft-store.test.ts`：
- `claimForPublish：approved 草稿首次返回该行(含 body)、状态转 published；再 claimForPublish 同 id 返 undefined（已 published，防重复发布）`
- `claimForPublish：drafted/rejected 状态 → undefined（只 approved 可发布）`
- `markPublished：回填 github_ref + published_at`
- 跨人格隔离（三键带 persona_id）

- [ ] **Step 2: 跑测试确认 FAIL**

Run: `node --test --import tsx src/test/unit/github-draft-store.test.ts`

- [ ] **Step 3: 写 kernel command + store + executor**

kernel 加两 command（`{kind,params}`，零 SQL）。executor：`claimForPublish` = `UPDATE github_reply_drafts SET status='published', published_at=? WHERE tenant_id=? AND persona_id=? AND id=? AND status='approved'` + 读回该行；rowsAffected===0→undefined。`markPublished` = `UPDATE ... SET github_ref=? WHERE ... AND id=?`。用 kind 常量 dispatch。

- [ ] **Step 4: 测试通过**

Run: `npx tsc -b packages/kernel/tsconfig.json --force && npx tsc -b tsconfig.src.json && node --test --import tsx src/test/unit/github-draft-store.test.ts`

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(github): draft 发布态转换 claimForPublish 原子 CAS（approved→published 防重复）+ markPublished"
```

---

### Task 3：`GitHubWritePort`（写端点：createIssueComment/createReview）

**Files:**
- Create: `src/integrations/github/github-write-port.ts`
- Test: `src/test/unit/github-write-port.test.ts`

**Interfaces:**
- Consumes: `GitHubAuthManager`(Plan1)、`githubFetch`(Plan1，出站网关)。
- Produces:
```typescript
export interface GitHubWritePort {
  createIssueComment(repo: string, issueNumber: number, body: string): Promise<{ id: number; htmlUrl: string }>;
  createReview(repo: string, prNumber: number, body: string, event: 'COMMENT'): Promise<{ id: number; htmlUrl: string }>;
}
export class GitHubWritePortImpl implements GitHubWritePort { constructor(auth: GitHubAuthManager); }
```
每方法：`token = await auth.getInstallationToken()` → `githubFetch(url, { method:'POST', headers:{Authorization:\`token ${token}\`, Accept:'application/vnd.github+json'}, body: JSON.stringify({body}) })` → 解析返回的 comment/review id + html_url。`createReview` 首版只发 `event:'COMMENT'`（不做 APPROVE/REQUEST_CHANGES 这种更高危动作——YAGNI + 降低误批准风险）。

- [ ] **Step 1: 写失败测试（mock fetch）**

`github-write-port.test.ts`：
- `createIssueComment 打 POST /repos/<repo>/issues/<n>/comments，带 token + body`
- `createReview 打 POST /repos/<repo>/pulls/<n>/reviews，event=COMMENT`
- `非 2xx → 抛错`
- `解析返回 id + htmlUrl`

- [ ] **Step 2: 跑测试确认 FAIL**

Run: `node --test --import tsx src/test/unit/github-write-port.test.ts`

- [ ] **Step 3: 写 write-port**

照 `github-read-port.ts` 的 request 模式，但 method POST + body。经 githubFetch。

- [ ] **Step 4: 测试通过**

Run: `npx tsc -b tsconfig.src.json && node --test --import tsx src/test/unit/github-write-port.test.ts`

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(github): GitHubWritePort 写端点（createIssueComment/createReview COMMENT，经 githubFetch）"
```

---

### Task 4：github 写工具（highRisk，唯一持 WritePort）+ 注册

**Files:**
- Create: `src/agent/tools/github-comment-tool.ts` / `src/agent/tools/github-review-tool.ts`
- Modify: ToolRegistry 注册点（`src/server/app.ts` 或 tool 注册处，照 email/calendar/web-search tool 的注册）
- Test: `src/test/unit/github-publish-tool.test.ts`

**Interfaces:**
- Consumes: `ToolAdapter` 接口(`src/agent/tool-adapter.ts`)、`GitHubWritePort`(Task 3)。
- Produces: `GithubCommentTool` / `GithubReviewTool` implements `ToolAdapter`：
  - `metadata = { id:'github.comment'/'github.review', highRisk: true, inputSchema:{repo,number,body}, defaultTimeoutMs, defaultMaxPerDay }`
  - `isHighRisk() = true`（恒高危）
  - `invoke(ctx)`：从 ctx.arguments 取 repo/number/body → 调 WritePort → wrapJson 返回 {id, htmlUrl}
  - **这两个工具是 `GitHubWritePort` 的唯一持有者**（构造注入；除它们 + 组合根 + 测试，别处不 import github-write-port）。

- [ ] **Step 1: 写失败测试**

`github-publish-tool.test.ts`：
- `metadata.highRisk === true`（两个工具都是）
- `invoke 调 WritePort.createIssueComment（mock WritePort，断言参数透传）`
- `invoke 返回 wrapJson 含 id/htmlUrl`

- [ ] **Step 2: 跑测试确认 FAIL**

Run: `node --test --import tsx src/test/unit/github-publish-tool.test.ts`

- [ ] **Step 3: 写工具 + 注册**

照 `email-tool.ts` 结构。注册进 ToolRegistry（照既有 tool 注册；WritePort 在此组合根注入这两个工具）。

- [ ] **Step 4: 测试通过**

Run: `npx tsc -b tsconfig.src.json && node --test --import tsx src/test/unit/github-publish-tool.test.ts`

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(github): github-comment/review 写工具（highRisk，唯一持 WritePort）+ 注册 ToolRegistry"
```

---

### Task 5：`publish` 端点（approved 草稿 → pipeline highRisk → 不可降级人工确认 → 真发）

**Files:**
- Modify: `src/server/routes/companion/draft-github-reply.ts`（加 `POST /github-drafts/:id/publish`）
- Test: `src/test/integration/github-publish-e2e.test.ts`

**Interfaces:**
- Consumes: `GithubDraftStore.claimForPublish/markPublished`(Task 2)、`ToolInvocationPipeline`(既有)、github 写工具(Task 4)。
- Produces: `POST /api/v1/companion/me/github-drafts/:id/publish`，body `{ confirmationToken?: string }`：
  1. `store.claimForPublish(persona, id, now)` 原子占位（approved→published）；undefined→4xx（未批准/已发布/不存在）。
  2. 拿到 draft（含 repo/target/body）→ `pipeline.invoke({ toolId: draft.targetType==='issue'?'github.comment':'github.review', tenantId, personaId, arguments:{repo, number:target_number, body:draft_body}, confirmationToken: body.confirmationToken })`。
  3. pipeline 返回 `pending_confirmation`（无 token 首次）→ 端点返回 `{ status:'pending_confirmation', confirmationTokenId }`（**此时已 claim 但未真发**——见下补偿）；带 token 二次 → 真发 → `store.markPublished(persona, id, githubRef)` → 返回 `{ status:'published', githubRef, htmlUrl }`。
  - **补偿设计（关键）**：claimForPublish 已把 status→published 占位，但 pipeline 首次返 pending 时其实没发出去。方案：claimForPublish 的占位改为**只在拿到 confirmation token 的二次调用路径**才置 published——即首次(无 token)**不 claim**，只探测 pipeline 是否需确认；二次(带 token)才 claimForPublish + invoke + markPublished。这样 pending 态不会误标 published。Task 实现时按此顺序（先确认 draft=approved 只读探测 → pipeline pending 返 token → 二次带 token 时 claimForPublish 原子占位 + 真发）。**wait**：更简的是 claimForPublish 只在「带 token 且 pipeline 将真执行」前一步做。实现者按「先 pipeline 确认流程，真执行前才原子 claim」落地，避免 pending 误占位。

- [ ] **Step 1: 写 E2E（审批门变异关键）**

`github-publish-e2e.test.ts`（真 tenantOS + 注入 WritePort spy + 先 seed 一条 approved draft）：
- **`无 confirmationToken → pending_confirmation（不发布）`**：断言 WritePort spy 零调用、draft 未 published
- **`带正确 token → 真发布`**：先拿 pending 的 token → 带 token 二次 → WritePort 被调、draft status=published、返 htmlUrl
- **`非 approved 草稿（drafted）→ publish 拒绝`**（只 approved 可发）
- **`重复 publish 同 approved 草稿 → 第二次拒绝`**（原子 CAS 防重复——第一次 published 后第二次 claimForPublish 返 undefined）
- **`篡改 body/args 使 token 失效`**（可选，验 input-hash 绑定）

- [ ] **Step 2: 跑测试确认 FAIL**

Run: `node --test --import tsx src/test/integration/github-publish-e2e.test.ts`

- [ ] **Step 3: 写端点**

按 Interfaces 流。**先 pipeline 探测确认（无 token 返 pending，不 claim）→ 带 token 二次调用时才 claimForPublish 原子占位 + invoke 真发 + markPublished**。注册进 companion 路由（app.ts 已注册 registerCompanionDraftGithubRoutes，加端点即可）。

- [ ] **Step 4: 测试通过**

Run: `npx tsc -b tsconfig.src.json && node --test --import tsx src/test/integration/github-publish-e2e.test.ts`

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(github): publish 端点（approved→pipeline highRisk→不可降级人工确认→真发+原子防重复）"
```

---

### Task 6：架构依赖测试（WritePort import 边界）+ jwt 豁免精确性测试

**Files:**
- Create: `src/test/contract/github-write-port-arch.test.ts`
- Create/Modify: jwt 豁免精确性测试（`src/test/integration/` 加 case，照 api.test.ts:897 的 401 断言）
- Test: 两个新测试

**Interfaces:**
- Consumes: 照 `src/test/contract/kernel-zero-deps.test.ts` 的 walkTs + IMPORT_RE 遍历模式。
- Produces:
  - **WritePort import 边界测试**：`walkTs('src')` → 每个 .ts 跑 `/from ['"]([^'"]+)['"]/g` → 若 import 含 `github-write-port` 且文件不在 allowlist（`github-comment-tool.ts`/`github-review-tool.ts`/组合根 app.ts/其单测）→ push violation → `assert.deepEqual(violations, [])`。**这把「WritePort 只审批 executor 组合根持有」从纪律升级为结构守护**。
  - **jwt 豁免精确性测试**：`app.inject` 打 `/api/v1/integrations/github/<非 webhook 路径>`（如 `/api/v1/integrations/github/foobar`）无 token → 断言 401（证 `isPublicPath` 的 webhook 豁免是精确匹配非前缀，防未来误改宽前缀暴露 highRisk 发布端点——Plan 3 遗留 Low）。

- [ ] **Step 1: 写两个测试（先失败/先验证当前状态）**

架构测试：先跑确认当前 WritePort（Task 3 建的）import 只在预期位置（allowlist 应含 Task 4 的两工具）。jwt 测试：`app.inject` 打前缀下不存在路径断言 401。

- [ ] **Step 2: 跑测试**

Run: `node --test --import tsx src/test/contract/github-write-port-arch.test.ts` + jwt 测试。

- [ ] **Step 3: 变异自证架构测试非重言**

临时在一个不该 import WritePort 的文件（如 draft-github-reply.ts 顶层）加 `import '...github-write-port'` → 架构测试应变红 → 还原。

- [ ] **Step 4: 通过**

Run: `npx tsc -b tsconfig.src.json && node --test ...` 两测试绿。

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "test(github): WritePort import 边界架构测试 + jwt 豁免精确性测试（防发布端点越权/WritePort 泄漏）"
```

---

## Self-Review（写完计划后自查）

- **Spec 覆盖**：Plan 4 覆盖 spec §5.3 的**发布侧 + 不可降级人工审批门**（highRisk 工具 → pipeline confirmation gate）+ WritePort 读写隔离 + 架构依赖测试 + 审批门变异 + Plan 3 遗留 jwt 豁免测试。至此 spec §5.3 全部落地，整个 GitHub 集成闭环完成 ✓。
- **关键决策标注**：发布走 pipeline highRisk（confirmation gate=不可降级人工门）而非 workforce——理由（draft 非 workforce task、pipeline confirmation 已等价不可降级、最少假接线）已在 Architecture + Global Constraints 说明 ✓。
- **占位符**：无 TBD。Task 5 的 claim 时机（先探测确认、真执行前才原子 claim 防 pending 误占位）已明确 ✓。
- **类型一致**：WritePort(Task3)→写工具(Task4)→publish 端点(Task5)；claimForPublish(Task2)→端点(Task5)；架构测试(Task6)锁 WritePort 边界 ✓。
- **安全不变量**：不可降级人工确认(Task5 E2E 变异)、原子防重复(Task2 CAS)、读写隔离(Task6 架构测试)、发布只从 approved(Task2)、jwt 豁免精确(Task6) 全部落到具体 task ✓。
- **Plan 1/2/3 教训带入**：Task 1 明确全局迁移号 + legacy fixture + **server-raw 断言列**（Plan2 翻车点）+ SQLite CHECK 重建 ✓。合并前跑 `test:golden` 全门（memory `merge-gate-must-run-test-golden`）✓。

## 完成后：整个 GitHub 集成闭环 DONE
接（Plan1）→ 学（Plan2）→ 起草（Plan3）→ 发布（Plan4）。数字人能接 GitHub、从中学习、对 issue/PR 起草回应、经不可降级人工审批后真正发布反馈。

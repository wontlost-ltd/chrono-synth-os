# GitHub 集成 Plan 2（学习段 / learn）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development 逐任务实现。步骤用 `- [ ]` checkbox 跟踪。

**Goal:** 让数字人从 GitHub 四类内容（代码/README、issues、PR/review、commit）学习——GitHubReadPort 拉取 → GitHubLearningMapper 映射成文本表征 → 经 PerceptionDistiller 沉淀为确定性记忆（事实进记忆、身份/价值提议经 core-update-gate 封顶 pending）→ 零-LLM 对话可引用。增量同步（github_learn_state 游标）+ 原子摄入幂等（github_ingest_digests 账本）+ 手动 learn-github 端点。

**Architecture:** 复用 Plan 1 的 `GitHubReadPort`（只读拉取）+ 既有 `PerceptionDistiller`（摄入主干，audio 壳范式，与 learn-topic 同路径）。新增：映射器（唯一新领域逻辑）、游标表、幂等账本、端点。**不新建 knowledge_sources github 类型**（走 perceive 才过 core-update-gate 封顶）。

**Tech Stack:** Node.js + TypeScript；复用 `GitHubReadPort`(Plan 1)、`PerceptionDistiller`/`DistillationService`/`core-update-gate`、`memory-service.addMemory`（逐字参考记忆）、`selectPerceptionProvider`（BYOK 老师）、companion 路由骨架、schema-dsl 迁移。

## Global Constraints（每个任务隐含遵守）

- **零-LLM 内核铁律**（spec 约束 1）：运行时对话零 LLM。LLM 仅作 perception 老师（BYOK，`selectPerceptionProvider`），产出为候选：事实进记忆、身份/价值提议须过 core-update-gate。
- **内核封顶非记忆信任档**（spec 约束 2，第 2/3 轮修订核心）：GitHub 学习经 perceive 时——事实型观察**如实写入记忆**（`memoryGraph.addMemory`，与 audio/video 感知事实同级，记忆无 provenance/信任字段）；**只有身份/价值提议**（value_shift/narrative_patch）过 `distillation.ingest`→`core-update-gate` 感知封顶（`MAX_PERCEPTION_DELTA=0.05`、`patternAgrees=false`）→ 永远 pending。**不得声称"记忆走 external 信任档"**——信任层管内核身份/价值，不管普通记忆。
- **摄入契约沿用既有 audio 壳范式**（spec ⑦a，已核实 `me.ts:557-564`）：GitHub representation 填 `media:{ modality:'audio', mediaSha256:sha256(representation), durationMs:0, representation }`。零内核契约改动。
- **摄入幂等原子**（spec ⑦b）：`PerceptionDistiller` 无内容 SHA 去重（`addMemory` 直写）→ 用 `github_ingest_digests` 表**原子 claim（INSERT ON CONFLICT DO NOTHING）+ 同事务落地记忆**，非 check-then-act。
- **增量游标成功才推进**（spec ⑦）：游标只在一页/一批全部成功摄入后 CAS 更新；失败不推进，下次重来（幂等靠 digest 账本兜）。commit 游标用时间戳锚 + SHA 边界（GitHub commits `since` 是时间戳非 SHA）。
- **新表双登记**（spec 约束 8）：`github_learn_state`、`github_ingest_digests` 登记进 `tenant-database.ts` `TENANT_TABLES` + `privacy-service.ts` `TENANT_TABLES`（`TENANT_TABLE_SET` 派生，只改数组）。迁移同步 schema-dsl 全部同步点（**版本号跨 server-raw+server-simple 全局连续**——Plan 1 Task 1 教训：不是 server-raw 家族内号，是全局下一号，读最新一个确认）。
- **per-persona scope**：学习与游标按 `(tenant_id, persona_id)` 隔离。companion 侧 `personaId='default'`（`COMPANION_PERSONA_ID`）。

## File Structure

- `packages/schema-dsl/src/migrations/server-raw/vNNN.ts`（新迁移，建两表）+ 全部同步点（含 legacy fixture 两数组——Plan 1 Task 1 漏过，务必带上）。
- `packages/kernel/src/domain/agent/github-learn-types.ts`（新，两表 Row + Query/Command，kernel 零 SQL）。
- `src/storage/github-learn-store.ts`（新，游标读写 + digest 原子 claim）。
- `src/storage/executors/github-learn-executors.ts`（新，真 SQL）+ 注册进 `executors/index.ts`。
- `src/integrations/github/github-learning-mapper.ts`（新，四类内容→representation，唯一新领域逻辑）。
- `src/integrations/github/github-learning-service.ts`（新，编排：ReadPort 拉取→增量过滤→映射→digest 原子摄入 perceive→游标推进）。
- `src/server/routes/companion/learn-github.ts`（新，`POST /api/v1/companion/me/learn-github`）+ 在 companion 路由注册。
- 测试：各 `src/test/unit/github-learn-*.test.ts` + `src/test/integration/github-learn-e2e.test.ts`（内核封顶变异测试在此）。

---

### Task 1：迁移建 `github_learn_state` + `github_ingest_digests` 两表

**Files:**
- Create: `packages/schema-dsl/src/migrations/server-raw/vNNN.ts`（NNN=全局最新号+1，`ls -t` 后确认；Plan 1 上个是 v119/pg v121，故本次约 v120/pg v122，但**必须 ls 核实全局最高**）
- Modify: schema-dsl 全部同步点（迁移文件/`server-raw/index.ts`/version-map/parity 期望/**legacy fixture 两数组**/VERSION_MAP range）
- Modify: `src/multi-tenant/tenant-database.ts`（`TENANT_TABLES` 加两表）
- Modify: `src/privacy/privacy-service.ts`（`TENANT_TABLES` 数组加两表）
- Test: schema-dsl parity/migration（`test:packages` + parity 集成测试）

**Interfaces:**
- Produces:
  - `github_learn_state(id TEXT PK, tenant_id TEXT NOT NULL, persona_id TEXT NOT NULL, repo TEXT NOT NULL, resource_type TEXT NOT NULL, cursor TEXT, cursor_advanced_at INTEGER, last_synced_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(tenant_id, persona_id, repo, resource_type))`；`resource_type` CHECK in (`code`,`issues`,`pulls`,`commits`)。
  - `github_ingest_digests(id TEXT PK, tenant_id TEXT NOT NULL, persona_id TEXT NOT NULL, repo TEXT NOT NULL, resource_type TEXT NOT NULL, content_sha TEXT NOT NULL, status TEXT NOT NULL, claimed_at INTEGER, ingested_at INTEGER, UNIQUE(tenant_id, persona_id, repo, resource_type, content_sha))`；`status` in (`claimed`,`ingested`)。

- [ ] **Step 1: 确认全局迁移号 + 读最新迁移模板**

Run: `ls -t packages/schema-dsl/src/migrations/server-raw/v*.ts packages/schema-dsl/src/migrations/server-simple/v*.ts | head -5`
找**全局**最高版本号（Plan 1 教训：跨两家族连续；查 version-map.test 的 pg 1..N / sqlite 1..M 断言确认 N/M）。读 `server-raw/v119.ts`（Plan 1 建的 github 表）做模板——它的 `defineRaw`/`aliases` 格式、双库 SQL 写法可直接照搬。

- [ ] **Step 2: 写迁移文件（两表，双库）**

照 v119 模板。SQLite（时间戳 INTEGER）+ Postgres（BIGINT）：
```sql
CREATE TABLE IF NOT EXISTS github_learn_state (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, persona_id TEXT NOT NULL,
  repo TEXT NOT NULL,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('code','issues','pulls','commits')),
  cursor TEXT, cursor_advanced_at INTEGER, last_synced_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_github_learn_state_key
  ON github_learn_state (tenant_id, persona_id, repo, resource_type);
CREATE TABLE IF NOT EXISTS github_ingest_digests (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, persona_id TEXT NOT NULL,
  repo TEXT NOT NULL, resource_type TEXT NOT NULL,
  content_sha TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('claimed','ingested')),
  claimed_at INTEGER, ingested_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_github_ingest_digests_key
  ON github_ingest_digests (tenant_id, persona_id, repo, resource_type, content_sha);
```

- [ ] **Step 3: 同步全部 schema-dsl 同步点（含 legacy fixture——Plan 1 漏过）**

注册 `server-raw/index.ts`；version-map；parity 期望；**`src/test/integration/fixtures/legacy-migrations.ts` 的 `LEGACY_SQLITE_MIGRATIONS` + `LEGACY_POSTGRES_MIGRATIONS` 两数组各加一条**（逐列反映迁移，含两个 UNIQUE 索引——Plan 1 Task 1 就是漏这处致 3 parity 集成测试红）；VERSION_MAP range。

- [ ] **Step 4: 双登记 GDPR/隔离**

`tenant-database.ts` `TENANT_TABLES` 加 `'github_learn_state'`、`'github_ingest_digests'`；`privacy-service.ts` `TENANT_TABLES` 数组加两表。

- [ ] **Step 5: 重建 dist + 全套验证（含 parity 集成测试——别只跑 test:packages）**

Run:
```
npx tsc -b packages/schema-dsl/tsconfig.json --force
npm run test:packages 2>&1 | tail -8
node --test --import tsx src/test/integration/schema-dsl-sqlite-parity.test.ts 2>&1 | tail -6
node --test --import tsx src/test/unit/tenant-database-isolation-coverage.test.ts src/test/unit/privacy-tenant-table-coverage.test.ts 2>&1 | grep -E "pass|fail"
```
Expected: 全绿（parity 集成测试也绿——这是 Plan 1 漏掉的门）。

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(github): 迁移建 github_learn_state + github_ingest_digests（双登记，含 legacy fixture 同步）"
```

---

### Task 2：kernel 契约 `github-learn-types.ts`

**Files:**
- Create: `packages/kernel/src/domain/agent/github-learn-types.ts`
- Modify: kernel agent barrel（`domain/agent/index.ts` 加 `export * from './github-learn-types.js'`，照 github-app-types 位置）
- Test: `src/test/unit/github-learn-types.test.ts`

**Interfaces:**
- Consumes: 无（照 `github-app-types.ts`——Plan 1 Task 2 建的——的 `{kind, params}` 描述符风格；**kernel 零 SQL**，SQL 在 executor）。
- Produces:
```typescript
export interface GithubLearnStateRow { id, tenant_id, persona_id, repo, resource_type, cursor: string|null, cursor_advanced_at: number|null, last_synced_at: number|null, created_at, updated_at }
export interface GithubIngestDigestRow { id, tenant_id, persona_id, repo, resource_type, content_sha, status, claimed_at: number|null, ingested_at: number|null }
export function githubLearnStateQuery(params: {tenantId, personaId, repo, resourceType}): Query<GithubLearnStateRow|null, ...>;
export function githubLearnStateUpsertCursor(params: {...cursor, cursorAdvancedAt, lastSyncedAt, now}): Command<...>;  // upsert on (tenant,persona,repo,resource_type)
export function githubDigestClaim(params: {...contentSha, now}): Command<...>;  // INSERT ON CONFLICT DO NOTHING（原子 claim）
export function githubDigestMarkIngested(params: {...contentSha, now}): Command<...>;  // status→ingested
export function githubDigestQuery(params: {...contentSha}): Query<GithubIngestDigestRow|null, ...>;  // 可选，测试/reclaim 用
```

- [ ] **Step 1: 读参照 github-app-types.ts + 写失败测试**

读 `packages/kernel/src/domain/agent/github-app-types.ts`（Plan 1 Task 2）照其工厂风格。写 `github-learn-types.test.ts`：断言 `githubLearnStateQuery` 的 params 携带四键；`githubDigestClaim` 是 claim 语义（kind 专用）。

- [ ] **Step 2: 跑测试确认 FAIL**

Run: `node --test --import tsx src/test/unit/github-learn-types.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 写 types.ts + barrel 导出**

按 Produces，紧贴 github-app-types 的真实工厂 API。

- [ ] **Step 4: 编译 + 测试通过**

Run: `npx tsc -b packages/kernel/tsconfig.json --force && node --test --import tsx src/test/unit/github-learn-types.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(github): kernel 契约 github-learn-types（learn_state 游标 + ingest_digests claim）"
```

---

### Task 3：`GithubLearnStore`（游标读写 + digest 原子 claim）

**Files:**
- Create: `src/storage/github-learn-store.ts`
- Create: `src/storage/executors/github-learn-executors.ts`（+ 注册进 `executors/index.ts`）
- Test: `src/test/unit/github-learn-store.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `githubLearnState*`/`githubDigest*` query/command；`SyncWriteUnitOfWork`。
- Produces:
```typescript
export class GithubLearnStore {
  constructor(tx: SyncWriteUnitOfWork, tenantId?: string);
  getCursor(personaId, repo, resourceType): { cursor: string|null; cursorAdvancedAt: number|null } | undefined;
  advanceCursor(personaId, repo, resourceType, cursor: string, now: number): void;  // 成功才调（CAS upsert）
  /** 原子 claim：INSERT ON CONFLICT DO NOTHING。返回 true=本次抢到（未摄入过），false=已被抢/已摄入。 */
  claimDigest(personaId, repo, resourceType, contentSha, now): boolean;
  markIngested(personaId, repo, resourceType, contentSha, now): void;
}
```

- [ ] **Step 1: 写失败测试（含并发 claim 语义）**

`github-learn-store.test.ts`：
- `claimDigest 首次返 true，二次同 sha 返 false`（原子去重——同一 content_sha 只能 claim 一次）
- `advanceCursor upsert：写后 getCursor 读回`
- `游标按 (persona,repo,resource_type) 隔离`：不同 resource_type 各自游标

- [ ] **Step 2: 跑测试确认 FAIL**

Run: `node --test --import tsx src/test/unit/github-learn-store.test.ts`
Expected: FAIL。

- [ ] **Step 3: 写 store + executor**

`claimDigest` executor SQL：`INSERT INTO github_ingest_digests (...) VALUES (...) ON CONFLICT (tenant_id,persona_id,repo,resource_type,content_sha) DO NOTHING`——**用受影响行数判 claim 成功**（1=抢到，0=已存在）。`advanceCursor`：`INSERT ... ON CONFLICT (tenant_id,persona_id,repo,resource_type) DO UPDATE SET cursor=?, cursor_advanced_at=?, last_synced_at=?, updated_at=?`。照 Plan 1 `github-app-executors.ts` 的注册模式。

- [ ] **Step 4: 测试通过**

Run: `npx tsc -b tsconfig.src.json && node --test --import tsx src/test/unit/github-learn-store.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(github): GithubLearnStore 游标读写 + digest 原子 claim（ON CONFLICT DO NOTHING）"
```

---

### Task 4：`GitHubLearningMapper`（四类内容→文本表征）

**Files:**
- Create: `src/integrations/github/github-learning-mapper.ts`
- Test: `src/test/unit/github-learning-mapper.test.ts`

**Interfaces:**
- Consumes: Plan 1 的 `GitHubIssue`/`GitHubPull`/`GitHubCommit`/`GitHubTree`（`github-read-port.ts` 导出的精简类型）。
- Produces:
```typescript
export interface MappedLearning { representation: string; contentSha: string; }  // contentSha=sha256(representation)，供 digest claim
export function mapCodeAndReadme(repo: string, tree: GitHubTree, readme: string, lang: string): MappedLearning;
export function mapIssue(repo: string, issue: GitHubIssue, comments: string[]): MappedLearning;
export function mapPull(repo: string, pull: GitHubPull, reviewComments: string[]): MappedLearning;
export function mapCommits(repo: string, commits: GitHubCommit[]): MappedLearning;
```
每个产出 `关于「<repo> ...」我学到：...` 文本（spec §5.2 模板，保留 symbol/files-changed/结论等关键结构）+ 内容 SHA。

- [ ] **Step 1: 写失败测试**

`github-learning-mapper.test.ts`：
- `mapIssue 产出含标题+正文摘要+讨论要点，representation 以「关于「repo issue #N」我学到：」开头`
- `mapPull 保留 files-changed 列表`（若 pull.filesChanged 非空）
- `contentSha 是 representation 的 sha256`（同输入同 sha，输入变 sha 变——供 digest 去重）

- [ ] **Step 2: 跑测试确认 FAIL**

Run: `node --test --import tsx src/test/unit/github-learning-mapper.test.ts`
Expected: FAIL。

- [ ] **Step 3: 写 mapper**

纯函数，四个 map。`contentSha = createHash('sha256').update(representation).digest('hex')`。保留结构：mapCode 列顶层目录/关键文件；mapPull 列 filesChanged；mapIssue 拼 comments 要点。

- [ ] **Step 4: 测试通过**

Run: `npx tsc -b tsconfig.src.json && node --test --import tsx src/test/unit/github-learning-mapper.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(github): GitHubLearningMapper 四类内容→文本表征（保留 symbol/files-changed/结论结构）"
```

---

### Task 5：`GitHubLearningService`（编排：拉取→增量→原子摄入→游标推进）

**Files:**
- Create: `src/integrations/github/github-learning-service.ts`
- Test: `src/test/unit/github-learning-service.test.ts`

**Interfaces:**
- Consumes: `GitHubReadPort`(Plan 1)、`GithubLearnStore`(Task 3)、`GitHubLearningMapper`(Task 4)、`PerceptionDistiller`（注入，已构造好——`(provider, memoryGraph, distillation)`）。
- Produces:
```typescript
export interface LearnGithubResult { ingested: number; skipped: number; cursorAdvanced: boolean; }
export class GitHubLearningService {
  constructor(deps: { readPort: GitHubReadPort; store: GithubLearnStore; distiller: PerceptionDistiller; tenantId: string; personaId: string; });
  async learn(repo: string, resourceTypes: ('code'|'issues'|'pulls'|'commits')[]): Promise<LearnGithubResult>;
}
```
`learn` 每 resourceType：读游标 → ReadPort 拉（带 since=游标）→ 逐条 map → **claimDigest（原子去重）→ 抢到才 perceive + markIngested（同事务由 store 的 tx 保证）** → 全批成功后 advanceCursor。claim 失败（已摄入）计 skipped。

- [ ] **Step 1: 写失败测试（注入 mock）**

`github-learning-service.test.ts`（mock readPort 返固定 issues、mock distiller、真 store on memory db）：
- `learn issues：拉取→映射→perceive 被调、digest 记 ingested、游标推进`
- `重复 learn 同内容：第二次 claimDigest 全 false → skipped，perceive 不再被调`（增量去重）
- `perceive 抛错：游标不推进`（失败恢复——advanceCursor 不被调）

- [ ] **Step 2: 跑测试确认 FAIL**

Run: `node --test --import tsx src/test/unit/github-learning-service.test.ts`
Expected: FAIL。

- [ ] **Step 3: 写 service**

编排逻辑。claim→perceive→markIngested 的顺序：先 `store.claimDigest`（true 才继续）→ `distiller.perceive`（audio 壳：`media:{modality:'audio', mediaSha256:mapped.contentSha, durationMs:0, representation:mapped.representation}`）→ `store.markIngested`。批末 `advanceCursor`。perceive 抛错则该 resourceType 不 advanceCursor（catch 记录，不推进）。

- [ ] **Step 4: 测试通过**

Run: `npx tsc -b tsconfig.src.json && node --test --import tsx src/test/unit/github-learning-service.test.ts`
Expected: PASS（含重复去重 + 失败不推进）。

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(github): GitHubLearningService 编排（增量拉取→原子摄入→游标成功才推进）"
```

---

### Task 6：`learn-github` 端点 + 内核封顶 E2E 变异测试

**Files:**
- Create: `src/server/routes/companion/learn-github.ts`
- Modify: companion 路由注册（在 `me.ts` 的 `registerCompanionRoutes` 或同层注册 learn-github；照 learn-topic 的注册方式）
- Test: `src/test/integration/github-learn-e2e.test.ts`

**Interfaces:**
- Consumes: `GitHubLearningService`(Task 5)、`selectPerceptionProvider`（BYOK 老师）、companion 路由骨架（`COMPANION_PERSONA_ID`、`request.tenantId`）。
- Produces: `POST /api/v1/companion/me/learn-github`，body `{ repo: string, resourceTypes?: ('code'|'issues'|'pulls'|'commits')[] }` → `LearnGithubResult`。

- [ ] **Step 1: 写 E2E + 内核封顶变异测试**

`github-learn-e2e.test.ts`：
- `学完 issues → 零-LLM 对话能被问到「你从 repo 学到什么」grounded 答出`（记忆层可引用——用 OfflineConversationResponder 或 memory 检索断言含学到的内容）
- **内核封顶（关键，变异测试）**：喂一条会诱导改价值观的 GitHub 内容（representation 含强价值主张）→ 断言**内核身份/价值变更落 pending 不自动生效**（查 core-self 的 pending candidates，断言未自动 apply）。变异证：把 perceive 的封顶（MAX_PERCEPTION_DELTA/patternAgrees）绕过后此测试须红——但封顶在既有 PerceptionDistiller 内，本测试断言的是**行为**（GitHub 学习不改内核），不改既有封顶代码。
- `重复学同 repo 同内容 → 第二次 skipped 不重灌记忆`（digest 去重端到端）

- [ ] **Step 2: 跑测试确认 FAIL**

Run: `node --test --import tsx src/test/integration/github-learn-e2e.test.ts`
Expected: FAIL（端点不存在）。

- [ ] **Step 3: 写端点 + 注册**

`learn-github.ts`：照 learn-topic（`me.ts:456`）——取 `selectPerceptionProvider` 建 provider → `new PerceptionDistiller(provider, tenantOS.core.memories, tenantOS.distillation)` → 构造 `GitHubLearningService`（readPort 需 Plan 1 的 auth+store 装配；本 plan 端点内组装 ReadPort：从 credential store getApp → AuthManager → ReadPortImpl）→ `service.learn(repo, resourceTypes)`。无凭据（getApp undefined）→ 明确 4xx「GitHub 未连接」。

- [ ] **Step 4: 测试通过**

Run: `npx tsc -b tsconfig.src.json && node --test --import tsx src/test/integration/github-learn-e2e.test.ts`
Expected: PASS（含内核封顶 + 去重）。

- [ ] **Step 5: 路由快照（若有 route-schema 快照测试需更新）**

Run: `node --test --import tsx src/test/**/route-schema*.test.ts 2>&1 | tail -5`（若因新端点红，按项目惯例 `UPDATE_SNAPSHOTS=1` 重生，见 memory `digital-org-visualization`）。

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(github): learn-github 端点 + 内核封顶 E2E（GitHub 学习不擅改内核价值观）"
```

---

## Self-Review（写完计划后自查）

- **Spec 覆盖**：Plan 2 覆盖 spec §5.2 学习段全部（四类映射/perceive 主干/记忆 vs 内核封顶语义/audio 壳摄入/github_learn_state 游标/github_ingest_digests 原子幂等/learn-github 端点/零-LLM 可引用）✓。
- **占位符**：无 TBD。Task 2 工厂签名标「以 github-app-types 真实工厂为准」是指向真实源（Plan 1 已建），非占位 ✓。
- **类型一致**：`MappedLearning.contentSha` (Task 4) → `claimDigest` (Task 3) → service (Task 5) 一致；`GitHubReadPort`/`GitHubIssue` 等消费 Plan 1 已合入的真类型 ✓。
- **安全不变量**：内核封顶（Task 6 E2E 变异）、原子摄入（Task 3 claim + Task 5 顺序）、增量成功才推进（Task 5）、双登记（Task 1）全部落到具体 task ✓。
- **Plan 1 教训带入**：Task 1 明确点出 legacy fixture 两数组 + 全局迁移号（Plan 1 Task 1 踩过的两个坑）✓。

## 后续 plan

- **Plan 3（反馈起草）**：github-webhook 接收器（签名+github_webhook_events 幂等+installation 反查 fail-closed）+ 两 playbook + GitHubResponseComposer。
- **Plan 4（反馈发布）**：GitHubWritePort + github 写工具（highRisk，唯一持 WritePort）+ 审批 executor 组合根注入 + 架构依赖测试 + 审批门变异测试。

# GitHub 集成 Plan 1（接入段 / connect）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现。步骤用 `- [ ]` checkbox 跟踪。

**Goal:** 建 GitHub App 认证 + 读侧出站通道（`GitHubReadPort`），让数字人能用 App installation token 只读拉取一个 repo 的 issues/PRs/commits/代码，凭据加密 fail-closed 落库。

**Architecture:** GitHub App 三级 token（App JWT → installation token 自动刷新）。凭据存新建租户级加密表（参照 `LlmCredentialStore` 的 fail-closed 模式）。读写结构隔离：本 plan 只做 `GitHubReadPort`（只读），`GitHubWritePort` 留 Plan 4。所有出站过 `ssrf-guard` + host allowlist 锁 `api.github.com`。

**Tech Stack:** Node.js + TypeScript；Node `crypto`（RS256 App JWT，不引 octokit）；复用 `FieldEncryption`(AES-256-GCM)、`ssrf-guard`、schema-dsl 迁移、`SyncWriteUnitOfWork`。

## Global Constraints（每个任务隐含遵守）

- **零-LLM 内核铁律**：本 plan 无 LLM 调用（纯网络+存储）。
- **凭据 fail-closed**（spec 约束 6）：`FieldEncryption.encrypt()` 在 `enabled=false` 时返回明文（`encryption.ts:53`）→ store 构造器须在 `!encryption.isEnabled` 时 `throw`（照抄 `LlmCredentialStore` 的边界，`llm-credential-store.ts:29-31`），绝不明文落库。
- **出站唯一出口 + 读写隔离**（spec 约束 5、⑧）：本 plan 只产 `GitHubReadPort`；不得建任何写方法（comment/review 属 Plan 4 的 `GitHubWritePort`）。
- **SSRF**（spec 约束 7）：每次出站过 `validateOutboundUrl(rawUrl, opts)`，`opts.hostAllowlist=['api.github.com']`、`opts.allowedSchemes=['https:']`；首版不支持私网 GHE。
- **新表双登记**（spec 约束 8）：`github_app_credentials`、`github_installations` 必须登记进 `src/multi-tenant/tenant-database.ts` 的 `TENANT_TABLES` **和** `src/privacy/privacy-service.ts` 的 `TENANT_TABLES`+`TENANT_TABLE_SET`；迁移同步 schema-dsl 全部同步点（迁移文件 + `index.ts` + version-map + parity 期望 + legacy fixture 两数组 + VERSION_MAP range，见 memory `schema-dsl-migration-sync-points`）。
- **installation→tenant 全局唯一**（spec 约束 ⑤）：`github_installations` 反查键 `(github_host, installation_id)` 全局唯一，多/零行 fail-closed。
- **per-persona**：本 plan 的凭据/installation 是**租户级**（不带 persona_id）；学习游标（Plan 2）才 per-persona。

## File Structure

- `packages/schema-dsl/src/migrations/server-raw/vNNN.ts`（新迁移，建两表）+ 全部同步点。
- `packages/kernel/src/domain/agent/github-app-types.ts`（新，Query/Command 契约 + Row 类型）。
- `src/storage/github-app-credential-store.ts`（新，加密 store，fail-closed）。
- `src/storage/executors/github-app-executors.ts`（新，executor 注册）。
- `src/integrations/github/github-auth-manager.ts`（新，App JWT + installation token 缓存/刷新）。
- `src/integrations/github/github-read-port.ts`（新，`GitHubReadPort` 接口 + 实现）。
- `src/integrations/github/github-http.ts`（新，SSRF-guarded fetch 薄封装）。
- 测试：各 `src/test/unit/github-*.test.ts` + `src/test/integration/github-read-port.test.ts`。

---

### Task 1：迁移建 `github_app_credentials` + `github_installations` 两表

**Files:**
- Create: `packages/schema-dsl/src/migrations/server-raw/vNNN.ts`（NNN = 当前最新 v107 之后的下一个号，实现时先 `ls -t` 确认）
- Modify: schema-dsl 全部同步点（见 Global Constraints）
- Modify: `src/multi-tenant/tenant-database.ts`（`TENANT_TABLES` 加两表）
- Modify: `src/privacy/privacy-service.ts`（`TENANT_TABLES` 数组 + `TENANT_TABLE_SET` 加两表）
- Test: schema-dsl parity/migration 测试（既有 `npm run test:packages` 覆盖）

**Interfaces:**
- Produces: 两张表的 schema——
  - `github_app_credentials(tenant_id TEXT PK, app_id TEXT NOT NULL, private_key_encrypted TEXT NOT NULL, webhook_secret_encrypted TEXT NOT NULL, ghe_base_url TEXT, created_by TEXT, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL)`
  - `github_installations(id TEXT PK, tenant_id TEXT NOT NULL, installation_id TEXT NOT NULL, github_host TEXT NOT NULL, account TEXT, repos TEXT, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, UNIQUE(github_host, installation_id))`

- [ ] **Step 1: 确认迁移号 + 读最新迁移做模板**

Run: `ls -t packages/schema-dsl/src/migrations/server-raw/v*.ts | head -1`
读该文件（如 v107.ts）+ `raw.js` 的 `defineRaw`/`rawSql` 用法。确认下一个 SQLite version 号与 postgres alias 号（照 v107 的 `aliases` 递增）。

- [ ] **Step 2: 写迁移文件**

照 v107 模板，`defineRaw({ id, version, aliases, description, reason, postgres: rawSql([...]), sqlite: rawSql([...]) })`。两表都建。SQL（两库都要，注意 SQLite 无 `BIGINT` 用 `INTEGER`）：

```sql
CREATE TABLE IF NOT EXISTS github_app_credentials (
  tenant_id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
  private_key_encrypted TEXT NOT NULL,
  webhook_secret_encrypted TEXT NOT NULL,
  ghe_base_url TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS github_installations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  github_host TEXT NOT NULL,
  account TEXT,
  repos TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_github_installations_host_iid
  ON github_installations (github_host, installation_id);
```
（Postgres 版把 `INTEGER` 时间戳保留为 `BIGINT`，其余同。）

- [ ] **Step 3: 同步全部 schema-dsl 同步点**

按 memory `schema-dsl-migration-sync-points`：注册进 `server-raw/index.ts`；更新 version-map；parity 期望；legacy fixture 两数组；VERSION_MAP range。**这两表是 tenant 表且含裸 SQL 无 tenant_id 谓词的建表——确认是否触发 SAFE-EXEMPT ratchet**（建表 DDL 通常不在 ratchet 静扫范围，但若报错须加 allowlist，见 memory `safe-exempt-sql-tenant-ratchet`）。

- [ ] **Step 4: 双登记 GDPR/隔离**

`tenant-database.ts` 的 `TENANT_TABLES` Set 加 `'github_app_credentials'`、`'github_installations'`。`privacy-service.ts` 的 `TENANT_TABLES` 有序数组 + `TENANT_TABLE_SET` 各加两表。

- [ ] **Step 5: 重建 schema-dsl dist + 跑迁移/隔离/GDPR 测试**

Run:
```
npx tsc -b packages/schema-dsl/tsconfig.json --force
npm run test:packages 2>&1 | tail -20
node --test --import tsx src/test/unit/tenant-database-isolation-coverage.test.ts
```
Expected: packages 全绿（含 parity 快照）；隔离 ratchet 认两新表已登记（PASS）。

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(github): 迁移建 github_app_credentials + github_installations 两表（双登记 GDPR/隔离）"
```

---

### Task 2：kernel 契约 `github-app-types.ts`（Row + Query/Command）

**Files:**
- Create: `packages/kernel/src/domain/agent/github-app-types.ts`
- Modify: `packages/kernel/src/index.ts`（或 agent domain 的 barrel export，照 `user-oauth-types.ts` 的导出方式）
- Test: `src/test/unit/github-app-types.test.ts`

**Interfaces:**
- Consumes: 无（纯类型 + query builder）。参照 `packages/kernel/src/domain/enterprise/llm-credential-queries.ts` 的 `Query`/`Command` kind 契约风格。
- Produces（后续 Task/Plan 依赖这些精确签名）：
```typescript
export interface GithubAppCredentialRow {
  readonly tenant_id: string;
  readonly app_id: string;
  readonly private_key_encrypted: string;
  readonly webhook_secret_encrypted: string;
  readonly ghe_base_url: string | null;
  readonly created_by: string | null;
  readonly created_at: number;
  readonly updated_at: number;
}
export interface GithubInstallationRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly installation_id: string;
  readonly github_host: string;
  readonly account: string | null;
  readonly repos: string | null;
  readonly created_at: number;
  readonly updated_at: number;
}
// 命令/查询（照 llm-credential-queries.ts 的 defineCommand/defineQuery 风格）：
export function githubAppCredUpsert(params: {...}): Command<...>;
export function githubAppCredQueryByTenant(tenantId: string): Query<GithubAppCredentialRow | null, string>;
export function githubAppCredDelete(tenantId: string): Command<...>;
export function githubInstallUpsert(params: {...}): Command<...>;
export function githubInstallQueryByHostIid(params: { githubHost: string; installationId: string }): Query<GithubInstallationRow | null, ...>; // (github_host, installation_id) 反查
export function githubInstallListByTenant(tenantId: string): Query<GithubInstallationRow, string>;
```

- [ ] **Step 1: 读参照契约**

读 `packages/kernel/src/domain/enterprise/llm-credential-queries.ts` 全文，照抄其 `Query`/`Command` 构造方式（`defineQuery`/`defineCommand` 或等价工厂——以真实文件为准）。

- [ ] **Step 2: 写失败测试**

`github-app-types.test.ts`：断言 `githubInstallQueryByHostIid({githubHost:'github.com', installationId:'123'})` 生成的 SQL 含 `WHERE github_host = ? AND installation_id = ?`（或参数化等价）。

- [ ] **Step 3: 跑测试确认失败**

Run: `node --test --import tsx src/test/unit/github-app-types.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 4: 写 types.ts**

按 Produces 签名实现，紧贴 `llm-credential-queries.ts` 的真实工厂 API（不臆造 defineQuery 签名，以该文件为准）。

- [ ] **Step 5: 编译 + 测试通过**

Run:
```
npx tsc -b packages/kernel/tsconfig.json --force
node --test --import tsx src/test/unit/github-app-types.test.ts
```
Expected: 编译过 + PASS。

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(github): kernel 契约 github-app-types（credential/installation Row + Query/Command）"
```

---

### Task 3：`GithubAppCredentialStore`（加密 store，fail-closed）

**Files:**
- Create: `src/storage/github-app-credential-store.ts`
- Create: `src/storage/executors/github-app-executors.ts`
- Modify: `src/storage/executors/index.ts`（注册新 executor，照既有 `registerCoreSelfExecutors` 模式）
- Test: `src/test/unit/github-app-credential-store.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `githubAppCred*`/`githubInstall*` query/command；`FieldEncryption`（`src/storage/encryption.ts`）；`SyncWriteUnitOfWork`。
- Produces:
```typescript
export class GithubAppCredentialStore {
  constructor(tx: SyncWriteUnitOfWork, encryption: FieldEncryption, tenantId?: string); // !isEnabled → throw
  storeApp(appId: string, privateKeyPem: string, webhookSecret: string, gheBaseUrl: string | null, createdBy: string | null, now: number): void;
  getApp(): { appId: string; privateKeyPem: string; webhookSecret: string; gheBaseUrl: string | null } | undefined; // 解密
  upsertInstallation(installationId: string, githubHost: string, account: string | null, repos: string | null, now: number): void;
  resolveTenantByInstallation(githubHost: string, installationId: string): { tenantId: string } | undefined; // 反查（调用方须处理多/零行——见 Task 实现）
}
```

- [ ] **Step 1: 写失败测试（含 fail-closed + 加密往返 + 反查）**

`github-app-credential-store.test.ts`：
- `test('disabled FieldEncryption → 构造器 throw')`：用 `new FieldEncryption({ enabled: false, ... })` 构造 store 应 throw（照 `llm-credential-store.test.ts` 的对应用例）。
- `test('storeApp → getApp 往返，私钥密文落库明文不落库')`：store 后直接查 `private_key_encrypted` 列断言 ≠ 明文 PEM；`getApp().privateKeyPem` === 原文。
- `test('resolveTenantByInstallation 命中唯一行')`：upsert 一条 → 反查得 tenantId。

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test --import tsx src/test/unit/github-app-credential-store.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 写 store + executor**

照 `src/storage/llm-credential-store.ts` 结构：构造器 fail-closed（`if (!encryption.isEnabled) throw`）；`storeApp` 用 `encryption.encrypt()` 加密私钥 + webhook secret 落库；`getApp` 解密。executor 照 `knowledge-source-executors.ts` 或 core-self executors 模式注册进 `executors/index.ts`。

- [ ] **Step 4: 测试通过**

Run: `npx tsc -b tsconfig.src.json && node --test --import tsx src/test/unit/github-app-credential-store.test.ts`
Expected: 编译过 + PASS。

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(github): GithubAppCredentialStore 加密存储（fail-closed，参照 LlmCredentialStore）"
```

---

### Task 4：`github-http.ts`（SSRF-guarded fetch 薄封装）

**Files:**
- Create: `src/integrations/github/github-http.ts`
- Test: `src/test/unit/github-http.test.ts`

**Interfaces:**
- Consumes: `validateOutboundUrl`（`src/security/ssrf-guard.ts`，签名 `(rawUrl, opts: SsrfGuardOptions)`）；`SsrfGuardOptions.hostAllowlist`/`allowedSchemes`。
- Produces:
```typescript
export const GITHUB_API_HOST = 'api.github.com';
export async function githubFetch(url: string, init: RequestInit, opts?: { hostAllowlist?: string[] }): Promise<Response>;
// 内部：validateOutboundUrl(url, { hostAllowlist:[GITHUB_API_HOST], allowedSchemes:['https:'], ...DEFAULT }) → ok 才 fetch；否则 throw。10s 超时 + redirect:'manual'。
```

- [ ] **Step 1: 写失败测试**

`github-http.test.ts`：
- `test('非 api.github.com host → 拒绝（不发请求）')`：`githubFetch('https://evil.com/x', {})` 应 throw，且不实际发出网络请求（用 spy/断言 throw 即可）。
- `test('http scheme → 拒绝')`：`githubFetch('http://api.github.com/x', {})` throw。

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test --import tsx src/test/unit/github-http.test.ts`
Expected: FAIL。

- [ ] **Step 3: 写 github-http.ts**

`githubFetch`：先 `validateOutboundUrl(url, { ...DEFAULT_SSRF_OPTIONS, hostAllowlist:[GITHUB_API_HOST], allowedSchemes:['https:'] })`，`!ok` 则 `throw new Error(decision.reason)`；ok 则 `fetch(url, { ...init, redirect:'manual', signal: AbortSignal.timeout(10_000) })`。

- [ ] **Step 4: 测试通过**

Run: `npx tsc -b tsconfig.src.json && node --test --import tsx src/test/unit/github-http.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(github): github-http SSRF-guarded fetch（锁 api.github.com + https）"
```

---

### Task 5：`GitHubAuthManager`（App JWT + installation token 缓存/刷新）

**Files:**
- Create: `src/integrations/github/github-auth-manager.ts`
- Test: `src/test/unit/github-auth-manager.test.ts`

**Interfaces:**
- Consumes: `GithubAppCredentialStore.getApp()`（Task 3）；`githubFetch`（Task 4）；Node `crypto`（RS256 JWT）；注入 `now: () => number`（可测，禁真 `Date.now`——照 memory `adr-0060-tool-learning-complete` 的 T6 flaky 教训，时钟须可注入）。
- Produces:
```typescript
export class GitHubAuthManager {
  constructor(deps: { getApp: () => AppCreds | undefined; installationId: string; now: () => number; fetch?: typeof githubFetch });
  // 返回有效 installation token；内存缓存，到期前（now + skew >= expiresAt）自动重签。
  async getInstallationToken(): Promise<string>;
}
```

- [ ] **Step 1: 写失败测试（含刷新逻辑，注入时钟）**

`github-auth-manager.test.ts`：
- `test('首次调用签 App JWT 换 installation token')`：mock `fetch` 返回 `{token, expires_at}`；断言返回该 token。
- `test('token 未过期 → 复用缓存，不重新换')`：连调两次，mock fetch 只应被调一次。
- `test('token 到期 → 静默重签')`：注入 `now` 让第二次调用时已过期，断言 fetch 被调两次、返回新 token。

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test --import tsx src/test/unit/github-auth-manager.test.ts`
Expected: FAIL。

- [ ] **Step 3: 写 auth-manager**

App JWT：`crypto.createSign('RSA-SHA256')` 用私钥 PEM 签 `{iat, exp: iat+540, iss: appId}`（≤10min）。换 installation token：`POST https://api.github.com/app/installations/{id}/access_tokens`，`Authorization: Bearer <appJwt>`。缓存 `{token, expiresAt}`，`getInstallationToken` 判 `now() + 60_000 >= expiresAt` 则重签。**时钟注入**（`deps.now`），不用真 `Date.now`。

- [ ] **Step 4: 测试通过**

Run: `npx tsc -b tsconfig.src.json && node --test --import tsx src/test/unit/github-auth-manager.test.ts`
Expected: PASS（含刷新用例）。

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(github): GitHubAuthManager App JWT + installation token 缓存/自动刷新（时钟可注入）"
```

---

### Task 6：`GitHubReadPort`（只读端点）

**Files:**
- Create: `src/integrations/github/github-read-port.ts`
- Test: `src/test/unit/github-read-port.test.ts` + `src/test/integration/github-read-port.test.ts`

**Interfaces:**
- Consumes: `GitHubAuthManager.getInstallationToken()`（Task 5）；`githubFetch`（Task 4）。
- Produces（Plan 2 学习段消费这些）：
```typescript
export interface GitHubReadPort {
  listIssues(repo: string, since?: string): Promise<GitHubIssue[]>;
  listPulls(repo: string, since?: string): Promise<GitHubPull[]>;
  listCommits(repo: string, since?: string): Promise<GitHubCommit[]>;
  getRepoTree(repo: string): Promise<GitHubTree>;
  getFileContent(repo: string, path: string): Promise<string>;
}
export class GitHubReadPortImpl implements GitHubReadPort { constructor(auth: GitHubAuthManager); }
// GitHubIssue/Pull/Commit/Tree：只含学习需要的字段（number/title/body/updated_at/sha/files 等），不全量映射。
```
**约束**：本 port **只有读方法**，绝不含 comment/review 写方法（Plan 4）。

- [ ] **Step 1: 写失败测试**

`github-read-port.test.ts`（单元，mock fetch）：
- `test('listIssues 带 Authorization: token + since 参数')`：mock fetch，断言请求 URL 含 `/repos/<repo>/issues?since=...`、header 含 installation token。
- `test('listIssues 解析出 number/title/body/updated_at')`：mock 返回样本 JSON，断言映射字段。

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test --import tsx src/test/unit/github-read-port.test.ts`
Expected: FAIL。

- [ ] **Step 3: 写 read-port**

每个方法：`token = await auth.getInstallationToken()` → `githubFetch(url, { headers: { Authorization: \`token ${token}\`, Accept:'application/vnd.github+json' } })` → 解析映射到精简类型。`since` 传给 issues/pulls/commits 的 query。分页（Link header）首版拉首页 + 循环到无 next（或封顶页数，`log` 截断——照 memory「no silent caps」）。

- [ ] **Step 4: 单元测试通过**

Run: `npx tsc -b tsconfig.src.json && node --test --import tsx src/test/unit/github-read-port.test.ts`
Expected: PASS。

- [ ] **Step 5: 集成测试（真拉 public repo，可选 gated）**

`github-read-port.integration.test.ts`：`{ skip: !process.env.GITHUB_TEST_TOKEN }`（本地无 token 则 skip，同 memory 里 PG rollback 探针的 gated 模式）。有 token 时真拉一个小 public repo 的 issues，断言非空。

Run: `node --test --import tsx src/test/integration/github-read-port.test.ts`
Expected: PASS 或 skip（无 token）。

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(github): GitHubReadPort 只读端点（issues/pulls/commits/tree/file，仅读无写）"
```

---

## Self-Review（写完计划后自查）

- **Spec 覆盖**：Plan 1 覆盖 spec §5.1 接入段全部（认证链/凭据 fail-closed/SSRF/读写隔离的读侧/两表双登记/installation 全局唯一反查）。写侧（WritePort）明确留 Plan 4 ✓。
- **占位符**：无 TBD；Task 2 的 query/command 签名标注「以 llm-credential-queries.ts 真实工厂为准」是因该文件的 defineQuery 具体 API 须实现时读——这是**指向真实源**不是占位（实现者第一步就读它）✓。
- **类型一致**：`GitHubReadPort` 在 Task 6 定义，Plan 2 消费；`GithubAppCredentialStore.resolveTenantByInstallation` 在 Task 3 定义，Plan 3 webhook 反查消费——跨 plan 接口在此 plan 的 Produces 声明 ✓。
- **安全不变量**：fail-closed（Task 3）、SSRF（Task 4）、读写隔离（Task 6 只读）、installation 全局唯一（Task 1 UNIQUE + Task 3 反查）全部落到具体 task ✓。

## 后续 plan（本 plan 完成后写）

- **Plan 2（学）**：GitHubLearningMapper + 摄入（audio 壳）+ github_learn_state + github_ingest_digests 原子摄入 + learn-github 端点 + 内核封顶变异测试。
- **Plan 3（反馈起草）**：github-webhook 接收器（签名+github_webhook_events 幂等+installation 反查 fail-closed）+ 两 playbook + GitHubResponseComposer。
- **Plan 4（反馈发布）**：GitHubWritePort + github 写工具（highRisk，唯一持 WritePort）+ 审批 executor 组合根注入 + 架构依赖测试 + 审批门变异测试。

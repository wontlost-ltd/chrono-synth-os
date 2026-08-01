# GitHub 讨论内容摄入（listComments）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 GitHub issue 讨论串与 PR review 意见真正进入数字人记忆，且讨论演进时记忆随之取代而非堆积。

**Architecture:** 四层改动零新表——ReadPort 加两个只读方法（复用既有 `fetchAllPages` + SSRF 网关）；Service 层双闸省配额（增量游标 + 评论数为零跳过）；`github_ingest_digests` 加 `discussion_key`/`memory_id` 两列实现演进式取代（新记忆沉淀后删同 key 旧记忆）；Mapper 零改动（`summarizeComments` 已就绪）。

**Tech Stack:** TypeScript (ESM, NodeNext)、Node.js `node:test`、Fastify、SQLite/PostgreSQL 双驱动、schema-dsl 迁移框架、`@chrono/kernel` Command/Query 描述符 + executor 分层。

**Spec:** `docs/superpowers/specs/2026-08-02-github-discussion-ingestion-design.md`

## Global Constraints

- **零-LLM 铁律**：LLM 只在 `PerceptionDistiller.perceive()` 摄取阶段当感官老师；本次改动不得在任何运行时路径引入 LLM 调用。
- **内核封顶**：GitHub 内容经 core-update-gate，绝不能自动改写人格价值观。`github-learn-e2e.test.ts` 的变异测试必须保持有效。
- **只读契约**：`GitHubReadPort` 只允许 list/get 方法，绝无写方法。`src/test/contract/github-write-port-arch.test.ts` 反射断言必须继续通过。
- **注释语言**：所有代码注释与文档使用简体中文，描述意图/约束，不写「修改说明」式注释。
- **SQL 分层**：kernel（`packages/kernel/src/domain/agent/github-learn-types.ts`）只声明 `{kind, params}` 描述符与 Row 形状；真 SQL 只在 `src/storage/executors/github-learn-executors.ts`。
- **租户隔离**：所有读写必须 tenant scoped，`tenant_id` 参与幂等键。
- **迁移同步点 6 处**（加列必须逐一同步）：① 迁移文件 ② `migrations/server-raw/index.ts`（import + export + 数组三处）③ `version-map.ts` ④ parity 期望 ⑤ legacy fixture 两数组 ⑥ VERSION_MAP range。
- **合并前必须跑 `npm run test:golden` 全门**，不得只跑 `test:packages` 子集。
- 构建命令：`npm run build`。改 kernel 类型后需 `tsc -b packages/kernel --force`。
- 新迁移版本号：**v125**（当前最新为 v124；PG alias 为 v127，sqlite-sql alias 为 v125）。

---

## File Structure

| 文件 | 职责 | 动作 |
|---|---|---|
| `packages/schema-dsl/src/migrations/server-raw/v125.ts` | 迁移：digests 加 `discussion_key` + `memory_id` 两列 | 创建 |
| `packages/schema-dsl/src/migrations/server-raw/index.ts` | 注册 v125 | 修改 |
| `packages/schema-dsl/src/version-map.ts` | v125 版本映射 | 修改 |
| `packages/kernel/src/domain/agent/github-learn-types.ts` | 加 `githubDigestQueryByDiscussionKey` 描述符 + 参数/Row 类型扩展 | 修改 |
| `src/storage/executors/github-learn-executors.ts` | 新 Query 的真 SQL + claim/markIngested 写入新列 | 修改 |
| `src/storage/github-learn-store.ts` | 门面方法 `findByDiscussionKey` / `recordMemoryId` | 修改 |
| `src/integrations/github/github-read-port.ts` | 加 `listIssueComments` / `listPullReviewComments` | 修改 |
| `src/integrations/github/github-learning-service.ts` | 抓评论接线 + 演进式取代编排 | 修改 |
| `src/test/unit/github-read-port.test.ts` | 新方法单测 | 修改 |
| `src/test/integration/github-learn-e2e.test.ts` | 取代语义 + 零评论跳过集成测试 | 修改 |

**Task 依赖顺序**：Task 1（迁移）→ Task 2（kernel+executor+store）→ Task 3（ReadPort）→ Task 4（Service 接线+取代）→ Task 5（全门验证）。Task 3 与 Task 1/2 无依赖，可并行。

---

### Task 1: 迁移 — digests 加 discussion_key 与 memory_id 两列

**Files:**
- Create: `packages/schema-dsl/src/migrations/server-raw/v125.ts`
- Modify: `packages/schema-dsl/src/migrations/server-raw/index.ts`
- Modify: `packages/schema-dsl/src/version-map.ts:136` 之后

**Interfaces:**
- Produces: 迁移常量 `v125_github_digest_discussion_key`；`github_ingest_digests` 表新增两个可空列 `discussion_key TEXT`、`memory_id TEXT`

**背景**：`github_ingest_digests` 现有列见 `v120.ts:50-64`。本次加两列——`discussion_key` 标识「这是哪个 issue/PR 的讨论」（如 `issues:owner/repo#42`），`memory_id` 记录该 key 当前对应的记忆 ID，供取代时删旧记忆。两列均可空，兼容既有行（code/commits 类型无 discussion_key）。

- [ ] **Step 1: 创建迁移文件**

创建 `packages/schema-dsl/src/migrations/server-raw/v125.ts`：

```ts
/**
 * v125 — GitHub 摄入账本加讨论键与记忆指针（讨论内容摄入设计 §3.3）。
 *
 * 为什么要这两列：contentSha = sha256(representation)，表征含评论后每新增一条评论就产生新 sha，
 * 去重账本失效——同一 issue 会被反复当新内容沉淀，记忆库堆积近似重复碎片。加 discussion_key
 * （稳定标识「哪个 issue/PR」）+ memory_id（该 key 当前对应记忆）后，新表征沉淀完即可删同 key
 * 旧记忆，使每个 issue 在记忆库中恒为一条 = 最新共识。
 *
 * 两列均可空：既有行与 code/commits 资源类型无讨论概念，保持 NULL。
 */

import { rawSql } from '../../dsl/index.js';
import type { RawMigration } from '../../types.js';

export const v125_github_digest_discussion_key: RawMigration = {
  id: 'github-digest-discussion-key',
  version: 'v125',
  aliases: { postgres: 'v127', 'sqlite-sql': 'v125' },
  description: 'GitHub ingest digests: add discussion_key + memory_id for evolutionary supersede',
  reason: '讨论内容摄入：加 discussion_key（issues:owner/repo#42 稳定标识）+ memory_id（该讨论当前记忆指针），使讨论演进时新记忆取代旧记忆而非堆积；两列可空兼容既有行',
  postgres: rawSql([
    `ALTER TABLE github_ingest_digests ADD COLUMN IF NOT EXISTS discussion_key TEXT`,
    `ALTER TABLE github_ingest_digests ADD COLUMN IF NOT EXISTS memory_id TEXT`,
    `CREATE INDEX IF NOT EXISTS idx_github_ingest_digests_discussion
      ON github_ingest_digests (tenant_id, persona_id, discussion_key)`,
  ]),
  sqlite: rawSql([
    `ALTER TABLE github_ingest_digests ADD COLUMN discussion_key TEXT`,
    `ALTER TABLE github_ingest_digests ADD COLUMN memory_id TEXT`,
    `CREATE INDEX IF NOT EXISTS idx_github_ingest_digests_discussion
      ON github_ingest_digests (tenant_id, persona_id, discussion_key)`,
  ]),
};
```

**注意**：SQLite 的 `ALTER TABLE ADD COLUMN` 无 `IF NOT EXISTS` 语法，直接加列。因是全新版本号，不会重复执行。**不重建表**，故不触发「SQLite 重建表静默丢二级索引」那个已知坑。

- [ ] **Step 2: 注册进 index.ts**

修改 `packages/schema-dsl/src/migrations/server-raw/index.ts`，三处各加一行（照 v124 现有写法）：

import 区（约 :19 之后）：
```ts
import { v125_github_digest_discussion_key } from './v125.js';
```

export 区（约 :38 之后）：
```ts
export { v125_github_digest_discussion_key } from './v125.js';
```

数组区（约 :57 之后，`v124_tenant_bootstrap_backfill,` 之后）：
```ts
  v125_github_digest_discussion_key,
```

- [ ] **Step 3: 注册进 version-map.ts**

在 `packages/schema-dsl/src/version-map.ts:136`（`v124_tenant_bootstrap_backfill` 那行）之后追加：

```ts
  { canonical: 'v125_github_digest_discussion_key', aliases: { postgres: 'v127', 'sqlite-sql': 'v125' }, classification: 'schema-raw', notes: 'GitHub 讨论内容摄入：github_ingest_digests 加 discussion_key（issues:owner/repo#42 稳定讨论标识，可空）+ memory_id（该讨论当前记忆指针，可空，供演进式取代删旧记忆）+ (tenant,persona,discussion_key) 二级索引；PG 用 ADD COLUMN IF NOT EXISTS，SQLite 直接 ADD COLUMN 不重建表' },
```

- [ ] **Step 4: 构建 schema-dsl 并跑 parity**

```bash
npm run build --workspace @wontlost-ltd/schema-dsl
npm run test:schema-dsl-parity:raw
```

Expected: 若 parity 期望/fixture 未同步会报错，逐条按报错提示补齐（这正是「同步点 6 处」的 ④⑤⑥）。反复运行直到通过。

- [ ] **Step 5: 跑迁移相关测试**

```bash
npm run build && npm run test:packages 2>&1 | tail -20
```

Expected: PASS。若报版本计数不符，按报错定位剩余同步点。

- [ ] **Step 6: 提交**

```bash
git add packages/schema-dsl/
git commit -m "feat(github): 摄入账本加 discussion_key/memory_id 两列（v125）

为演进式取代铺路：contentSha 含评论后随讨论变化致去重账本失效，
加稳定讨论标识 + 记忆指针，使新记忆可取代同讨论旧记忆。两列可空
兼容既有行；SQLite 直接 ADD COLUMN 不重建表，规避重建丢索引坑。"
```

---

### Task 2: kernel 描述符 + executor SQL + store 门面

**Files:**
- Modify: `packages/kernel/src/domain/agent/github-learn-types.ts`
- Modify: `src/storage/executors/github-learn-executors.ts`
- Modify: `src/storage/github-learn-store.ts`
- Test: `src/test/unit/github-learn-store.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `discussion_key` / `memory_id` 两列
- Produces:
  - `GithubDigestClaimParams` 扩展可选字段 `discussionKey?: string`
  - `githubDigestByDiscussionKeyQuery(params: {tenantId, personaId, discussionKey}): Query<GithubIngestDigestRow | null, ...>`
  - `githubDigestSetMemoryId(params: {tenantId, personaId, repo, resourceType, contentSha, memoryId, now}): Command<...>`
  - `GithubLearnStore.findMemoryIdByDiscussionKey(personaId: string, discussionKey: string): string | undefined`
  - `GithubLearnStore.recordMemoryId(personaId: string, repo: string, resourceType: string, contentSha: string, memoryId: string, now: number): void`
  - `GithubLearnStore.claimDigest` 签名扩展第 6 个可选参数 `discussionKey?: string`

- [ ] **Step 1: 写失败的 store 单测**

在 `src/test/unit/github-learn-store.test.ts` 末尾追加（沿用该文件既有的 store 构造与 tx fixture 写法）：

```ts
test('findMemoryIdByDiscussionKey：claim 时带 discussionKey 并记录 memoryId 后可反查', () => {
  const { store } = makeStore();   /* 复用本文件既有 fixture 工厂 */
  const key = 'issues:acme/widget#42';
  store.claimDigest('default', 'acme/widget', 'issues', 'sha-aaa', 1000, key);
  store.recordMemoryId('default', 'acme/widget', 'issues', 'sha-aaa', 'mem_first', 1001);

  assert.equal(store.findMemoryIdByDiscussionKey('default', key), 'mem_first');
});

test('findMemoryIdByDiscussionKey：未知 discussionKey 返回 undefined', () => {
  const { store } = makeStore();
  assert.equal(store.findMemoryIdByDiscussionKey('default', 'issues:acme/widget#999'), undefined);
});
```

**注意**：先打开 `src/test/unit/github-learn-store.test.ts` 查看既有 fixture 工厂的真实名字（可能不叫 `makeStore`），照抄该文件已有的构造方式，勿臆造。

- [ ] **Step 2: 跑测试确认失败**

```bash
npm run build && node --test --test-force-exit dist/test/unit/github-learn-store.test.js
```

Expected: FAIL —— `store.findMemoryIdByDiscussionKey is not a function`

- [ ] **Step 3: kernel 加描述符与类型**

修改 `packages/kernel/src/domain/agent/github-learn-types.ts`：

① 在 kind 常量区（与 `GITHUB_INGEST_DIGEST_QUERY` 同处）追加两个常量，命名沿用既有前缀风格：

```ts
/** 按讨论键反查摘要行（演进式取代：找同讨论的旧记忆指针）。 */
export const GITHUB_INGEST_DIGEST_QUERY_BY_DISCUSSION = 'github_ingest_digests.queryByDiscussion';
/** 回写该摘要行对应的记忆 ID（perceive 产出后记录）。 */
export const GITHUB_INGEST_DIGEST_CMD_SET_MEMORY_ID = 'github_ingest_digests.setMemoryId';
```

② `GithubDigestClaimParams` 加可选字段：

```ts
export interface GithubDigestClaimParams extends GithubIngestDigestKeyParams {
  now: number;
  /** 讨论稳定标识（如 issues:owner/repo#42）。code/commits 无讨论概念时省略。 */
  discussionKey?: string;
}
```

③ `GithubIngestDigestRow` 加两个可空字段（与表列对应）：

```ts
  discussion_key: string | null;
  memory_id: string | null;
```

④ 新增参数类型与两个工厂函数：

```ts
export interface GithubDigestByDiscussionKeyParams {
  tenantId: string;
  personaId: string;
  discussionKey: string;
}

export interface GithubDigestSetMemoryIdParams extends GithubIngestDigestKeyParams {
  memoryId: string;
  now: number;
}

/**
 * 按 (tenant, persona, discussion_key) 反查该讨论当前的摘要行。演进式取代用——
 * 拿到旧 memory_id 才能在新记忆沉淀后删掉旧记忆。返回 0/1 行（同讨论恒留一条最新）。
 */
export function githubDigestByDiscussionKeyQuery(params: GithubDigestByDiscussionKeyParams): Query<GithubIngestDigestRow | null, GithubDigestByDiscussionKeyParams> {
  return { kind: GITHUB_INGEST_DIGEST_QUERY_BY_DISCUSSION, params };
}

/** 回写摘要行的 memory_id（perceive 返回 memoryIds 后调用）。 */
export function githubDigestSetMemoryId(params: GithubDigestSetMemoryIdParams): Command<GithubDigestSetMemoryIdParams> {
  return { kind: GITHUB_INGEST_DIGEST_CMD_SET_MEMORY_ID, params };
}
```

- [ ] **Step 4: executor 加真 SQL**

修改 `src/storage/executors/github-learn-executors.ts`：

① claim 执行器（约 :92 的 `INSERT INTO github_ingest_digests`）加入新列。把插入语句改为包含 `discussion_key`，值取 `params.discussionKey ?? null`。保持 `ON CONFLICT ... DO NOTHING` 语义不变。

② 新增按讨论键查询执行器：

```ts
  register(GITHUB_INGEST_DIGEST_QUERY_BY_DISCUSSION, (tx, params) => {
    /* 同一讨论恒留一条（取代式），故取 1 行即可；带 memory_id 非空条件排除尚未回写的占位行。 */
    return tx.queryOne(
      `SELECT * FROM github_ingest_digests
        WHERE tenant_id = ? AND persona_id = ? AND discussion_key = ? AND memory_id IS NOT NULL
        ORDER BY ingested_at DESC LIMIT 1`,
      [params.tenantId, params.personaId, params.discussionKey],
    );
  });
```

③ 新增回写 memory_id 执行器：

```ts
  register(GITHUB_INGEST_DIGEST_CMD_SET_MEMORY_ID, (tx, params) => {
    return tx.execute(
      `UPDATE github_ingest_digests SET memory_id = ?
        WHERE tenant_id = ? AND persona_id = ? AND repo = ? AND resource_type = ? AND content_sha = ?`,
      [params.memoryId, params.tenantId, params.personaId, params.repo, params.resourceType, params.contentSha],
    );
  });
```

**注意**：以上 `register` / `tx.queryOne` / `tx.execute` 的确切写法必须照抄该文件既有执行器（见 :43、:78、:92、:107 附近）的真实 API 形状，勿臆造签名。

- [ ] **Step 5: store 加门面方法**

修改 `src/storage/github-learn-store.ts`：

① `claimDigest` 方法签名末尾加可选参数并透传：
```ts
  claimDigest(personaId: string, repo: string, resourceType: string, contentSha: string, now: number, discussionKey?: string): boolean {
```
在构造 `githubDigestClaim({...})` 的参数对象里加 `discussionKey`。

② 新增两个方法（放在 `markIngested` 之后）：

```ts
  /**
   * 反查某讨论当前对应的记忆 ID。演进式取代用：新表征沉淀后据此删掉旧记忆，
   * 使每个 issue/PR 在记忆库中恒为一条最新共识。无记录返回 undefined。
   */
  findMemoryIdByDiscussionKey(personaId: string, discussionKey: string): string | undefined {
    const row = this.tx.queryOne(githubDigestByDiscussionKeyQuery({
      tenantId: this.tenantId, personaId, discussionKey,
    }));
    return row?.memory_id ?? undefined;
  }

  /** 回写摘要行对应的记忆 ID（perceive 产出 memoryIds 后调用）。 */
  recordMemoryId(personaId: string, repo: string, resourceType: string, contentSha: string, memoryId: string, now: number): void {
    this.tx.execute(githubDigestSetMemoryId({
      tenantId: this.tenantId, personaId, repo, resourceType, contentSha, memoryId, now,
    }));
  }
```

③ 顶部 import 加入 `githubDigestByDiscussionKeyQuery, githubDigestSetMemoryId`。

- [ ] **Step 6: 重建 kernel 并跑测试**

```bash
tsc -b packages/kernel --force && npm run build && node --test --test-force-exit dist/test/unit/github-learn-store.test.js
```

Expected: PASS（两个新测试通过，既有测试无回归）

- [ ] **Step 7: 提交**

```bash
git add packages/kernel/src/domain/agent/github-learn-types.ts src/storage/executors/github-learn-executors.ts src/storage/github-learn-store.ts src/test/unit/github-learn-store.test.ts
git commit -m "feat(github): 摘要账本支持讨论键反查与记忆指针回写

kernel 加 githubDigestByDiscussionKeyQuery/githubDigestSetMemoryId 描述符，
executor 落真 SQL，store 出 findMemoryIdByDiscussionKey/recordMemoryId 门面。
为 Service 层演进式取代提供「查旧记忆 → 删 → 记新」的存储能力。"
```

---

### Task 3: ReadPort 加两个只读评论方法

**Files:**
- Modify: `src/integrations/github/github-read-port.ts`
- Test: `src/test/unit/github-read-port.test.ts`

**Interfaces:**
- Produces:
  - `GitHubReadPort.listIssueComments(repo: string, issueNumber: number): Promise<string[]>`
  - `GitHubReadPort.listPullReviewComments(repo: string, pullNumber: number): Promise<string[]>`
  - 两者均返回评论正文字符串数组（按 API 返回顺序），空评论返回 `[]`

**背景**：既有 `fetchAllPages(firstUrl)` 沿 Link header 跟随分页（:216 起，上限 `MAX_LIST_PAGES = 10`）；`PER_PAGE = 100`。GitHub 端点：issue 评论 `GET /repos/{repo}/issues/{number}/comments`，PR review 评论 `GET /repos/{repo}/pulls/{number}/comments`。

- [ ] **Step 1: 写失败的单测**

在 `src/test/unit/github-read-port.test.ts` 追加（照该文件既有 `fetchImpl` 注入写法）：

```ts
test('listIssueComments：拉取 issue 评论正文数组', async () => {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(url);
    return {
      json: async () => [{ body: '这个问题定位到是 token 过期' }, { body: '已修复，见 PR #43' }],
      headers: new Headers(),
    };
  }) as unknown as typeof githubFetch;

  const port = new GitHubReadPortImpl(fakeAuth(), { fetchImpl });
  const comments = await port.listIssueComments('acme/widget', 42);

  assert.deepEqual(comments, ['这个问题定位到是 token 过期', '已修复，见 PR #43']);
  assert.ok(calls[0].includes('/repos/acme/widget/issues/42/comments'));
  assert.ok(calls[0].includes('per_page=100'));
});

test('listPullReviewComments：拉取 PR review 评论正文数组', async () => {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(url);
    return { json: async () => [{ body: '这里建议提前返回' }], headers: new Headers() };
  }) as unknown as typeof githubFetch;

  const port = new GitHubReadPortImpl(fakeAuth(), { fetchImpl });
  const comments = await port.listPullReviewComments('acme/widget', 7);

  assert.deepEqual(comments, ['这里建议提前返回']);
  assert.ok(calls[0].includes('/repos/acme/widget/pulls/7/comments'));
});

test('listIssueComments：空评论返回空数组，丢弃无 body 的条目', async () => {
  const fetchImpl = (async () => ({
    json: async () => [{ body: '' }, { }, { body: '  ' }],
    headers: new Headers(),
  })) as unknown as typeof githubFetch;

  const port = new GitHubReadPortImpl(fakeAuth(), { fetchImpl });
  assert.deepEqual(await port.listIssueComments('acme/widget', 1), []);
});
```

**注意**：`fakeAuth()` 与 `fetchImpl` 的确切构造方式必须照抄 `src/test/unit/github-read-port.test.ts` 既有测试，勿臆造。

- [ ] **Step 2: 跑测试确认失败**

```bash
npm run build && node --test --test-force-exit dist/test/unit/github-read-port.test.js
```

Expected: FAIL —— `port.listIssueComments is not a function`

- [ ] **Step 3: 接口加两个方法声明**

在 `src/integrations/github/github-read-port.ts` 的 `GitHubReadPort` 接口（:76-87）内，`getFileContent` 声明之后追加：

```ts
  /** 列某 issue 的讨论评论正文（丢弃空正文）。 */
  listIssueComments(repo: string, issueNumber: number): Promise<string[]>;
  /** 列某 PR 的 review 评论正文（丢弃空正文）。 */
  listPullReviewComments(repo: string, pullNumber: number): Promise<string[]>;
```

- [ ] **Step 4: 实现两个方法**

在 `GitHubReadPortImpl` 的 `getFileContent` 实现之后追加：

```ts
  async listIssueComments(repo: string, issueNumber: number): Promise<string[]> {
    return this.listComments(`${this.apiBase}/repos/${repo}/issues/${issueNumber}/comments`);
  }

  async listPullReviewComments(repo: string, pullNumber: number): Promise<string[]> {
    return this.listComments(`${this.apiBase}/repos/${repo}/pulls/${pullNumber}/comments`);
  }

  /**
   * 评论抓取公共实现：带 per_page 跟随分页拉全量，只取正文字符串。
   * 空正文/缺 body 的条目直接丢弃——mapper 只消费有内容的讨论要点。
   */
  private async listComments(baseUrl: string): Promise<string[]> {
    const url = new URL(baseUrl);
    url.searchParams.set('per_page', String(PER_PAGE));
    const raw = await this.fetchAllPages(url.toString());
    return raw
      .map((item) => (item as Record<string, unknown>).body)
      .filter((body): body is string => typeof body === 'string' && body.trim().length > 0);
  }
```

- [ ] **Step 5: 跑测试确认通过**

```bash
npm run build && node --test --test-force-exit dist/test/unit/github-read-port.test.js
```

Expected: PASS（3 个新测试通过）

- [ ] **Step 6: 验证只读契约未破**

```bash
npm run build && node --test --test-force-exit dist/test/contract/github-write-port-arch.test.js
```

Expected: PASS —— 新增的都是 list 只读方法，反射断言应继续通过。若失败说明命名被误判为写方法，改名以 `list`/`get` 开头。

- [ ] **Step 7: 提交**

```bash
git add src/integrations/github/github-read-port.ts src/test/unit/github-read-port.test.ts
git commit -m "feat(github): ReadPort 支持抓取 issue 讨论与 PR review 评论

复用既有 fetchAllPages 分页与 SSRF 网关，只取评论正文并丢弃空条目。
只读契约不破（均为 list 方法），架构反射断言继续通过。"
```

---

### Task 4: Service 接线评论抓取 + 演进式取代

**Files:**
- Modify: `src/integrations/github/github-learning-service.ts`
- Test: `src/test/integration/github-learn-e2e.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `store.findMemoryIdByDiscussionKey` / `store.recordMemoryId` / `claimDigest(..., discussionKey?)`；Task 3 的 `readPort.listIssueComments` / `listPullReviewComments`
- Produces: `learn()` 返回值形状不变（`{ingested, skipped, cursorAdvanced}`），但记忆内容含真实讨论且同讨论恒为一条

**背景**：
- **已核实：`GitHubIssue` 当前不含 `comments` 字段**（`github-read-port.ts:43-48` 只有 number/title/body/updatedAt），必须先补。见本 Task Step 3a。
- `PerceptionDistiller.perceive()` 返回 `{memoryIds, candidates, teacherFailed}`（`perception-distiller.ts:133`）。
- 删记忆用 `core.memories.deleteMemory(id)`（`src/core/memory-graph.ts:99`）。Service 目前无 memories 句柄，需在 `GitHubLearningServiceDeps` 新增。

- [ ] **Step 1: 写失败的集成测试**

在 `src/test/integration/github-learn-e2e.test.ts` 追加（照该文件既有 fixture 写法）：

```ts
test('演进式取代：同一 issue 新增评论后再学，旧记忆被取代而非堆积', async () => {
  const harness = makeHarness();   /* 复用本文件既有 fixture 工厂名 */

  /* 第一轮：issue 无讨论 */
  harness.readPort.issues = [{ number: 42, title: '登录报错', body: '点登录白屏', updatedAt: '2026-08-01T00:00:00Z', comments: 0 }];
  harness.readPort.commentsByIssue = {};
  await harness.service.learn('acme/widget', ['issues']);

  const afterFirst = [...harness.os.core.memories.getAllMemories().values()];
  const firstIssueMems = afterFirst.filter((m) => m.content.includes('#42'));
  assert.equal(firstIssueMems.length, 1, '第一轮应沉淀 1 条 issue 记忆');

  /* 第二轮：同 issue 有了讨论结论，updatedAt 前进 */
  harness.readPort.issues = [{ number: 42, title: '登录报错', body: '点登录白屏', updatedAt: '2026-08-02T00:00:00Z', comments: 2 }];
  harness.readPort.commentsByIssue = { 42: ['定位为 token 过期', '已修复见 PR #43'] };
  await harness.service.learn('acme/widget', ['issues']);

  const afterSecond = [...harness.os.core.memories.getAllMemories().values()];
  const secondIssueMems = afterSecond.filter((m) => m.content.includes('#42'));

  assert.equal(secondIssueMems.length, 1, '第二轮后同 issue 仍应恒为 1 条（取代而非堆积）');
  assert.ok(
    secondIssueMems[0].content.includes('token 过期'),
    '记忆内容应更新为含讨论结论的最新版',
  );
  assert.ok(
    !afterSecond.some((m) => m.id === firstIssueMems[0].id),
    '旧记忆应已被删除',
  );
});

test('零评论跳过：comments 计数为 0 的 issue 不触发评论请求', async () => {
  const harness = makeHarness();
  harness.readPort.issues = [{ number: 7, title: '文档笔误', body: '拼写错误', updatedAt: '2026-08-01T00:00:00Z', comments: 0 }];
  harness.readPort.commentsByIssue = {};

  await harness.service.learn('acme/widget', ['issues']);

  assert.equal(harness.readPort.commentCallCount, 0, '无讨论的 issue 不应发出评论请求');
});
```

**注意**：本文件既有 fixture 的 fake ReadPort 需扩展支持 `commentsByIssue`、`commentCallCount`、以及 `listIssueComments`/`listPullReviewComments` 两方法（fake 实现即从 `commentsByIssue` 取值并自增计数）。照抄该文件既有 fake 的构造风格。

- [ ] **Step 2: 跑测试确认失败**

```bash
npm run build && node --test --test-force-exit dist/test/integration/github-learn-e2e.test.js
```

Expected: FAIL —— 第一个测试在第二轮断言处失败（当前会堆积成 2 条），或因 fake 缺方法而报错

- [ ] **Step 3a: GitHubIssue 补 comments 计数字段**

修改 `src/integrations/github/github-read-port.ts:43-48` 的 `GitHubIssue` 接口：

```ts
export interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  updatedAt: string;
  /** 讨论评论数（GitHub 列表响应自带）。为 0 时跳过评论抓取，省一次请求。 */
  comments: number;
}
```

同步修改 `mapIssue` 私有映射（:283-291），在返回对象里加：

```ts
      comments: typeof o.comments === 'number' ? o.comments : 0,
```

**注意**：加必填字段后所有构造 `GitHubIssue` 的测试 fixture 都需补 `comments`，`npm run typecheck` 会逐个报出来，按报错补齐即可。

- [ ] **Step 3: Deps 加 memories 句柄**

修改 `src/integrations/github/github-learning-service.ts` 的 `GitHubLearningServiceDeps`（:47-53）：

```ts
export interface GitHubLearningServiceDeps {
  readPort: GitHubReadPort;
  store: GithubLearnStore;
  distiller: PerceptionDistiller;
  tenantId: string;
  personaId: string;
  /** 记忆图句柄：演进式取代需删掉同讨论的旧记忆（见设计 §3.3）。 */
  memories: { deleteMemory(id: string): boolean };
}
```

在类里加 `private readonly memories` 字段并于构造函数赋值（照既有五个字段写法）。

- [ ] **Step 4: 加讨论键构造与评论抓取**

在 `github-learning-service.ts` 文件底部辅助函数区加：

```ts
/**
 * 讨论稳定标识：同一 issue/PR 跨轮次恒定，与表征 sha 无关。
 * 形如 issues:acme/widget#42 —— 演进式取代据此定位「上一版记忆」。
 */
function discussionKeyOf(resourceType: GitHubResourceType, repo: string, num: number): string {
  return `${resourceType}:${repo}#${num}`;
}
```

在 `fetchAndMap` 的 issues 分支（:162-167）改为逐条抓评论：

```ts
      case 'issues': {
        const issues = await this.readPort.listIssues(repo, since);
        const items: MappedLearning[] = [];
        for (const issue of issues) {
          /* 省配额闸二：评论计数为 0 直接跳过，不发请求（闸一是增量游标，见 since）。 */
          const comments = issue.comments > 0
            ? await this.safeListIssueComments(repo, issue.number)
            : [];
          const mapped = mapIssue(repo, issue, comments);
          items.push({ ...mapped, discussionKey: discussionKeyOf('issues', repo, issue.number) });
        }
        return { items, newCursor: maxUpdatedAt(issues) };
      }
```

pulls 分支同理，改用 `safeListPullReviewComments` 与 `discussionKeyOf('pulls', repo, pull.number)`。PR 无 comments 计数字段时一律抓取（或若 API 有 `review_comments` 计数则同样做零跳过）。

加两个降级包装方法：

```ts
  /** 抓 issue 评论；失败降级为空数组——一条坏数据不阻塞整个 repo 的学习。 */
  private async safeListIssueComments(repo: string, num: number): Promise<string[]> {
    try {
      return await this.readPort.listIssueComments(repo, num);
    } catch {
      return [];
    }
  }

  /** 抓 PR review 评论；失败降级为空数组，理由同上。 */
  private async safeListPullReviewComments(repo: string, num: number): Promise<string[]> {
    try {
      return await this.readPort.listPullReviewComments(repo, num);
    } catch {
      return [];
    }
  }
```

`MappedLearning` 需带上可选 `discussionKey`。在 `github-learning-mapper.ts` 的 `MappedLearning` 接口加：
```ts
  /** 讨论稳定标识（issues/pulls 才有；code/commits 为 undefined）。 */
  discussionKey?: string;
```

- [ ] **Step 5: 实现演进式取代编排**

修改 `learnOne` 的摄入循环（:111-138）：

```ts
      for (const mapped of batch.items) {
        const now = Date.now();
        const claimed = this.store.claimDigest(
          this.personaId, repo, resourceType, mapped.contentSha, now, mapped.discussionKey,
        );
        if (!claimed) {
          skipped += 1;
          continue;
        }
        /* 取代前先记下旧记忆 ID——新记忆沉淀成功后才删，避免中途失败致知识净损失。 */
        const previousMemoryId = mapped.discussionKey
          ? this.store.findMemoryIdByDiscussionKey(this.personaId, mapped.discussionKey)
          : undefined;

        const result = await this.distiller.perceive({
          personaId: this.personaId,
          tenantId: this.tenantId,
          media: {
            modality: 'audio',
            mediaSha256: mapped.contentSha,
            durationMs: 0,
            representation: mapped.representation,
          },
        });

        /* 记忆指针回写 + 取代旧版：新记忆确实产出才取代，perceive 空产出时保留旧记忆。 */
        const newMemoryId = result.memoryIds[0];
        if (mapped.discussionKey && newMemoryId) {
          this.store.recordMemoryId(this.personaId, repo, resourceType, mapped.contentSha, newMemoryId, Date.now());
          if (previousMemoryId && previousMemoryId !== newMemoryId) {
            this.memories.deleteMemory(previousMemoryId);
          }
        }

        this.store.markIngested(this.personaId, repo, resourceType, mapped.contentSha, Date.now());
        ingested += 1;
      }
```

- [ ] **Step 6: 更新调用方注入 memories**

修改 `src/server/routes/companion/learn-github.ts:186-188` 的构造，加 `memories`：

```ts
    const service = new GitHubLearningService({
      readPort, store, distiller, tenantId: request.tenantId, personaId: COMPANION_PERSONA_ID,
      memories: tenantOS.core.memories,
    });
```

- [ ] **Step 7: 跑测试确认通过**

```bash
npm run build && node --test --test-force-exit dist/test/integration/github-learn-e2e.test.js
```

Expected: PASS —— 两个新测试通过，**且既有的内核封顶变异测试仍在**

- [ ] **Step 8: 验证内核封顶变异测试仍然有效**

临时把 `perception-distiller.ts` 里 `patternAgrees` 相关判定由 false 改 true，重跑：

```bash
npm run build && node --test --test-force-exit dist/test/integration/github-learn-e2e.test.js
```

Expected: **FAIL**（证明封顶断言仍在起作用）。确认后**立即还原改动**并重跑确认 PASS。

- [ ] **Step 9: 提交**

```bash
git add src/integrations/github/ src/server/routes/companion/learn-github.ts src/test/integration/github-learn-e2e.test.ts
git commit -m "feat(github): 讨论内容真正进记忆 + 演进式取代

issue 讨论串与 PR review 意见经 ReadPort 抓取后喂进表征，不再是
「（暂无讨论）」占位。双闸省配额：增量游标只覆盖有更新条目 + 评论
计数为零跳过不发请求。演进式取代：新记忆沉淀成功后删同讨论旧记忆，
每个 issue 恒为一条最新共识；perceive 空产出时保留旧记忆不净损失。
单条评论抓取失败降级空数组，不阻塞整批。"
```

---

### Task 5: 全门验证

**Files:** 无改动（纯验证）

- [ ] **Step 1: 跑 golden 全门**

```bash
npm run test:golden 2>&1 | tail -40
```

Expected: 全部 PASS。这一门包含 typecheck → build → unit+integration → contract → packages → ops → ga:check → licenses → db-access。

**注意**：必须跑全门，不得用 `test:packages` 子集代替——历史上正是子集漏检导致红测试进 main。

- [ ] **Step 2: 若 db-access ratchet 报错**

新增的 SQL 若触发 `check:db-access` 棘轮，按报错提示确认 `github_ingest_digests` 是否在 exempt 表清单及其指纹是否需同步更新。修正后重跑全门。

- [ ] **Step 3: 提交任何修正**

```bash
git add -A
git commit -m "chore(github): 全门验证修正"
```

---

## Self-Review

**Spec 覆盖检查**：
- §3.1 ReadPort 两方法 → Task 3 ✓
- §3.2 双闸省配额（游标 + 零评论跳过）→ Task 4 Step 4 ✓
- §3.3 演进式取代（discussion_key + memory_id）→ Task 1（列）+ Task 2（存储能力）+ Task 4 Step 5（编排）✓
- §3.4 Mapper 零改动 → 确认：仅加可选 `discussionKey` 字段到 `MappedLearning` 接口，`mapIssue`/`mapPull` 函数体不变 ✓
- §5 迁移 6 同步点 → Task 1 Steps 2-5 ✓
- §6 测试策略：ReadPort 单测（Task 3 Step 1）、取代语义集成测试（Task 4 Step 1）、零评论跳过（Task 4 Step 1）、降级容错（Task 4 Step 4 实现 + 由既有测试覆盖）、内核封顶回归（Task 4 Step 8）✓
- §8 验收标准 1-5 → Task 4 Step 7、Task 4 Step 7、Task 4 Step 7、Task 5 Step 1、Task 4 Step 8 ✓

**类型一致性检查**：
- `discussionKey` 在 Task 2（`GithubDigestClaimParams`）、Task 4（`MappedLearning`、`discussionKeyOf`）中命名一致 ✓
- `findMemoryIdByDiscussionKey` / `recordMemoryId` 在 Task 2 定义、Task 4 消费，签名一致 ✓
- `listIssueComments` / `listPullReviewComments` 在 Task 3 定义、Task 4 消费，签名一致 ✓
- `memories.deleteMemory(id): boolean` 与 `src/core/memory-graph.ts:99` 实际签名一致 ✓

**已知需实施时确认的点**（非占位符，是明确的核对指令）：
- `GitHubIssue` 是否已含 `comments: number` 字段——Task 4 背景已说明若无则需补
- 各测试文件既有 fixture 工厂的真实名字——各 Task 已明确要求照抄而非臆造

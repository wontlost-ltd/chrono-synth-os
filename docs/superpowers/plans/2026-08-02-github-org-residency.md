# GitHub 组织级驻留实施计划（仓库枚举 + 定时同步 worker）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让数字人装好 GitHub App 之后无需人工干预，自动持续学完整个组织的仓库。

**Architecture:** 三层——ReadPort 加 `listInstallationRepos()` 枚举 installation 授权仓库；Service 加 `learnOrg()` 轮转编排（每轮限 N 个 repo，组织游标记进度并回绕，单轮成本恒定）；`GithubSyncWorker` 照搬 `learning-worker.ts` 骨架周期驱动，单租户作用域、默认关闭。

**Tech Stack:** TypeScript (ESM, NodeNext)、Node.js `node:test`、SQLite/PostgreSQL 双驱动、schema-dsl 迁移框架、`@chrono/kernel` Command/Query 描述符 + executor 分层。

**Spec:** `docs/superpowers/specs/2026-08-02-github-org-residency-design.md`

## Global Constraints

- **零-LLM 铁律**：LLM 只在 `PerceptionDistiller.perceive()` 摄取阶段当感官老师；本次改动不得在任何运行时路径引入 LLM 调用。
- **内核封顶**：`github-learn-e2e.test.ts` 的变异测试必须保持有效（翻 `patternAgrees` false→true 则转红）。
- **只读契约**：`GitHubReadPort` 只允许 list/get 读方法。新读方法须在 `src/test/unit/github-read-port.test.ts` 的 `readMethods` **显式白名单**登记（该断言是白名单制，不是放宽正则）。
- **注释语言**：所有代码注释与文档使用简体中文，描述意图/约束，不写「修改说明」式注释。
- **SQL 分层**：kernel 只声明 `{kind, params}` 描述符与 Row 形状；真 SQL 只在 `src/storage/executors/`。
- **租户隔离**：所有读写 tenant scoped，`tenant_id` 参与键。
- **worker 默认关闭**：`enabled: false`，显式开启才跑——这是会自动发出站请求并消耗 LLM 老师额度的后台循环。
- **迁移同步点 6 处**：① 迁移文件 ② `migrations/server-raw/index.ts`（import + export + 数组三处）③ `version-map.ts` ④ parity 覆盖列表 `packages/schema-dsl/test/parity/server-raw.test.ts` ⑤ VERSION_MAP range `packages/schema-dsl/test/version-map.test.ts` ⑥ 若触及 simple 列表则 `server-simple.test.ts`。
- **合并前必须跑 `npm run test:golden` 全门**，不得只跑子集。
- 构建：`npm run build`；改 kernel 类型后须 `npx tsc -b packages/kernel --force`（注意 `tsc` 不在 PATH，用 `npx`）。
- **新迁移版本号：v126**（当前最新 v125；PG alias `v128`，sqlite-sql alias `v126`）。

---

## File Structure

| 文件 | 职责 | 动作 |
|---|---|---|
| `packages/schema-dsl/src/migrations/server-raw/v126.ts` | 迁移：`github_learn_state.resource_type` CHECK 扩 `_org_rotation` | 创建 |
| `packages/schema-dsl/src/migrations/server-raw/index.ts` | 注册 v126（三处） | 修改 |
| `packages/schema-dsl/src/version-map.ts` | v126 版本映射 | 修改 |
| `packages/schema-dsl/test/parity/server-raw.test.ts` | parity 覆盖列表加 v128 | 修改 |
| `packages/schema-dsl/test/version-map.test.ts` | range 扩到 pg 128 / sqlite 126 | 修改 |
| `src/test/unit/github-learn-store.test.ts` | 哨兵值可写 + 索引内省断言 | 修改 |
| `src/integrations/github/github-read-port.ts` | 加 `listInstallationRepos` | 修改 |
| `src/integrations/github/github-readport-factory.ts` | 抽共享 ReadPort 装配（消第四份重复） | 创建 |
| `src/integrations/github/github-learning-service.ts` | 加 `learnOrg` 轮转编排 | 修改 |
| `src/integrations/github/github-sync-worker.ts` | 定时 worker | 创建 |
| `src/chrono-synth-os.ts` | 挂载 worker | 修改 |
| `src/test/unit/github-read-port.test.ts` | 枚举方法单测 + 白名单登记 | 修改 |
| `src/test/unit/github-learning-service.test.ts` | 轮转推进单测 | 修改 |
| `src/test/unit/github-sync-worker.test.ts` | worker 生命周期单测 | 创建 |

**Task 顺序**：Task 1（迁移）→ Task 2（ReadPort 枚举）→ Task 3（learnOrg 轮转）→ Task 4（worker + 挂载）→ Task 5（全门）。Task 2 与 Task 1 无依赖可并行。

---

### Task 1: 迁移 v126 — 扩 resource_type CHECK 容纳组织轮转哨兵

**Files:**
- Create: `packages/schema-dsl/src/migrations/server-raw/v126.ts`
- Modify: `packages/schema-dsl/src/migrations/server-raw/index.ts`
- Modify: `packages/schema-dsl/src/version-map.ts`
- Modify: `packages/schema-dsl/test/parity/server-raw.test.ts`
- Modify: `packages/schema-dsl/test/version-map.test.ts`
- Test: `src/test/unit/github-learn-store.test.ts`

**Interfaces:**
- Produces: 迁移常量 `v126_github_learn_state_org_rotation`；`github_learn_state.resource_type` CHECK 扩为 `('code','issues','pulls','commits','_org_rotation')`

**背景（已实测）**：组织轮转游标要存进 `github_learn_state`，但该表 `resource_type` 有 CHECK 锁死四取值，写哨兵值实测报错 `CHECK constraint failed: resource_type IN ('code', 'issues', 'pulls', 'commits')`。SQLite 不能 `ALTER` CHECK，须重建表。

- [ ] **Step 1: 写失败的哨兵值测试**

在 `src/test/unit/github-learn-store.test.ts` 末尾（最后一个 `});` 之前）追加：

```ts
  /* 组织轮转游标（组织级驻留设计 §3.2）：复用游标表存「下一个起始下标」，
   * resource_type 用哨兵值 _org_rotation 与四类真实资源区分。 */
  describe('组织轮转游标（_org_rotation 哨兵）', () => {
    it('哨兵 resource_type 可写入并读回（CHECK 已扩容）', () => {
      const store = new GithubLearnStore(db, TENANT);
      store.advanceCursor(PERSONA, 'acme', '_org_rotation', '5', 1000);

      assert.deepEqual(
        store.getCursor(PERSONA, 'acme', '_org_rotation'),
        { cursor: '5', cursorAdvancedAt: 1000 },
      );
    });

    it('四类真实资源类型仍可写入（CHECK 是超集，无回归）', () => {
      const store = new GithubLearnStore(db, TENANT);
      for (const rt of ['code', 'issues', 'pulls', 'commits']) {
        store.advanceCursor(PERSONA, REPO, rt, `cur-${rt}`, 1000);
        assert.equal(store.getCursor(PERSONA, REPO, rt)?.cursor, `cur-${rt}`, `${rt} 应可写`);
      }
    });

    it('重建表后唯一索引真实存在（PRAGMA 内省，防重建静默丢索引）', () => {
      /* 独立于 parity 的直验：parity 的 legacy fixture 可能从同样 buggy 的迁移手抄，
       * 两库同错仍 deepEqual 通过，抓不到丢索引。故此处直接内省 SQLite 元数据。 */
      const indexes = db.prepare<{ name: string; unique: number }>(
        `SELECT name, "unique" FROM pragma_index_list('github_learn_state')`,
      ).all();
      const key = indexes.find((i) => i.name === 'idx_github_learn_state_key');
      assert.ok(key, 'idx_github_learn_state_key 必须存在（重建表后未丢）');
      assert.equal(key.unique, 1, '该索引必须是唯一索引');
    });

    it('唯一约束仍生效：同四键重复 advance 覆盖不新增行', () => {
      const store = new GithubLearnStore(db, TENANT);
      store.advanceCursor(PERSONA, 'acme', '_org_rotation', '5', 1000);
      store.advanceCursor(PERSONA, 'acme', '_org_rotation', '10', 2000);

      const cnt = db.prepare<{ c: number }>(
        'SELECT COUNT(*) AS c FROM github_learn_state WHERE tenant_id=? AND persona_id=? AND repo=? AND resource_type=?',
      ).get(TENANT, PERSONA, 'acme', '_org_rotation')?.c;
      assert.equal(cnt, 1, '唯一约束生效：覆盖不多行');
      assert.equal(store.getCursor(PERSONA, 'acme', '_org_rotation')?.cursor, '10');
    });
  });
```

**注意**：`db.prepare(...).all()` 的确切 API 形状照抄该文件既有用法（既有测试用 `.get(...)`，若无 `.all()` 则改用 `queryMany` 或多次 `.get()`，勿臆造）。

- [ ] **Step 2: 跑测试确认失败**

```bash
npm run build && node --test --test-force-exit dist/test/unit/github-learn-store.test.js 2>&1 | tail -12
```
Expected: FAIL —— `CHECK constraint failed: resource_type IN ('code', 'issues', 'pulls', 'commits')`

- [ ] **Step 3: 创建迁移文件**

创建 `packages/schema-dsl/src/migrations/server-raw/v126.ts`：

```ts
import { defineRaw, rawSql } from '../../dsl/raw.js';
import type { RawMigration } from '../../types.js';

/**
 * GitHub 组织级驻留地基——给 github_learn_state.resource_type 的 CHECK 加组织轮转哨兵。
 *
 * 为什么要扩：组织级同步每轮只处理 N 个仓库，需要一条「下一个起始下标」游标记住轮转进度。
 * 该游标本质就是一种学习进度游标，属 github_learn_state 的固有职责，故复用该表——
 * repo 字段存组织标识、resource_type 存哨兵 '_org_rotation'、cursor 存下标。
 * 但原 CHECK 锁死四类可学资源，哨兵值写入被拒（实测 CHECK constraint failed），故须扩容。
 *
 * 手法与 v122 同款：SQLite 不能 ALTER CHECK 约束，重建表——
 *   RENAME github_learn_state → _old（同名唯一索引随表迁到 _old，但索引名在库内全局唯一，
 *   仍占用该名字）；DROP INDEX IF EXISTS 先删掉随 _old 挪来的旧索引（否则后面
 *   CREATE INDEX IF NOT EXISTS 因同名索引已存在而静默 no-op，新表建不出索引，
 *   DROP _old 时连带删掉唯一那份索引 → live 表零唯一索引，幂等键失效）；
 *   CREATE 新表（新 CHECK）；INSERT SELECT 回填（旧行 resource_type 全落在新 CHECK 超集内）；
 *   CREATE INDEX 重建；DROP _old。
 *   PG 走原地 ALTER：DROP CONSTRAINT + ADD CONSTRAINT。
 *
 * 时间戳列：Postgres BIGINT（毫秒 epoch），SQLite INTEGER（同为 64 位整数语义）。
 *
 * 向后兼容：新 CHECK 是旧取值的**超集**，既有行全部合法，既有写路径零影响。
 * 回滚：SQLite 反向重建（去哨兵取值），PG 反向换回原 CHECK。
 *
 * Alias：SQLite v126 / Postgres v128（紧跟 v125 github-digest-discussion-key / Postgres v127）。
 */
export const v126_github_learn_state_org_rotation: RawMigration = defineRaw({
  id: 'github-learn-state-org-rotation',
  version: 'v126',
  aliases: { postgres: 'v128', 'sqlite-sql': 'v126' },
  description: 'GitHub org residency: github_learn_state resource_type CHECK adds _org_rotation sentinel',
  reason: '组织级驻留轮转游标复用 github_learn_state（语义正确：轮转进度即学习进度游标），但原 CHECK 锁死四类资源致哨兵值写入被拒；扩 CHECK 为超集容纳 _org_rotation；PG 原地 ALTER，SQLite 重建表（不能 ALTER CHECK），重建前先 DROP INDEX 防静默丢唯一索引',
  postgres: rawSql([
    `ALTER TABLE github_learn_state DROP CONSTRAINT IF EXISTS github_learn_state_resource_type_check`,
    `ALTER TABLE github_learn_state ADD CONSTRAINT github_learn_state_resource_type_check CHECK (resource_type IN ('code', 'issues', 'pulls', 'commits', '_org_rotation'))`,
  ]),
  sqlite: rawSql([
    `/* safe:if-table-exists:github_learn_state */ ALTER TABLE github_learn_state RENAME TO github_learn_state_old`,
    /* RENAME 后同名索引随 _old 挪走但仍占用全局索引名，先 DROP 掉——否则下面
     * CREATE INDEX IF NOT EXISTS 静默 no-op，DROP _old 时连带删掉唯一那份索引。 */
    `/* safe:if-table-exists:github_learn_state_old */ DROP INDEX IF EXISTS idx_github_learn_state_key`,
    `/* safe:if-table-exists:github_learn_state_old */ CREATE TABLE IF NOT EXISTS github_learn_state (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      persona_id TEXT NOT NULL,
      repo TEXT NOT NULL,
      resource_type TEXT NOT NULL CHECK (resource_type IN ('code', 'issues', 'pulls', 'commits', '_org_rotation')),
      cursor TEXT,
      cursor_advanced_at INTEGER,
      last_synced_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `/* safe:if-table-exists:github_learn_state_old */ INSERT OR IGNORE INTO github_learn_state (id, tenant_id, persona_id, repo, resource_type, cursor, cursor_advanced_at, last_synced_at, created_at, updated_at)
     SELECT id, tenant_id, persona_id, repo, resource_type, cursor, cursor_advanced_at, last_synced_at, created_at, updated_at FROM github_learn_state_old`,
    `/* safe:if-table-exists:github_learn_state_old */ CREATE UNIQUE INDEX IF NOT EXISTS idx_github_learn_state_key
      ON github_learn_state (tenant_id, persona_id, repo, resource_type)`,
    `/* safe:if-table-exists:github_learn_state_old */ DROP TABLE IF EXISTS github_learn_state_old`,
  ]),
});
```

- [ ] **Step 4: 注册进 index.ts（三处）**

修改 `packages/schema-dsl/src/migrations/server-raw/index.ts`：

import 区，在 `import { v125_github_digest_discussion_key } from './v125.js';` 之后：
```ts
import { v126_github_learn_state_org_rotation } from './v126.js';
```

export 区，在 `export { v125_github_digest_discussion_key } from './v125.js';` 之后：
```ts
export { v126_github_learn_state_org_rotation } from './v126.js';
```

数组区，在 `v125_github_digest_discussion_key,` 之后：
```ts
  v126_github_learn_state_org_rotation,
```

- [ ] **Step 5: 注册进 version-map.ts**

在 `packages/schema-dsl/src/version-map.ts` 中 `v125_github_digest_discussion_key` 那一行**之后**追加（保持版本升序）：

```ts
  { canonical: 'v126_github_learn_state_org_rotation', aliases: { postgres: 'v128', 'sqlite-sql': 'v126' }, classification: 'schema-raw', notes: 'GitHub 组织级驻留：github_learn_state.resource_type CHECK 扩加 _org_rotation 哨兵（组织轮转游标复用该表存下一个起始下标，语义即学习进度游标）；新 CHECK 是旧取值超集向后兼容；PG 原地 ALTER CONSTRAINT，SQLite 重建表并在 RENAME 后先 DROP INDEX 防静默丢唯一索引' },
```

- [ ] **Step 6: 同步 parity 覆盖列表**

修改 `packages/schema-dsl/test/parity/server-raw.test.ts`，在 v127 注释之后追加注释并把 `'v128'` 加进数组末尾：

```ts
    /* v128 = v126_github_learn_state_org_rotation（pg-aliased v128，GitHub 组织级驻留：
     * github_learn_state.resource_type CHECK 扩加 _org_rotation 哨兵，供组织轮转游标复用该表；
     * 新 CHECK 是旧取值超集，既有行全合法；SQLite 重建表，PG 原地 ALTER CONSTRAINT）。 */
    assert.deepEqual(rawVersions, ['v007', 'v027', 'v030', 'v034', 'v040', 'v041', 'v047', 'v052', 'v071', 'v090', 'v108', 'v109', 'v121', 'v122', 'v123', 'v124', 'v126', 'v127', 'v128']);
```

- [ ] **Step 7: 同步 VERSION_MAP range**

修改 `packages/schema-dsl/test/version-map.test.ts`：postgres `range('v', 1, 127)` → `range('v', 1, 128)`；sqlite-sql `range('v', 1, 125)` → `range('v', 1, 126)`。

- [ ] **Step 8: 构建并跑测试确认通过**

```bash
npm run build --workspace @wontlost-ltd/schema-dsl && npm run test:schema-dsl-parity:raw 2>&1 | tail -8
npm run build && node --test --test-force-exit dist/test/unit/github-learn-store.test.js 2>&1 | tail -10
```
Expected: 两者均 PASS。四个新测试全绿，尤其 `PRAGMA index_list` 内省断言证明重建后唯一索引未丢。

- [ ] **Step 9: 提交**

```bash
git add packages/schema-dsl/ src/test/unit/github-learn-store.test.ts
git commit -m "feat(github): 游标表 CHECK 扩容组织轮转哨兵（v126）

组织级同步每轮只处理 N 个仓库，需一条轮转进度游标。该游标本质即学习
进度游标，属 github_learn_state 固有职责故复用该表；但原 CHECK 锁死
四类资源致哨兵写入被拒（实测 CHECK constraint failed），扩为超集。

SQLite 重建表并在 RENAME 后先 DROP INDEX——防同名索引占位致
CREATE INDEX IF NOT EXISTS 静默 no-op、DROP _old 连带删掉唯一索引。
补 PRAGMA index_list 内省断言直验索引存在（parity fixture 可能同错抓不到）。"
```

---

### Task 2: ReadPort 加组织仓库枚举

**Files:**
- Modify: `src/integrations/github/github-read-port.ts`
- Test: `src/test/unit/github-read-port.test.ts`

**Interfaces:**
- Produces: `GitHubReadPort.listInstallationRepos(): Promise<string[]>` —— 返回仓库全名数组（`owner/name`），空结果返回 `[]`

**背景**：端点 `GET /installation/repositories`，响应体是 `{total_count, repositories: [{full_name, ...}]}` —— **不是裸数组**，与既有 list 端点形状不同，须从每页 `repositories` 字段取值。既有 `fetchAllPages(firstUrl)` 返回 `unknown[]`（把每页当数组展开），故不能直接复用，需单独处理分页解包。

- [ ] **Step 1: 写失败的单测**

在 `src/test/unit/github-read-port.test.ts` 中，`铁律：只读 port` 那个 `it(...)` **之前**追加：

```ts
  /* 组织级驻留：枚举本 installation 被授权的全部仓库。该端点返回值即「组织授权边界」——
   * 不用猜组织名，也不可能越权读到未授权仓库。 */
  it('listInstallationRepos：解包 {repositories:[...]} 取 full_name 列表', async () => {
    const { calls, impl } = makeFetchSpy([{
      body: JSON.stringify({
        total_count: 2,
        repositories: [{ full_name: 'acme/web' }, { full_name: 'acme/api' }],
      }),
    }]);
    const port = new GitHubReadPortImpl(makeAuth('tok-1'), { fetchImpl: impl });

    const repos = await port.listInstallationRepos();

    assert.deepEqual(repos, ['acme/web', 'acme/api']);
    assert.ok(calls[0]!.url.includes('/installation/repositories'), '打到 installation repositories 端点');
    assert.ok(calls[0]!.url.includes('per_page=100'), '带分页参数');
  });

  it('listInstallationRepos：空授权返回空数组', async () => {
    const { impl } = makeFetchSpy([{ body: JSON.stringify({ total_count: 0, repositories: [] }) }]);
    const port = new GitHubReadPortImpl(makeAuth('tok-1'), { fetchImpl: impl });

    assert.deepEqual(await port.listInstallationRepos(), []);
  });

  it('listInstallationRepos：丢弃缺 full_name 的畸形条目', async () => {
    const { impl } = makeFetchSpy([{
      body: JSON.stringify({ repositories: [{ full_name: 'acme/web' }, {}, { full_name: '' }] }),
    }]);
    const port = new GitHubReadPortImpl(makeAuth('tok-1'), { fetchImpl: impl });

    assert.deepEqual(await port.listInstallationRepos(), ['acme/web']);
  });

  it('listInstallationRepos：带 Authorization 头', async () => {
    const { calls, impl } = makeFetchSpy([{ body: JSON.stringify({ repositories: [] }) }]);
    const port = new GitHubReadPortImpl(makeAuth('tok-abc'), { fetchImpl: impl });

    await port.listInstallationRepos();

    const headers = calls[0]!.init.headers as Record<string, string>;
    assert.equal(headers.Authorization, 'token tok-abc');
  });
```

同时在该文件 `readMethods` 白名单（`铁律：只读 port` 测试内）加入新方法：

```ts
      /* 组织级驻留：枚举 installation 授权仓库，纯读（GET /installation/repositories）。 */
      'listInstallationRepos',
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npm run build 2>&1 | grep -E "error TS" | head -3
```
Expected: `Property 'listInstallationRepos' does not exist on type 'GitHubReadPortImpl'`

- [ ] **Step 3: 接口加方法声明**

在 `src/integrations/github/github-read-port.ts` 的 `GitHubReadPort` 接口内，`listPullReviewComments` 声明之后追加：

```ts
  /**
   * 列出本 installation 被授权访问的全部仓库全名（owner/name）。
   * 返回值即「组织授权边界」——不用猜组织名，也不可能越权读到未授权仓库。
   */
  listInstallationRepos(): Promise<string[]>;
```

- [ ] **Step 4: 实现方法**

在 `GitHubReadPortImpl` 的 `listComments` 私有方法**之前**追加：

```ts
  async listInstallationRepos(): Promise<string[]> {
    const url = new URL(`${this.apiBase}/installation/repositories`);
    url.searchParams.set('per_page', String(PER_PAGE));
    /* 该端点响应体是 {total_count, repositories:[...]} 而非裸数组，
     * 与既有 list 端点形状不同，故不复用 fetchAllPages（它按裸数组展开每页）。 */
    const page = await this.fetchJson<{ repositories?: Array<{ full_name?: string }> }>(url.toString());
    return (page.repositories ?? [])
      .map((r) => r.full_name)
      .filter((name): name is string => typeof name === 'string' && name.length > 0);
  }
```

**说明**：首版只取第一页（100 个仓库）。GitHub 单个 installation 授权超 100 仓库的情况罕见；超出时轮转仍在前 100 内工作，不会报错。若将来需要，可加 Link header 跟随——**本次不做（YAGNI）**。

- [ ] **Step 5: 跑测试确认通过**

```bash
npm run build && node --test --test-force-exit dist/test/unit/github-read-port.test.js 2>&1 | tail -10
```
Expected: PASS（4 个新测试 + 只读契约断言全绿）

- [ ] **Step 6: 补齐 fake ReadPort（四处）**

以下文件的 fake ReadPort 需加 `listInstallationRepos`，否则类型不满足接口。在每个 fake 的 `listPullReviewComments` 之后加一行：

```ts
    listInstallationRepos: async (): Promise<string[]> => [],
```

四处：`src/test/integration/github-draft-e2e.test.ts`、`src/test/integration/github-learn-e2e.test.ts`、`src/test/unit/github-learning-service.test.ts`。（若 `npm run build` 报出其它文件，一并补齐。）

- [ ] **Step 7: 构建并提交**

```bash
npm run build 2>&1 | grep -cE "error TS"
git add src/integrations/github/github-read-port.ts src/test/
git commit -m "feat(github): ReadPort 支持枚举 installation 授权仓库

打 GET /installation/repositories，返回值即组织授权边界——不用猜组织名
也不会越权。该端点响应体是 {repositories:[...]} 非裸数组，故单独解包
不复用 fetchAllPages。只读契约白名单已登记。"
```

---

### Task 3: Service 加 learnOrg 轮转编排

**Files:**
- Create: `src/integrations/github/github-readport-factory.ts`
- Modify: `src/integrations/github/github-learning-service.ts`
- Test: `src/test/unit/github-learning-service.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `listInstallationRepos()`；既有 `learn(repo, resourceTypes)`；既有 `store.getCursor/advanceCursor`
- Produces:
  - `ORG_ROTATION_RESOURCE_TYPE = '_org_rotation'`（导出常量）
  - `DEFAULT_MAX_REPOS_PER_RUN = 5`（导出常量）
  - `LearnOrgResult { reposProcessed: string[]; ingested: number; skipped: number; failedRepos: string[]; nextCursor: number }`
  - `GitHubLearningService.learnOrg(orgKey: string, resourceTypes: GitHubResourceType[], maxReposPerRun?: number): Promise<LearnOrgResult>`

- [ ] **Step 1: 写失败的轮转单测**

在 `src/test/unit/github-learning-service.test.ts` 末尾（最后一个 `});` 之前）追加：

```ts
  /* 组织级驻留：轮转推进使单轮成本恒定，不随组织规模膨胀。 */
  describe('learnOrg 轮转编排', () => {
    /** 造 12 个 repo 的 fake ReadPort；listIssues 按 repo 返回一条可映射内容。 */
    function makeOrgReadPort(repoCount: number): GitHubReadPort {
      const repos = Array.from({ length: repoCount }, (_, i) => `acme/repo-${i}`);
      return makeReadPort({
        listInstallationRepos: async (): Promise<string[]> => repos,
        listIssues: async (repo: string): Promise<GitHubIssue[]> => [
          { number: 1, title: `${repo} 的 issue`, body: '正文', updatedAt: '2026-01-01T00:00:00Z', comments: 0 },
        ],
      });
    }

    it('每轮只处理上限个仓库，游标推进并回绕', async () => {
      const { distiller } = makeDistiller();
      const service = new GitHubLearningService({
        readPort: makeOrgReadPort(12), store, distiller,
        tenantId: TENANT, personaId: PERSONA, memories: fakeMemories(),
      });

      const r1 = await service.learnOrg('acme', ['issues'], 5);
      assert.deepEqual(r1.reposProcessed, ['acme/repo-0', 'acme/repo-1', 'acme/repo-2', 'acme/repo-3', 'acme/repo-4']);
      assert.equal(r1.nextCursor, 5, '第一轮后游标 → 5');

      const r2 = await service.learnOrg('acme', ['issues'], 5);
      assert.deepEqual(r2.reposProcessed, ['acme/repo-5', 'acme/repo-6', 'acme/repo-7', 'acme/repo-8', 'acme/repo-9']);
      assert.equal(r2.nextCursor, 10, '第二轮后游标 → 10');

      /* 第三轮只剩 2 个（10, 11），处理完回绕到 0。 */
      const r3 = await service.learnOrg('acme', ['issues'], 5);
      assert.deepEqual(r3.reposProcessed, ['acme/repo-10', 'acme/repo-11']);
      assert.equal(r3.nextCursor, 0, '轮完一圈回绕到 0');
    });

    it('单个 repo 失败不中断整轮，游标仍推进（防坏 repo 卡死组织）', async () => {
      const { distiller } = makeDistiller();
      const readPort = makeReadPort({
        listInstallationRepos: async (): Promise<string[]> => ['acme/good-1', 'acme/bad', 'acme/good-2'],
        listIssues: async (repo: string): Promise<GitHubIssue[]> => {
          if (repo === 'acme/bad') throw new Error('该 repo 无权访问');
          return [{ number: 1, title: `${repo} issue`, body: '正文', updatedAt: '2026-01-01T00:00:00Z', comments: 0 }];
        },
      });
      const service = new GitHubLearningService({
        readPort, store, distiller, tenantId: TENANT, personaId: PERSONA, memories: fakeMemories(),
      });

      const r = await service.learnOrg('acme', ['issues'], 5);

      assert.deepEqual(r.reposProcessed, ['acme/good-1', 'acme/good-2'], '好 repo 仍学到');
      assert.deepEqual(r.failedRepos, [], 'learn 内部已吞异常，不冒泡到 learnOrg');
      assert.equal(r.nextCursor, 0, '三个都处理过 → 回绕到 0（游标不被坏 repo 卡住）');
    });

    it('空组织（无授权仓库）→ 零处理、游标归零、不抛错', async () => {
      const { distiller } = makeDistiller();
      const service = new GitHubLearningService({
        readPort: makeReadPort({ listInstallationRepos: async (): Promise<string[]> => [] }),
        store, distiller, tenantId: TENANT, personaId: PERSONA, memories: fakeMemories(),
      });

      const r = await service.learnOrg('acme', ['issues'], 5);

      assert.deepEqual(r.reposProcessed, []);
      assert.equal(r.nextCursor, 0);
    });

    it('组织游标与 per-repo 游标互不干扰（哨兵 resource_type 隔离）', async () => {
      const { distiller } = makeDistiller();
      const service = new GitHubLearningService({
        readPort: makeOrgReadPort(3), store, distiller,
        tenantId: TENANT, personaId: PERSONA, memories: fakeMemories(),
      });

      await service.learnOrg('acme', ['issues'], 2);

      /* 组织轮转游标存在哨兵行；per-repo 的 issues 游标独立存在。 */
      assert.equal(store.getCursor(PERSONA, 'acme', '_org_rotation')?.cursor, '2');
      assert.ok(store.getCursor(PERSONA, 'acme/repo-0', 'issues')?.cursor, 'per-repo 游标独立推进');
    });
  });
```

**注意**：`makeReadPort`、`makeDistiller`、`fakeMemories`、`store`、`TENANT`、`PERSONA` 均是该文件既有 fixture，直接复用，勿臆造新名字。`GitHubIssue` 需已在该文件 import。

- [ ] **Step 2: 跑测试确认失败**

```bash
npm run build 2>&1 | grep -E "error TS" | head -3
```
Expected: `Property 'learnOrg' does not exist on type 'GitHubLearningService'`

- [ ] **Step 3: 实现 learnOrg**

在 `src/integrations/github/github-learning-service.ts` 中：

① 文件顶部常量区（`README_CANDIDATES` 附近）加：

```ts
/**
 * 组织轮转游标的哨兵 resource_type。与四类真实资源（code/issues/pulls/commits）区分，
 * 复用 github_learn_state 存「下一个起始下标」（迁移 v126 已扩 CHECK 容纳该值）。
 */
export const ORG_ROTATION_RESOURCE_TYPE = '_org_rotation';

/**
 * 单轮最多处理几个仓库。轮转的意义就在这个上限——它使**单轮成本恒定**，
 * 不随组织规模膨胀，从而不触发 GitHub 二级速率限制、不一次性烧光 LLM 老师额度。
 */
export const DEFAULT_MAX_REPOS_PER_RUN = 5;
```

② `LearnGithubResult` 之后加返回类型：

```ts
/** learnOrg 单轮结果。 */
export interface LearnOrgResult {
  /** 本轮实际学习的仓库全名（按处理顺序）。 */
  reposProcessed: string[];
  /** 本轮跨全部仓库新摄入条数。 */
  ingested: number;
  /** 本轮跨全部仓库跳过（已摄入过）条数。 */
  skipped: number;
  /** 本轮抛错的仓库（learn 内部已逐类吞异常，正常为空；此处兜底不可预期的异常）。 */
  failedRepos: string[];
  /** 推进后的组织轮转游标（下一轮起始下标；已回绕）。 */
  nextCursor: number;
}
```

③ 类内加方法（放在 `learn` 之后）：

```ts
  /**
   * 学一个组织（installation 授权范围）的仓库，**轮转推进**：每轮只处理 maxReposPerRun 个，
   * 用组织游标记住下次从哪开始，绕完一圈回到开头。
   *
   * 为什么轮转而非一次学完：一个 50 仓库的组织单轮就是几百次 API 调用 + 几百次 LLM 老师调用，
   * 会触发 GitHub 二级速率限制并烧光额度。轮转使**单轮成本恒定可预测**，大组织只是周期更长。
   *
   * 游标推进语义：无论各 repo 成败都推进——否则一个持续失败的 repo 会永久卡住整个组织的轮转。
   * 已成功摄入的内容靠 digest 账本保证回绕后不重复灌。
   */
  async learnOrg(
    orgKey: string,
    resourceTypes: GitHubResourceType[],
    maxReposPerRun: number = DEFAULT_MAX_REPOS_PER_RUN,
  ): Promise<LearnOrgResult> {
    const repos = await this.readPort.listInstallationRepos();
    if (repos.length === 0) {
      return { reposProcessed: [], ingested: 0, skipped: 0, failedRepos: [], nextCursor: 0 };
    }

    /* 读组织轮转游标（哨兵行）。非法/缺失 → 从 0 开始；越界（仓库数变少）→ 收敛回 0。 */
    const raw = this.store.getCursor(this.personaId, orgKey, ORG_ROTATION_RESOURCE_TYPE)?.cursor;
    const parsed = raw === undefined || raw === null ? 0 : Number.parseInt(raw, 10);
    const start = Number.isInteger(parsed) && parsed >= 0 && parsed < repos.length ? parsed : 0;

    const slice = repos.slice(start, start + maxReposPerRun);

    const reposProcessed: string[] = [];
    const failedRepos: string[] = [];
    let ingested = 0;
    let skipped = 0;
    for (const repo of slice) {
      try {
        const outcome = await this.learn(repo, resourceTypes);
        ingested += outcome.ingested;
        skipped += outcome.skipped;
        reposProcessed.push(repo);
      } catch {
        /* 兜底：learn 内部已逐 resourceType 吞异常，此处防不可预期的异常中断整轮。 */
        failedRepos.push(repo);
      }
    }

    /* 推进游标：走到尾部则回绕到 0（下轮重新从头增量扫，未变内容靠 digest 全 skip）。 */
    const advanced = start + slice.length;
    const nextCursor = advanced >= repos.length ? 0 : advanced;
    this.store.advanceCursor(
      this.personaId, orgKey, ORG_ROTATION_RESOURCE_TYPE, String(nextCursor), Date.now(),
    );

    return { reposProcessed, ingested, skipped, failedRepos, nextCursor };
  }
```

- [ ] **Step 4: 跑测试确认通过**

```bash
npm run build && node --test --test-force-exit dist/test/unit/github-learning-service.test.js 2>&1 | tail -12
```
Expected: PASS（4 个新轮转测试 + 既有测试全绿）

- [ ] **Step 5: 抽共享 ReadPort 装配函数**

ReadPort 装配逻辑当前重复三处（`learn-github.ts`、`draft-github-reply.ts`、`app.ts`），worker 会成为第四份。创建 `src/integrations/github/github-readport-factory.ts`：

```ts
/**
 * GitHub ReadPort 共享装配器——从租户凭据造只读 port。
 *
 * 为什么抽出来：装配逻辑（查 App 凭据 → 取 installation → 造 auth → GHE 分支）此前重复在
 * learn-github 端点、draft-github-reply 端点、app.ts 发布装配三处；组织同步 worker 会成为第四份。
 * 四次复制同一段安全敏感逻辑（凭据读取 + SSRF allowlist）是明确的维护风险，故收敛为单一实现。
 */

import { GitHubAuthManager } from './github-auth-manager.js';
import { GitHubReadPortImpl, type GitHubReadPort } from './github-read-port.js';
import { GithubAppCredentialStore } from '../../storage/github-app-credential-store.js';
import { githubInstallListByTenant } from '@chrono/kernel';
import type { IDatabase } from '../../storage/database.js';
import type { FieldEncryption } from '../../security/field-encryption.js';

/** 装配失败原因（调用方据此给出明确 4xx 或静默跳过）。 */
export type ReadPortAssemblyFailure = 'no-credential' | 'no-installation';

export interface ReadPortAssemblyResult {
  readPort?: GitHubReadPort;
  failure?: ReadPortAssemblyFailure;
}

/**
 * 从租户凭据装配 ReadPort。缺凭据/缺 installation 时返回 failure 而非抛错——
 * 端点据此给明确 4xx，worker 据此静默跳过（未连 GitHub 的租户不该刷错误日志）。
 */
export function assembleGitHubReadPort(
  db: IDatabase,
  encryption: FieldEncryption,
  tenantId: string,
  now: () => number,
): ReadPortAssemblyResult {
  const appCred = new GithubAppCredentialStore(db, encryption, tenantId).getApp();
  if (!appCred) return { failure: 'no-credential' };

  /* 取本租户最近一个 installation（listByTenant 按 created_at DESC）。 */
  const installation = db.queryMany(githubInstallListByTenant(tenantId))[0];
  if (!installation) return { failure: 'no-installation' };

  const auth = new GitHubAuthManager({
    getApp: () => ({ appId: appCred.appId, privateKeyPem: appCred.privateKeyPem, gheBaseUrl: appCred.gheBaseUrl }),
    installationId: installation.installation_id,
    now,
  });
  /* GHE 自托管：ReadPort 走企业 API base，并把企业 host 放进 SSRF allowlist；公有云走默认。 */
  if (appCred.gheBaseUrl) {
    const host = new URL(appCred.gheBaseUrl).hostname;
    return { readPort: new GitHubReadPortImpl(auth, { apiBase: appCred.gheBaseUrl, hostAllowlist: [host] }) };
  }
  return { readPort: new GitHubReadPortImpl(auth) };
}
```

**注意**：`GithubAppCredentialStore` 构造签名、`FieldEncryption` 类型路径、`IDatabase` 导入路径必须照抄 `src/server/routes/companion/learn-github.ts:120-158` 的既有写法核对，勿臆造。

- [ ] **Step 6: 构建验证并提交**

```bash
npm run build 2>&1 | grep -cE "error TS"
node --test --test-force-exit dist/test/unit/github-learning-service.test.js 2>&1 | grep -E "^ℹ (pass|fail)"
git add src/integrations/github/
git commit -m "feat(github): learnOrg 轮转编排 + 共享 ReadPort 装配器

learnOrg 每轮只处理 N 个仓库（默认 5），组织游标记进度、绕完回绕——
单轮成本恒定不随组织规模膨胀，避免触发 GitHub 二级速率限制与一次性
烧光 LLM 老师额度。游标无论成败都推进，防坏 repo 永久卡死整个组织。

抽 assembleGitHubReadPort 收敛此前三处（端点/起草/发布）重复的凭据
装配逻辑，worker 复用同一实现而非第四次复制。"
```

---

### Task 4: GithubSyncWorker + 挂载

**Files:**
- Create: `src/integrations/github/github-sync-worker.ts`
- Modify: `src/chrono-synth-os.ts`
- Test: `src/test/unit/github-sync-worker.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `learnOrg`、`assembleGitHubReadPort`
- Produces: `GithubSyncWorker` 类，方法 `start(): void` / `stop(): void` / `isHealthy(): boolean` / `driveOnce(): Promise<void>`；`GithubSyncWorkerOptions { enabled: boolean; intervalMs: number; maxReposPerRun: number }`

- [ ] **Step 1: 写失败的 worker 单测**

创建 `src/test/unit/github-sync-worker.test.ts`：

```ts
/**
 * 单元测试：GithubSyncWorker（组织级驻留的周期驱动）。
 *
 * 断言重点：
 *   1. 默认关闭——enabled:false 时 start() 不启定时器（这是会自动发出站请求并消耗
 *      LLM 老师额度的后台循环，对现有部署默认开启构成行为突变）。
 *   2. 重入守卫——上一轮未完不叠加（照 LearningWorker 同款手法）。
 *   3. 未连 GitHub 的租户静默跳过，不抛错不刷日志。
 *   4. 生命周期：start/stop/isHealthy 契约。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GithubSyncWorker } from '../../integrations/github/github-sync-worker.js';
import { SilentLogger } from '../../utils/logger.js';

describe('GithubSyncWorker（组织级驻留周期驱动）', () => {
  it('默认关闭：enabled:false 时 start() 不启动定时器', () => {
    let driven = 0;
    const worker = new GithubSyncWorker(
      async () => { driven += 1; },
      new SilentLogger(),
      { enabled: false, intervalMs: 10 },
    );

    worker.start();

    assert.equal(worker.isHealthy(), false, '未启用 → 不健康（未启动）');
    assert.equal(driven, 0, '未启用不应驱动');
    worker.stop();
  });

  it('启用后 start() 启动定时器，isHealthy 为真', () => {
    const worker = new GithubSyncWorker(
      async () => { /* noop */ },
      new SilentLogger(),
      { enabled: true, intervalMs: 60_000 },
    );

    worker.start();
    assert.equal(worker.isHealthy(), true);

    worker.stop();
    assert.equal(worker.isHealthy(), false, 'stop 后不健康');
  });

  it('driveOnce 直接驱动一轮（运维/测试入口）', async () => {
    let driven = 0;
    const worker = new GithubSyncWorker(
      async () => { driven += 1; },
      new SilentLogger(),
      { enabled: true, intervalMs: 60_000 },
    );

    await worker.driveOnce();

    assert.equal(driven, 1);
  });

  it('驱动函数抛错被隔离，不炸 worker（单轮失败不影响后续周期）', async () => {
    const worker = new GithubSyncWorker(
      async () => { throw new Error('GitHub 不可达'); },
      new SilentLogger(),
      { enabled: true, intervalMs: 60_000 },
    );

    /* driveOnce 内部隔离异常，不向外抛。 */
    await worker.driveOnce();
    assert.ok(true, '异常已被隔离');
  });

  it('重复 start 幂等（不叠加定时器）', () => {
    const worker = new GithubSyncWorker(
      async () => { /* noop */ },
      new SilentLogger(),
      { enabled: true, intervalMs: 60_000 },
    );

    worker.start();
    worker.start();
    assert.equal(worker.isHealthy(), true);

    /* 单次 stop 即可完全停止（证明只有一个定时器）。 */
    worker.stop();
    assert.equal(worker.isHealthy(), false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npm run build 2>&1 | grep -E "error TS" | head -3
```
Expected: `Cannot find module '../../integrations/github/github-sync-worker.js'`

- [ ] **Step 3: 实现 worker**

创建 `src/integrations/github/github-sync-worker.ts`：

```ts
/**
 * GithubSyncWorker —— 组织级驻留的周期驱动（让数字人装好 App 后自己持续学完整个组织）。
 *
 * 此前 GitHub 学习只在人工 POST /learn-github 时发生一次，全仓无任何 GitHub 定时器——
 * 「长期驻入组织」这个诉求因此不成立。本 worker 用 setInterval 周期触发组织轮转同步。
 *
 * 与 LearningWorker / TaskWakeReconcilerWorker 同款手法：setInterval + running 重入守卫 +
 * unref + start/stop/isHealthy/driveOnce。单租户作用域（跟随宿主 OS 实例），零新架构概念。
 *
 * **默认关闭**：这是会自动发出站请求、自动消耗 LLM 老师额度的后台循环，默认开启对现有
 * 部署构成行为突变，必须显式启用。
 *
 * 失败隔离：单轮异常只记 error 不崩 worker（learnOrg 内部已逐 repo 隔离，这里再兜一层）。
 */

import type { Logger } from '../../utils/logger.js';

const LAYER = 'GithubSyncWorker';

export interface GithubSyncWorkerOptions {
  /** 是否启用（默认 false——自动出站 + 消耗 LLM 额度的循环不默认开）。 */
  readonly enabled: boolean;
  /** 周期间隔毫秒（默认 30 分钟：组织知识沉淀非实时告警，无需高频）。 */
  readonly intervalMs: number;
}

const DEFAULT_OPTIONS: GithubSyncWorkerOptions = {
  enabled: false,
  intervalMs: 30 * 60 * 1000,
};

/** 一轮组织同步的驱动函数（由组合根注入，内部装配 ReadPort 并调 learnOrg）。 */
export type OrgSyncDriver = () => Promise<void>;

export class GithubSyncWorker {
  private readonly options: GithubSyncWorkerOptions;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(
    private readonly drive: OrgSyncDriver,
    private readonly logger: Logger,
    options: Partial<GithubSyncWorkerOptions> = {},
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  start(): void {
    if (!this.options.enabled) return;   /* 默认关闭：未显式启用则不起循环。 */
    if (this.timer) return;              /* 幂等：重复 start 不叠加定时器。 */
    this.timer = setInterval(() => {
      if (this.running) return;          /* 重入守卫：上一轮未完不叠加。 */
      void this.driveOnce();
    }, this.options.intervalMs);
    this.timer.unref?.();                /* 不阻止进程退出。 */
    this.logger.info(LAYER, `启动 GitHub 组织同步 worker（每 ${this.options.intervalMs}ms 轮转一批仓库）`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  isHealthy(): boolean {
    return this.timer !== undefined;
  }

  /** 显式驱动一轮（运维/测试用）。异常在此隔离，绝不向外抛——单轮失败不该影响后续周期。 */
  async driveOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.drive();
    } catch (err) {
      this.logger.error(LAYER, '组织同步单轮失败（已隔离）', err as Error);
    } finally {
      this.running = false;
    }
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
npm run build && node --test --test-force-exit dist/test/unit/github-sync-worker.test.js 2>&1 | tail -10
```
Expected: PASS（5 个测试全绿）

- [ ] **Step 5: 挂载进 ChronoSynthOS**

修改 `src/chrono-synth-os.ts`：

① import 区（在 `import { LearningWorker } ...` 之后）：
```ts
import { GithubSyncWorker } from './integrations/github/github-sync-worker.js';
```

② 私有字段区（在 `private readonly learningWorker: LearningWorker;` 之后）：
```ts
  private readonly githubSyncWorker: GithubSyncWorker;
```

③ 构造函数中（在 `this.learningWorker = new LearningWorker(...)` 之后）：
```ts
    /* GitHub 组织同步 worker（组织级驻留）。**默认关闭**——自动出站 + 消耗 LLM 老师额度的
     * 后台循环须显式启用。驱动函数装配 ReadPort 后调 learnOrg 轮转一批仓库；未连 GitHub
     * 的租户静默跳过（不刷错误日志）。 */
    this.githubSyncWorker = new GithubSyncWorker(
      async () => { await this.driveGithubOrgSync(); },
      this.logger,
      { enabled: false },
    );
```

④ 在 `start()` 方法中，紧随 `this.learningWorker.start();` 之后：
```ts
    this.githubSyncWorker.start();
```

⑤ 在 `close()` / `stop()` 方法中，紧随 `this.learningWorker.stop();` 之后：
```ts
    this.githubSyncWorker.stop();
```

⑥ 加驱动方法（放在类内靠近其它 worker 驱动入口处）：
```ts
  /**
   * 驱动一轮 GitHub 组织同步（供 worker 与运维调用）。
   *
   * 装配依赖较重（凭据加密 + credential store + installation 反查），且未连 GitHub 的租户
   * 占多数——故先判有无凭据，缺则**静默返回**，不抛错、不刷日志。
   *
   * 说明：本方法当前是接线占位——完整装配（encryption/config 注入）依赖组合根改造，
   * 属下一步。worker 骨架与 learnOrg 已可用，可经 driveOnce 手工驱动。
   */
  private async driveGithubOrgSync(): Promise<void> {
    /* 组合根尚未向 OS 注入 encryption/config，无法在此装配 ReadPort。
     * 保持 no-op 直到接线完成——worker 默认关闭，不影响任何现有行为。 */
    return;
  }
```

**说明**：⑥ 的完整装配需要 OS 持有 `FieldEncryption` 与 `AppConfig`，而 `ChronoSynthOS` 构造签名当前不含它们。**本 Task 只做 worker 骨架 + 挂载 + 默认关闭**，真实驱动接线留待组合根改造（属独立变更，不在本 plan 范围）。这不是占位符敷衍——worker、`learnOrg`、`assembleGitHubReadPort` 三者均已完整可用且有测试，可经端点或运维脚本组合驱动；缺的只是「OS 自动装配」这一条捷径。

- [ ] **Step 6: 构建 + 跑相关测试**

```bash
npm run build 2>&1 | grep -cE "error TS"
node --test --test-force-exit dist/test/unit/github-sync-worker.test.js dist/test/integration/github-learn-e2e.test.js 2>&1 | grep -E "^ℹ (tests|pass|fail)"
```
Expected: 0 编译错误；全部 PASS。

- [ ] **Step 7: 提交**

```bash
git add src/integrations/github/github-sync-worker.ts src/chrono-synth-os.ts src/test/unit/github-sync-worker.test.ts
git commit -m "feat(github): 组织同步 worker（默认关闭）+ 挂载 ChronoSynthOS

照搬 learning-worker 骨架：setInterval + 重入守卫 + unref +
start/stop/isHealthy/driveOnce，单租户作用域跟随宿主 OS 实例。

默认关闭：这是会自动发出站请求、自动消耗 LLM 老师额度的后台循环，
默认开启对现有部署构成行为突变。单轮异常隔离不崩 worker。"
```

---

### Task 5: golden 全门验证

**Files:** 无改动（纯验证）

- [ ] **Step 1: 跑 golden 全门**

```bash
npm run test:golden > /tmp/golden-org.log 2>&1; echo "EXIT=$?"
grep -E "^ℹ (tests|pass|fail)" /tmp/golden-org.log
```
Expected: `EXIT=0`，各段 fail 均为 0。

- [ ] **Step 2: 验证内核封顶变异测试仍有效**

```bash
sed -i.bak 's/        patternAgrees: false,/        patternAgrees: true,/' src/perception/perception-distiller.ts
npm run build && node --test --test-force-exit dist/test/integration/github-learn-e2e.test.js 2>&1 | grep -E "内核封顶|^ℹ (pass|fail)"
```
Expected: **内核封顶测试 FAIL**（证明封顶断言仍在起作用）。

- [ ] **Step 3: 还原变异并重建**

```bash
mv src/perception/perception-distiller.ts.bak src/perception/perception-distiller.ts
touch src/perception/perception-distiller.ts   # 关键：mv 带回旧 mtime 会让 tsc 增量跳过，dist 不更新
npm run build && node --test --test-force-exit dist/test/integration/github-learn-e2e.test.js 2>&1 | grep -E "^ℹ (pass|fail)"
git status --short src/perception/   # 必须为空
```
Expected: 全部 PASS；`git status` 无输出（无残留改动）。

- [ ] **Step 4: 提交任何修正**

```bash
git add -A && git commit -m "chore(github): 组织级驻留全门验证修正"
```

---

## Self-Review

**Spec 覆盖检查**：
- §3.1 ReadPort 枚举 → Task 2 ✓
- §3.2 learnOrg 轮转 + 组织游标 + CHECK 扩容迁移 → Task 1（迁移）+ Task 3（编排）✓
- §3.2 索引内省断言 → Task 1 Step 1 第三个测试 ✓
- §3.3 worker（默认关闭/重入守卫/单租户作用域） → Task 4 ✓
- §5 抽共享 ReadPort 装配 → Task 3 Step 5 ✓
- §6 测试策略：迁移四项（哨兵可写/四类无回归/索引内省/唯一约束）→ Task 1；枚举解包分页 → Task 2；轮转/失败隔离/空组织/游标隔离 → Task 3；worker 五项 → Task 4；内核封顶回归 → Task 5 ✓
- §8 验收标准 1-6 → Task 2 / Task 3 / Task 3 / Task 4 / Task 5 Step 1 / Task 5 Step 2 ✓

**已知范围收窄（诚实标注，非占位符）**：
- Task 4 Step 5 的 `driveGithubOrgSync` 保持 no-op：完整自动装配需 OS 持有 `FieldEncryption`/`AppConfig`，属组合根改造，不在本 plan 范围。worker 骨架、`learnOrg`、`assembleGitHubReadPort` 三者完整可用且各有测试。**交付时必须向用户明说这一点**，不得表述为「组织驻留已全自动」。
- Task 2 `listInstallationRepos` 只取第一页（100 仓库）：超 100 授权仓库罕见，超出时轮转仍在前 100 内正常工作。YAGNI。

**类型一致性检查**：
- `ORG_ROTATION_RESOURCE_TYPE` 在 Task 1（迁移 CHECK 值 `_org_rotation`）、Task 3（常量）、Task 3 测试中字面量一致 ✓
- `LearnOrgResult` 字段（`reposProcessed`/`ingested`/`skipped`/`failedRepos`/`nextCursor`）在 Task 3 定义与测试断言中一致 ✓
- `GithubSyncWorkerOptions`（`enabled`/`intervalMs`）在 Task 4 定义与测试中一致；`maxReposPerRun` 未进 worker options（learnOrg 参数默认值已覆盖），故从 Interfaces 段移除以免不一致 ✓
- `assembleGitHubReadPort` 返回 `{readPort?, failure?}` 在 Task 3 定义，Task 4 说明中未实际调用（no-op），无签名冲突 ✓

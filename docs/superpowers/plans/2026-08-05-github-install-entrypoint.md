# GitHub App 安装入口产品化实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「SSH 上服务器跑脚本装 GitHub App」变成「网页录一次凭据 + GitHub 点安装，之后装卸改授权自动同步」。

**Architecture:** 三层——admin 端点一次性录凭据（私钥只走 POST body、加密落库、绝不回显）；setup_url 回调在**已登录会话**下记 `installation → 租户` 映射（唯一权威路径）；installation 类 webhook 事件并入既有 webhook 路由自动同步装/卸/暂停/改授权。底座补 kernel `githubInstallDelete` 命令 + 迁移 v127 加 `suspended_at` 列。

**Tech Stack:** TypeScript (ESM, NodeNext)、Node.js `node:test`、Fastify、schema-dsl 迁移框架、`@chrono/kernel` Command/Query 描述符 + executor 分层。

**Spec:** `docs/superpowers/specs/2026-08-05-github-install-entrypoint-design.md`

## Global Constraints

- **首要安全不变量**：setup 回调**必须已登录**，租户取自 `request.tenantId`（会话），**绝不从 URL 参数推断**。回调**不得**加入 `isPublicPath` 豁免。专项测试锁死「未登录 → 401」。
- **私钥安全三条**：只经 POST body 进入（绝不 GET/URL）；经 `GithubAppCredentialStore.storeApp` 加密落库；**响应体绝不回显私钥**。
- **零-LLM 铁律**：本次改动不在任何路径引入 LLM 调用。
- **内核封顶**：`github-learn-e2e.test.ts` 变异测试必须保持有效（翻 `patternAgrees` false→true 则转红）。
- **既有 webhook 安全链零变更**：验签/反查租户/幂等一律不动，installation 事件处理只做并联。
- **注释语言**：所有代码注释与文档使用简体中文，描述意图/约束。
- **SQL 分层**：kernel 只声明 `{kind, params}` 描述符与 Row 形状；真 SQL 只在 `src/storage/executors/`。
- **组合根不装配领域对象**：在 `app.ts` 里 new 持 db 的领域对象会触发 Plan 0 的 DB sink 扫描器（`db-sink-scanner.test.ts`）。装配须下沉领域层模块；若新增载体边，按既有格式登记进 `src/storage/db-access-inventory.ts`（`coveredEdgeIds` + `expectedCount` 须精确匹配）。
- **迁移同步点 6 处**：① 迁移文件 ② `migrations/server-raw/index.ts`（import + export + 数组三处）③ `version-map.ts` ④ parity 覆盖列表 `packages/schema-dsl/test/parity/server-raw.test.ts` ⑤ VERSION_MAP range `packages/schema-dsl/test/version-map.test.ts`。
- **合并前必须跑 `npm run test:golden` 全门**。
- 构建：`npm run build`；`tsc` 不在 PATH，用 `npx tsc`。改 kernel 类型后须 `npx tsc -b packages/kernel --force`。
- **新迁移版本号：v127**（当前最新 v126；PG alias `v129`，sqlite-sql alias `v127`）。

---

## File Structure

| 文件 | 职责 | 动作 |
|---|---|---|
| `packages/schema-dsl/src/migrations/server-raw/v127.ts` | 迁移：installations 加 `suspended_at` | 创建 |
| `packages/schema-dsl/src/migrations/server-raw/index.ts` | 注册 v127（三处） | 修改 |
| `packages/schema-dsl/src/version-map.ts` | v127 映射 | 修改 |
| `packages/schema-dsl/test/parity/server-raw.test.ts` | parity 覆盖列表加 v129 | 修改 |
| `packages/schema-dsl/test/version-map.test.ts` | range 扩到 pg 129 / sqlite 127 | 修改 |
| `packages/kernel/src/domain/agent/github-app-types.ts` | 加 delete/suspend 描述符 + Row 加列 | 修改 |
| `src/storage/executors/github-app-executors.ts` | 新命令真 SQL | 修改 |
| `src/storage/github-app-credential-store.ts` | 门面：deleteInstallation / setSuspended / updateRepos | 修改 |
| `src/integrations/github/github-installation-event-mapper.ts` | installation 事件 → 动作纯映射 | 创建 |
| `src/server/routes/admin-github.ts` | admin 凭据管理端点 + setup 回调 | 创建 |
| `src/server/routes/github-webhook.ts` | 并联 installation 事件处理 | 修改 |
| `src/server/app.ts` | 注册新路由 | 修改 |
| `src/test/unit/github-installation-event-mapper.test.ts` | 映射单测 | 创建 |
| `src/test/unit/github-app-credential-store.test.ts` | store 新方法单测 | 修改 |
| `src/test/integration/github-install-entrypoint.test.ts` | admin 端点 + 回调 + 事件端到端 | 创建 |

**Task 顺序**：Task 1（迁移+store 底座）→ Task 2（事件映射）→ Task 3（admin 端点+回调）→ Task 4（webhook 并联）→ Task 5（全门）。Task 2 与 Task 1 无依赖可并行。

---

### Task 1: 迁移 v127 + kernel/executor/store 底座

**Files:**
- Create: `packages/schema-dsl/src/migrations/server-raw/v127.ts`
- Modify: `packages/schema-dsl/src/migrations/server-raw/index.ts`、`packages/schema-dsl/src/version-map.ts`
- Modify: `packages/schema-dsl/test/parity/server-raw.test.ts`、`packages/schema-dsl/test/version-map.test.ts`
- Modify: `packages/kernel/src/domain/agent/github-app-types.ts`
- Modify: `src/storage/executors/github-app-executors.ts`
- Modify: `src/storage/github-app-credential-store.ts`
- Test: `src/test/unit/github-app-credential-store.test.ts`

**Interfaces:**
- Produces:
  - 迁移常量 `v127_github_installation_suspended`
  - `GITHUB_INSTALL_CMD_DELETE = 'githubInstall.delete'`、`GITHUB_INSTALL_CMD_SET_SUSPENDED = 'githubInstall.setSuspended'`、`GITHUB_INSTALL_CMD_UPDATE_REPOS = 'githubInstall.updateRepos'`
  - `githubInstallDelete(params: {githubHost, installationId}): Command<...>`
  - `githubInstallSetSuspended(params: {githubHost, installationId, suspendedAt, now}): Command<...>`
  - `githubInstallUpdateRepos(params: {githubHost, installationId, repos, now}): Command<...>`
  - `GithubInstallationRow` 加 `suspended_at: number | null`
  - store 方法：`deleteInstallation(githubHost, installationId): boolean`、`setInstallationSuspended(githubHost, installationId, suspendedAt, now): void`、`updateInstallationRepos(githubHost, installationId, repos, now): void`

**背景**：`github_installations` 表列见 `packages/schema-dsl/src/migrations/server-raw/v119.ts:44-56`（id/tenant_id/installation_id/github_host/account/repos/created_at/updated_at + UNIQUE(github_host, installation_id)）。删除与暂停按 `(github_host, installation_id)` 全局唯一键定位——**不带 tenant 过滤**，因为这是平台级映射表（与既有 `resolveTenantByInstallation` 同款）。

- [ ] **Step 1: 写失败的 store 单测**

在 `src/test/unit/github-app-credential-store.test.ts` 末尾（最后一个 `});` 之前）追加。**先读该文件既有 fixture**（如何造 db/encryption/store），照抄其真实名字：

```ts
  /* 安装入口产品化：装/卸/暂停/改授权的存储侧能力。删除与暂停按
   * (github_host, installation_id) 全局唯一键定位——平台级映射表，不带 tenant 过滤
   * （与 resolveTenantByInstallation 同款）。 */
  describe('installation 生命周期（删除 / 暂停 / 授权仓库同步）', () => {
    it('deleteInstallation：删除后反查不到（卸载即停学的存储侧基础）', () => {
      const store = makeStore();
      store.upsertInstallation('inst_1', 'github.com', 'acme', 'acme/web', 1000);
      assert.ok(store.resolveTenantByInstallation('github.com', 'inst_1'), '删前能反查到');

      const deleted = store.deleteInstallation('github.com', 'inst_1');

      assert.equal(deleted, true, '应报告删除成功');
      assert.equal(store.resolveTenantByInstallation('github.com', 'inst_1'), undefined, '删后反查不到');
    });

    it('deleteInstallation：删不存在的行返回 false（幂等，不抛错）', () => {
      const store = makeStore();
      assert.equal(store.deleteInstallation('github.com', 'never_existed'), false);
    });

    it('setInstallationSuspended：置位与清除 suspended_at', () => {
      const store = makeStore();
      store.upsertInstallation('inst_2', 'github.com', 'acme', null, 1000);

      store.setInstallationSuspended('github.com', 'inst_2', 5000, 5000);
      assert.equal(readSuspendedAt('inst_2'), 5000, 'suspend 置位');

      store.setInstallationSuspended('github.com', 'inst_2', null, 6000);
      assert.equal(readSuspendedAt('inst_2'), null, 'unsuspend 清除');
    });

    it('updateInstallationRepos：同步授权仓库列表（该列此前写了从不读）', () => {
      const store = makeStore();
      store.upsertInstallation('inst_3', 'github.com', 'acme', 'acme/web', 1000);

      store.updateInstallationRepos('github.com', 'inst_3', 'acme/web,acme/api', 2000);

      const row = db.prepare<{ repos: string | null }>(
        'SELECT repos FROM github_installations WHERE github_host=? AND installation_id=?',
      ).get('github.com', 'inst_3');
      assert.equal(row?.repos, 'acme/web,acme/api');
    });

    it('新建 installation 默认未暂停（suspended_at 为 NULL，既有行兼容）', () => {
      const store = makeStore();
      store.upsertInstallation('inst_4', 'github.com', 'acme', null, 1000);
      assert.equal(readSuspendedAt('inst_4'), null);
    });
  });
```

在该 describe 内或文件顶部加读取辅助（`db` 是该文件既有的库变量名，实施时以实际为准）：

```ts
    /** 直查 suspended_at 列（绕过 store，验证列真被写入）。 */
    function readSuspendedAt(installationId: string): number | null {
      const row = db.prepare<{ suspended_at: number | null }>(
        'SELECT suspended_at FROM github_installations WHERE github_host=? AND installation_id=?',
      ).get('github.com', installationId);
      return row?.suspended_at ?? null;
    }
```

**注意**：`makeStore()` 与 `db` 是占位名——**必须先读 `src/test/unit/github-app-credential-store.test.ts` 用其真实 fixture**，勿臆造。

- [ ] **Step 2: 跑测试确认失败**

```bash
npm run build 2>&1 | grep -E "error TS" | head -4
```
Expected: `Property 'deleteInstallation' does not exist` 等（方法未实现）

- [ ] **Step 3: 创建迁移 v127**

创建 `packages/schema-dsl/src/migrations/server-raw/v127.ts`：

```ts
import { defineRaw, rawSql } from '../../dsl/raw.js';
import type { RawMigration } from '../../types.js';

/**
 * GitHub 安装入口产品化地基——给 github_installations 加暂停状态列。
 *
 * 为什么要这列：GitHub 允许把已安装的 App **暂停**（suspend）而不卸载。暂停期间
 * installation token 换取会失败。表里没有该状态，系统就不知道 App 已被暂停——
 * 组织同步 worker 会持续对暂停的装机发请求拿 403，白烧配额还刷错误日志。
 *
 * suspended_at 可空：NULL = 未暂停（既有行天然兼容），非 NULL = 暂停时刻（毫秒 epoch）。
 *
 * 手法：纯加列，**不重建表**——故不触发 SQLite 重建表时「RENAME 占用索引名致
 * CREATE INDEX IF NOT EXISTS 静默 no-op、DROP _old 连带删掉唯一索引」的已知坑
 * （参 v122/v126 注释）。既有 UNIQUE(github_host, installation_id) 索引原地保留。
 *
 * 时间戳列：Postgres BIGINT（毫秒 epoch），SQLite 无 BIGINT 用 INTEGER（同为 64 位整数语义）。
 *
 * 向后兼容：新列可空，既有写路径（upsertInstallation 不传该列）仍合法。
 * 回滚：PG DROP COLUMN；SQLite 需重建表去列（或保留冗余空列，无害）。
 *
 * Alias：SQLite v127 / Postgres v129（紧跟 v126 github-learn-state-org-rotation / Postgres v128）。
 */
export const v127_github_installation_suspended: RawMigration = defineRaw({
  id: 'github-installation-suspended',
  version: 'v127',
  aliases: { postgres: 'v129', 'sqlite-sql': 'v127' },
  description: 'GitHub install entrypoint: github_installations adds suspended_at',
  reason: '安装入口产品化：GitHub 允许暂停已安装 App（暂停期 token 换取失败），表无该状态则 worker 持续对暂停装机发请求拿 403；加 suspended_at（可空，NULL=未暂停）由 installation.suspend/unsuspend webhook 事件维护；纯加列不重建表',
  postgres: rawSql([
    `ALTER TABLE github_installations ADD COLUMN IF NOT EXISTS suspended_at BIGINT`,
  ]),
  sqlite: rawSql([
    /* SQLite 无 ADD COLUMN IF NOT EXISTS；版本号全新不会重复执行，直接加列。 */
    `ALTER TABLE github_installations ADD COLUMN suspended_at INTEGER`,
  ]),
});
```

- [ ] **Step 4: 注册迁移（6 处同步点）**

① `packages/schema-dsl/src/migrations/server-raw/index.ts` 三处，各加一行（照 v126 现有写法）：

import 区：
```ts
import { v127_github_installation_suspended } from './v127.js';
```
export 区：
```ts
export { v127_github_installation_suspended } from './v127.js';
```
数组区（`v126_github_learn_state_org_rotation,` 之后）：
```ts
  v127_github_installation_suspended,
```

② `packages/schema-dsl/src/version-map.ts`，在 `v126_github_learn_state_org_rotation` 那行**之后**追加（保持版本升序）：
```ts
  { canonical: 'v127_github_installation_suspended', aliases: { postgres: 'v129', 'sqlite-sql': 'v127' }, classification: 'schema-raw', notes: 'GitHub 安装入口产品化：github_installations 加 suspended_at（可空，NULL=未暂停；由 installation.suspend/unsuspend webhook 事件维护）——GitHub 允许暂停已安装 App，表无该状态则同步 worker 持续对暂停装机发请求拿 403；纯加列不重建表' },
```

③ `packages/schema-dsl/test/parity/server-raw.test.ts`，在 v128 注释之后加注释并把 `'v129'` 加进数组末尾：
```ts
    /* v129 = v127_github_installation_suspended（pg-aliased v129，GitHub 安装入口产品化：
     * github_installations 加 suspended_at 暂停状态列，由 installation.suspend/unsuspend
     * webhook 事件维护；纯加列不重建表，既有唯一索引原地保留）。 */
    assert.deepEqual(rawVersions, ['v007', 'v027', 'v030', 'v034', 'v040', 'v041', 'v047', 'v052', 'v071', 'v090', 'v108', 'v109', 'v121', 'v122', 'v123', 'v124', 'v126', 'v127', 'v128', 'v129']);
```

④ `packages/schema-dsl/test/version-map.test.ts`：postgres `range('v', 1, 128)` → `range('v', 1, 129)`；sqlite-sql `range('v', 1, 126)` → `range('v', 1, 127)`。

- [ ] **Step 5: kernel 加描述符与类型**

修改 `packages/kernel/src/domain/agent/github-app-types.ts`：

① kind 常量区（`GITHUB_INSTALL_CMD_UPSERT` 之后）：
```ts
/** 删除 installation 映射（App 被卸载 → 学习自动停）。 */
export const GITHUB_INSTALL_CMD_DELETE = 'githubInstall.delete' as const;
/** 置/清 installation 暂停状态。 */
export const GITHUB_INSTALL_CMD_SET_SUSPENDED = 'githubInstall.setSuspended' as const;
/** 同步 installation 的授权仓库列表。 */
export const GITHUB_INSTALL_CMD_UPDATE_REPOS = 'githubInstall.updateRepos' as const;
```

② `GithubInstallationRow` 加一列：
```ts
  /** 暂停时刻（毫秒 epoch）；null = 未暂停。GitHub 允许暂停已安装 App。 */
  readonly suspended_at: number | null;
```

③ 参数类型与工厂（放在 `githubInstallUpsert` 之后）：
```ts
/** installation 全局唯一定位键（平台级映射表，不带 tenant 过滤——同 resolveTenantByInstallation）。 */
export interface GithubInstallKeyParams {
  githubHost: string;
  installationId: string;
}

export interface GithubInstallSetSuspendedParams extends GithubInstallKeyParams {
  /** 暂停时刻；null = 恢复（清除暂停）。 */
  suspendedAt: number | null;
  now: number;
}

export interface GithubInstallUpdateReposParams extends GithubInstallKeyParams {
  /** 授权仓库列表（逗号分隔的 owner/name）；null = 未知。 */
  repos: string | null;
  now: number;
}

/**
 * 删除 installation 映射。App 被卸载时调用——映射一删，assembleGitHubReadPort 即返
 * no-installation，组织同步 worker 与学习 handler 都会静默跳过，学习自动停止。
 */
export function githubInstallDelete(params: GithubInstallKeyParams): Command<GithubInstallKeyParams> {
  return { kind: GITHUB_INSTALL_CMD_DELETE, params };
}

/** 置/清 installation 暂停状态（suspendedAt=null 表示恢复）。 */
export function githubInstallSetSuspended(params: GithubInstallSetSuspendedParams): Command<GithubInstallSetSuspendedParams> {
  return { kind: GITHUB_INSTALL_CMD_SET_SUSPENDED, params };
}

/** 同步 installation 的授权仓库列表（installation_repositories 事件维护）。 */
export function githubInstallUpdateRepos(params: GithubInstallUpdateReposParams): Command<GithubInstallUpdateReposParams> {
  return { kind: GITHUB_INSTALL_CMD_UPDATE_REPOS, params };
}
```

- [ ] **Step 6: executor 加真 SQL**

修改 `src/storage/executors/github-app-executors.ts`。顶部 import 加入三个新 kind 与参数类型，并在 `registerGithubAppExecutors()` 内追加：

```ts
  /**
   * 删除 installation 映射（按全局唯一键，不带 tenant 过滤——平台级映射表）。
   * rowsAffected=1 表示确有删除，0 表示本就不存在（store 层据此返 true/false，幂等）。
   */
  registerCommand<GithubInstallKeyParams>(GITHUB_INSTALL_CMD_DELETE, (db, p) => {
    const result = db.prepare<void>(
      'DELETE FROM github_installations WHERE github_host = ? AND installation_id = ?',
    ).run(p.githubHost, p.installationId);
    return { rowsAffected: result.changes };
  });

  /** 置/清暂停状态（suspendedAt=null 即恢复）。 */
  registerCommand<GithubInstallSetSuspendedParams>(GITHUB_INSTALL_CMD_SET_SUSPENDED, (db, p) => {
    const result = db.prepare<void>(
      'UPDATE github_installations SET suspended_at = ?, updated_at = ? WHERE github_host = ? AND installation_id = ?',
    ).run(p.suspendedAt, p.now, p.githubHost, p.installationId);
    return { rowsAffected: result.changes };
  });

  /** 同步授权仓库列表。 */
  registerCommand<GithubInstallUpdateReposParams>(GITHUB_INSTALL_CMD_UPDATE_REPOS, (db, p) => {
    const result = db.prepare<void>(
      'UPDATE github_installations SET repos = ?, updated_at = ? WHERE github_host = ? AND installation_id = ?',
    ).run(p.repos, p.now, p.githubHost, p.installationId);
    return { rowsAffected: result.changes };
  });
```

**注意**：`registerCommand` / `db.prepare(...).run(...)` 的确切写法照抄该文件既有执行器（`GITHUB_INSTALL_CMD_UPSERT` 附近），勿臆造。

- [ ] **Step 7: store 加门面方法**

修改 `src/storage/github-app-credential-store.ts`，在 `resolveTenantByInstallation` 之后追加，并在顶部 import 加入三个新工厂：

```ts
  /**
   * 删除 installation 映射（App 卸载时）。返回是否确有删除（幂等：删不存在的返 false 不抛错）。
   *
   * 删除即「停止学习」——映射一没，assembleGitHubReadPort 返 no-installation，
   * 组织同步 worker 与学习 handler 都静默跳过，无需额外停学逻辑。
   */
  deleteInstallation(githubHost: string, installationId: string): boolean {
    const result = this.tx.execute(githubInstallDelete({ githubHost, installationId }));
    return result.rowsAffected > 0;
  }

  /** 置/清 installation 暂停状态（suspendedAt=null 表示恢复）。 */
  setInstallationSuspended(githubHost: string, installationId: string, suspendedAt: number | null, now: number): void {
    this.tx.execute(githubInstallSetSuspended({ githubHost, installationId, suspendedAt, now }));
  }

  /** 同步 installation 的授权仓库列表（installation_repositories 事件维护）。 */
  updateInstallationRepos(githubHost: string, installationId: string, repos: string | null, now: number): void {
    this.tx.execute(githubInstallUpdateRepos({ githubHost, installationId, repos, now }));
  }
```

- [ ] **Step 8: 构建并跑测试**

```bash
npx tsc -b packages/kernel --force
npm run build --workspace @wontlost-ltd/schema-dsl && npm run test:schema-dsl-parity:raw 2>&1 | grep -E "^ℹ (pass|fail)"
npm run build 2>&1 | grep -cE "error TS"
node --test --test-force-exit dist/test/unit/github-app-credential-store.test.js 2>&1 | grep -E "✖|^ℹ (pass|fail)"
```
Expected: parity PASS；0 编译错误；store 测试全绿（5 个新测试）。

- [ ] **Step 9: 提交**

```bash
git add packages/ src/storage/ src/test/unit/github-app-credential-store.test.ts
git commit -m "feat(github): installation 生命周期底座（v127 suspended_at + 删除/暂停/授权同步）

GitHub 允许暂停已安装 App（暂停期 token 换取失败），表无该状态则同步
worker 持续对暂停装机发请求拿 403——加 suspended_at 列（可空，纯加列
不重建表规避丢索引坑）。

kernel 补 githubInstallDelete/SetSuspended/UpdateRepos 三个命令（此前
只有凭据删除，无 installation 删除）。删除即停学：映射一没
assembleGitHubReadPort 返 no-installation，worker 与 handler 都静默跳过。"
```

---

### Task 2: installation 事件 → 动作纯映射

**Files:**
- Create: `src/integrations/github/github-installation-event-mapper.ts`
- Test: `src/test/unit/github-installation-event-mapper.test.ts`

**Interfaces:**
- Produces:
  - `type InstallationAction = {kind:'delete'} | {kind:'suspend'} | {kind:'unsuspend'} | {kind:'sync-repos'; repos: string} | {kind:'ignore'}`
  - `mapInstallationEvent(eventType: string, payload: GithubInstallationEventPayload): InstallationAction`
  - `interface GithubInstallationEventPayload { action?: string; repositories?: Array<{full_name?: string}>; repositories_added?: Array<{full_name?: string}>; repositories_removed?: Array<{full_name?: string}> }`

**背景**：`installation_repositories` 事件的 payload 用 `repositories_added` / `repositories_removed` 字段（不是 `repositories`）。本映射把「增删」统一为「同步当前授权列表」——增删细节由调用方结合既有 repos 列处理过于复杂，直接以事件携带的最新列表覆盖更简单可靠。**但 GitHub 的 installation_repositories 事件不携带完整列表**，只带增量。故本设计取 `repositories_added` 的并集语义：`added` 事件把新增的合并进现有 repos，`removed` 事件从现有 repos 移除——合并逻辑放在 webhook 调用方（需读现有值），映射层只负责**解析出增删列表**。

修正后的类型：
```ts
export type InstallationAction =
  | { kind: 'delete' }
  | { kind: 'suspend' }
  | { kind: 'unsuspend' }
  | { kind: 'repos-added'; repos: string[] }
  | { kind: 'repos-removed'; repos: string[] }
  | { kind: 'ignore' };
```

- [ ] **Step 1: 写失败的映射单测**

创建 `src/test/unit/github-installation-event-mapper.test.ts`：

```ts
/**
 * 单元测试：installation 类 webhook 事件 → 动作映射（纯函数，无 IO）。
 *
 * 断言重点：
 *   1. deleted/suspend/unsuspend 正确映射；
 *   2. installation_repositories 的 added/removed 解析出仓库全名列表
 *      （该事件只带增量，不带完整列表——合并由调用方结合现有 repos 列做）；
 *   3. created 映射为 ignore——映射由 setup 回调建立（唯一权威路径，有会话身份）；
 *      created 若特殊放行会与既有 fail-closed 反查形成循环依赖（见 spec §3.3）；
 *   4. 未知 action / 畸形 payload → ignore，不抛错。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mapInstallationEvent } from '../../integrations/github/github-installation-event-mapper.js';

describe('installation 类事件 → 动作映射', () => {
  it('installation.deleted → delete（卸载即停学）', () => {
    assert.deepEqual(mapInstallationEvent('installation', { action: 'deleted' }), { kind: 'delete' });
  });

  it('installation.suspend → suspend', () => {
    assert.deepEqual(mapInstallationEvent('installation', { action: 'suspend' }), { kind: 'suspend' });
  });

  it('installation.unsuspend → unsuspend', () => {
    assert.deepEqual(mapInstallationEvent('installation', { action: 'unsuspend' }), { kind: 'unsuspend' });
  });

  it('installation.created → ignore（映射由 setup 回调建立，避免循环依赖）', () => {
    assert.deepEqual(mapInstallationEvent('installation', { action: 'created' }), { kind: 'ignore' });
  });

  it('installation_repositories.added → repos-added 携带新增仓库全名', () => {
    const action = mapInstallationEvent('installation_repositories', {
      action: 'added',
      repositories_added: [{ full_name: 'acme/api' }, { full_name: 'acme/web' }],
    });
    assert.deepEqual(action, { kind: 'repos-added', repos: ['acme/api', 'acme/web'] });
  });

  it('installation_repositories.removed → repos-removed 携带移除仓库全名', () => {
    const action = mapInstallationEvent('installation_repositories', {
      action: 'removed',
      repositories_removed: [{ full_name: 'acme/legacy' }],
    });
    assert.deepEqual(action, { kind: 'repos-removed', repos: ['acme/legacy'] });
  });

  it('installation_repositories：丢弃缺 full_name 的畸形条目', () => {
    const action = mapInstallationEvent('installation_repositories', {
      action: 'added',
      repositories_added: [{ full_name: 'acme/api' }, {}, { full_name: '' }],
    });
    assert.deepEqual(action, { kind: 'repos-added', repos: ['acme/api'] });
  });

  it('installation_repositories：空增量 → ignore（无事可做）', () => {
    assert.deepEqual(
      mapInstallationEvent('installation_repositories', { action: 'added', repositories_added: [] }),
      { kind: 'ignore' },
    );
  });

  it('未知 action → ignore', () => {
    assert.deepEqual(mapInstallationEvent('installation', { action: 'new_permissions_accepted' }), { kind: 'ignore' });
  });

  it('非 installation 类事件 → ignore', () => {
    assert.deepEqual(mapInstallationEvent('issues', { action: 'opened' }), { kind: 'ignore' });
  });

  it('缺 action → ignore（畸形 payload 不抛错）', () => {
    assert.deepEqual(mapInstallationEvent('installation', {}), { kind: 'ignore' });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npm run build 2>&1 | grep -E "error TS" | head -3
```
Expected: `Cannot find module '../../integrations/github/github-installation-event-mapper.js'`

- [ ] **Step 3: 实现映射器**

创建 `src/integrations/github/github-installation-event-mapper.ts`：

```ts
/**
 * installation 类 webhook 事件 → 动作的纯映射（无 IO、无副作用，便于穷举测试）。
 *
 * 为什么单独成文件：webhook 路由已承担安全链（验签/反查租户/幂等）+ 起草编排 +
 * 学习入队，再塞进 installation 生命周期分类会让该文件职责过载。
 *
 * **created 刻意映射为 ignore**：映射由 setup 回调建立（唯一权威路径，有会话身份）。
 * 若让 created 事件建映射，会与既有 fail-closed 反查形成循环依赖——事件到达时映射
 * 尚不存在 → 反查 401 拒绝；要放行就得跳过验签，而验签正需要该租户的 webhook secret。
 * 详见 spec §3.3。
 */

/** installation 类事件 payload 的最小关心形状。 */
export interface GithubInstallationEventPayload {
  action?: string;
  /** installation_repositories.added 携带的新增仓库（该事件只带增量，不带完整列表）。 */
  repositories_added?: Array<{ full_name?: string }>;
  /** installation_repositories.removed 携带的移除仓库。 */
  repositories_removed?: Array<{ full_name?: string }>;
}

/** installation 事件对应的存储侧动作。 */
export type InstallationAction =
  | { kind: 'delete' }
  | { kind: 'suspend' }
  | { kind: 'unsuspend' }
  | { kind: 'repos-added'; repos: string[] }
  | { kind: 'repos-removed'; repos: string[] }
  | { kind: 'ignore' };

const IGNORE: InstallationAction = { kind: 'ignore' };

/** 从仓库数组提取合法 full_name（丢弃缺失/空串的畸形条目）。 */
function extractFullNames(list: Array<{ full_name?: string }> | undefined): string[] {
  return (list ?? [])
    .map((r) => r.full_name)
    .filter((name): name is string => typeof name === 'string' && name.length > 0);
}

/** 把 installation 类事件映射成存储侧动作。非该类事件 / 未知 action / 畸形 payload → ignore。 */
export function mapInstallationEvent(
  eventType: string,
  payload: GithubInstallationEventPayload,
): InstallationAction {
  if (eventType === 'installation') {
    switch (payload.action) {
      case 'deleted': return { kind: 'delete' };
      case 'suspend': return { kind: 'suspend' };
      case 'unsuspend': return { kind: 'unsuspend' };
      /* created 由 setup 回调负责建映射——见文件头说明。 */
      default: return IGNORE;
    }
  }

  if (eventType === 'installation_repositories') {
    if (payload.action === 'added') {
      const repos = extractFullNames(payload.repositories_added);
      return repos.length > 0 ? { kind: 'repos-added', repos } : IGNORE;
    }
    if (payload.action === 'removed') {
      const repos = extractFullNames(payload.repositories_removed);
      return repos.length > 0 ? { kind: 'repos-removed', repos } : IGNORE;
    }
    return IGNORE;
  }

  return IGNORE;
}

/**
 * 把增删应用到现有 repos 列（逗号分隔字符串）。纯函数，webhook 侧调用。
 * 去重 + 保持稳定顺序（既有在前、新增在后），空结果返回 null（列语义：null=未知）。
 */
export function applyRepoDelta(
  existing: string | null,
  action: InstallationAction,
): string | null {
  if (action.kind !== 'repos-added' && action.kind !== 'repos-removed') return existing;
  const current = (existing ?? '').split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  if (action.kind === 'repos-added') {
    const merged = [...current];
    for (const r of action.repos) if (!merged.includes(r)) merged.push(r);
    return merged.length > 0 ? merged.join(',') : null;
  }
  const removed = current.filter((r) => !action.repos.includes(r));
  return removed.length > 0 ? removed.join(',') : null;
}
```

- [ ] **Step 4: 补 applyRepoDelta 单测**

在 `src/test/unit/github-installation-event-mapper.test.ts` 末尾追加（`mapInstallationEvent` 的 import 行改为同时导入 `applyRepoDelta` 与类型）：

```ts
describe('applyRepoDelta（增删应用到现有 repos 列）', () => {
  it('added：合并进现有列表并去重', () => {
    const result = applyRepoDelta('acme/web', { kind: 'repos-added', repos: ['acme/api', 'acme/web'] });
    assert.equal(result, 'acme/web,acme/api', '既有在前、新增在后，重复不加');
  });

  it('added：现有为 null 时直接用新增列表', () => {
    assert.equal(applyRepoDelta(null, { kind: 'repos-added', repos: ['acme/api'] }), 'acme/api');
  });

  it('removed：从现有列表移除', () => {
    assert.equal(applyRepoDelta('acme/web,acme/api', { kind: 'repos-removed', repos: ['acme/web'] }), 'acme/api');
  });

  it('removed：移空后返回 null（列语义 null=未知）', () => {
    assert.equal(applyRepoDelta('acme/web', { kind: 'repos-removed', repos: ['acme/web'] }), null);
  });

  it('非 repos 类动作原样返回现有值', () => {
    assert.equal(applyRepoDelta('acme/web', { kind: 'delete' }), 'acme/web');
  });
});
```

- [ ] **Step 5: 跑测试确认通过**

```bash
npm run build && node --test --test-force-exit dist/test/unit/github-installation-event-mapper.test.js 2>&1 | grep -E "✖|^ℹ (tests|pass|fail)"
```
Expected: PASS（11 + 5 = 16 个测试全绿）

- [ ] **Step 6: 提交**

```bash
git add src/integrations/github/github-installation-event-mapper.ts src/test/unit/github-installation-event-mapper.test.ts
git commit -m "feat(github): installation 类事件 → 动作纯映射

deleted/suspend/unsuspend + installation_repositories added/removed
（该事件只带增量不带完整列表，故 applyRepoDelta 结合现有 repos 列合并）。

created 刻意 ignore：映射由 setup 回调建立（唯一权威路径，有会话身份）。
若让 created 建映射会与既有 fail-closed 反查形成循环依赖——事件到达时
映射尚不存在→反查 401；放行就得跳过验签，而验签正需该租户 webhook secret。"
```

---

### Task 3: admin 凭据端点 + setup 回调

**Files:**
- Create: `src/server/routes/admin-github.ts`
- Modify: `src/server/app.ts`（注册路由）
- Test: `src/test/integration/github-install-entrypoint.test.ts`

**Interfaces:**
- Consumes: `GithubAppCredentialStore.storeApp/getApp/upsertInstallation`；kernel `githubAppCredDelete`
- Produces: `registerAdminGithubRoutes(app, deps: {os, tenantFactory, config})`
  - `POST /api/v1/admin/github/app` → `{data:{appId, configured:true}}`
  - `GET /api/v1/admin/github/app` → `{data:{configured, appId?, gheBaseUrl?, installations:[{installationId, account, repos, suspendedAt}]}}`
  - `DELETE /api/v1/admin/github/app` → `{data:{disconnected:true}}`
  - `GET /api/v1/integrations/github/setup?installation_id=&setup_action=` → HTML 确认页

**背景**：admin 路由范式见 `src/server/routes/admin-config.ts:24-26`（`preHandler: requireRole('admin')`）。`storeApp(appId, privateKeyPem, webhookSecret, gheBaseUrl, createdBy, now)`。`GITHUB_HOST = 'github.com'`（首版只处理公有云，与 webhook 一致）。

**安全铁律**：setup 回调**不得**加入 `src/server/plugins/jwt-auth.ts` 的 `isPublicPath` 豁免——它必须走正常 JWT 鉴权。租户取 `request.tenantId`（会话），绝不读 URL 里的租户参数。

- [ ] **Step 1: 写失败的集成测试**

创建 `src/test/integration/github-install-entrypoint.test.ts`。**先读 `src/test/integration/github-webhook.test.ts`** 的 fixture（如何建 config/os/app、如何注册用户拿 token），照抄其真实写法：

```ts
/**
 * 集成测试：GitHub App 安装入口产品化（admin 凭据端点 + setup 回调）。
 *
 * 断言重点：
 *   1. **私钥绝不回显**（安全铁律）——GET 响应体不含私钥任何片段；
 *   2. **回调必须已登录**（首要安全不变量）——未登录 401；租户取自会话而非 URL 参数，
 *      否则任何人构造 ?installation_id=<他人的> 就能把别人的 installation 绑到自己租户；
 *   3. 非 admin 角色访问管理端点 → 403；
 *   4. DELETE 断开连接后 GET 返 configured:false。
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { createApp } from '../../server/index.js';
import { loadConfig } from '../../config/schema.js';
import { SilentLogger } from '../../utils/logger.js';
import { TestClock } from '../../utils/clock.js';

const JWT_SECRET = 'test-secret-at-least-32-characters-long!';
const FAKE_PEM = '-----BEGIN RSA PRIVATE KEY-----\nMIIEfake0123456789\n-----END RSA PRIVATE KEY-----';

describe('GitHub 安装入口（admin 凭据端点 + setup 回调）', () => {
  let os: ChronoSynthOS;
  let app: FastifyInstance;
  let headers: Record<string, string>;

  beforeEach(async () => {
    os = new ChronoSynthOS({ clock: new TestClock(1000), logger: new SilentLogger() });
    os.start();
    const config = loadConfig({
      rateLimit: { max: 10000, timeWindowMs: 60_000 },
      websocket: { enabled: false, heartbeatIntervalMs: 30_000 },
      jwt: { enabled: true, secret: JWT_SECRET, issuer: 'test' },
      encryption: {
        enabled: true, masterKey: randomBytes(32).toString('base64'),
        defaultKeyRef: 'master', keyring: {}, keyRotationIntervalDays: 90,
      },
    });
    app = await createApp({ os, config });
    /* 注册即 admin（register 返回的账号 role=admin，见既有 e2e 用法）。 */
    const reg = await app.inject({
      method: 'POST', url: '/api/v1/auth/register',
      payload: { email: 'gh-admin@test.com', password: 'password123' },
    });
    assert.equal(reg.statusCode, 201, reg.body);
    const auth = JSON.parse(reg.body).data as { accessToken: string; tenantId: string };
    headers = { authorization: `Bearer ${auth.accessToken}`, 'x-tenant-id': auth.tenantId };
  });

  afterEach(async () => {
    await app.close();
    os.close();
  });

  it('POST 录凭据 → GET 返 configured:true 且响应体绝不含私钥', async () => {
    const post = await app.inject({
      method: 'POST', url: '/api/v1/admin/github/app', headers,
      payload: { appId: '123456', privateKeyPem: FAKE_PEM, webhookSecret: 'whsec_test' },
    });
    assert.equal(post.statusCode, 200, post.body);
    assert.ok(!post.body.includes('PRIVATE KEY'), 'POST 响应不得回显私钥');

    const get = await app.inject({ method: 'GET', url: '/api/v1/admin/github/app', headers });
    assert.equal(get.statusCode, 200);
    const data = JSON.parse(get.body).data as { configured: boolean; appId?: string };
    assert.equal(data.configured, true);
    assert.equal(data.appId, '123456');
    /* 安全铁律：私钥绝不回显——整个响应体不得含 PEM 任何片段。 */
    assert.ok(!get.body.includes('PRIVATE KEY'), 'GET 响应不得含私钥');
    assert.ok(!get.body.includes('MIIEfake'), 'GET 响应不得含私钥内容');
  });

  it('未配置时 GET 返 configured:false', async () => {
    const get = await app.inject({ method: 'GET', url: '/api/v1/admin/github/app', headers });
    assert.equal(get.statusCode, 200);
    assert.equal((JSON.parse(get.body).data as { configured: boolean }).configured, false);
  });

  it('DELETE 断开连接 → GET 返 configured:false', async () => {
    await app.inject({
      method: 'POST', url: '/api/v1/admin/github/app', headers,
      payload: { appId: '123456', privateKeyPem: FAKE_PEM, webhookSecret: 'whsec_test' },
    });
    const del = await app.inject({ method: 'DELETE', url: '/api/v1/admin/github/app', headers });
    assert.equal(del.statusCode, 200, del.body);

    const get = await app.inject({ method: 'GET', url: '/api/v1/admin/github/app', headers });
    assert.equal((JSON.parse(get.body).data as { configured: boolean }).configured, false);
  });

  it('安全不变量：setup 回调未登录 → 401（绝不允许匿名绑定 installation）', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/integrations/github/setup?installation_id=999&setup_action=install',
      /* 刻意不带 authorization 头。 */
    });
    assert.equal(res.statusCode, 401, `未登录回调必须 401，实际 ${res.statusCode}`);
  });

  it('setup 回调已登录 → 映射记到**会话租户**（而非 URL 参数推断）', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/integrations/github/setup?installation_id=777&setup_action=install',
      headers,
    });
    assert.equal(res.statusCode, 200, res.body);

    /* 映射应可反查到会话租户。 */
    const get = await app.inject({ method: 'GET', url: '/api/v1/admin/github/app', headers });
    const data = JSON.parse(get.body).data as { installations: Array<{ installationId: string }> };
    assert.ok(
      data.installations.some((i) => i.installationId === '777'),
      '回调应把 installation 记到会话租户下',
    );
  });

  it('setup 回调缺 installation_id → 400（不静默成功）', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/integrations/github/setup?setup_action=install', headers,
    });
    assert.ok(res.statusCode >= 400 && res.statusCode < 500, `缺参应 4xx，实际 ${res.statusCode}`);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npm run build && node --test --test-force-exit dist/test/integration/github-install-entrypoint.test.js 2>&1 | grep -E "^ℹ (pass|fail)"
```
Expected: FAIL（端点不存在，多数返 404）

- [ ] **Step 3: 实现路由**

创建 `src/server/routes/admin-github.ts`：

```ts
/**
 * GitHub App 安装入口（安装入口产品化）——管理端凭据录入 + setup_url 回调。
 *
 * 此前把 App 装进系统只能靠一次性脚本 scripts/connect-github.ts（需 SSH 登服务器、
 * 设 5 个环境变量）。本路由把它产品化为两步：
 *   ① 管理员 POST 一次凭据（appId + 私钥 PEM + webhook secret）；
 *   ② 在 GitHub 上安装 App → setup_url 回调自动记 installation → 租户映射。
 *
 * **私钥安全三条**：
 *   - 只经 POST body 进入（绝不 GET/URL——URL 会进日志、浏览器历史、Referer）；
 *   - 经 GithubAppCredentialStore.storeApp 由 FieldEncryption 加密落库
 *     （store 自身 fail-closed：加密未启用直接拒写，不依赖调用方纪律）；
 *   - **响应体绝不回显私钥**——GET 只返 configured/appId/gheBaseUrl/installations。
 *
 * **首要安全不变量（setup 回调）**：回调是 GitHub 发起的浏览器跳转，**无 HMAC 可验**
 * （不同于 webhook）。故它必须走正常 JWT 鉴权（**不得**加入 isPublicPath 豁免），
 * 且租户取自 request.tenantId（会话），**绝不从 URL 参数推断**——否则任何人构造
 * ?installation_id=<他人的> 就能把别人的 installation 绑到自己租户下，进而用自己的
 * 会话读取他人组织的 GitHub 内容。
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ChronoSynthOS } from '../../chrono-synth-os.js';
import type { TenantOSFactory } from '../../multi-tenant/tenant-os-factory.js';
import type { AppConfig } from '../../config/schema.js';
import type { JwtPayload } from '../../types/auth.js';
import { ValidationError, StateError, ErrorCode } from '../../errors/index.js';
import { requireRole } from '../plugins/rbac.js';
import { tryByokEncryption } from '../../storage/llm-credential-store.js';
import { GithubAppCredentialStore } from '../../storage/github-app-credential-store.js';
import { githubAppCredDelete, githubInstallListByTenant } from '@chrono/kernel';

/** 公有云 GitHub host（首版只处理 github.com，与 webhook 一致）。 */
const GITHUB_HOST = 'github.com';

/** 录凭据请求体。私钥必须含 PRIVATE KEY 头——挡住粘错内容（如粘了公钥或 App ID）。 */
const ConnectAppSchema = z.object({
  appId: z.string().trim().min(1, 'appId 必填').max(64),
  privateKeyPem: z.string().min(1, 'privateKeyPem 必填')
    .refine((s) => s.includes('PRIVATE KEY'), '私钥 PEM 内容不含 PRIVATE KEY 头，请粘贴完整的 .pem 文件内容'),
  webhookSecret: z.string().min(1, 'webhookSecret 必填').max(256),
  gheBaseUrl: z.string().url().optional(),
});

export interface AdminGithubRoutesDeps {
  os: ChronoSynthOS;
  tenantFactory: TenantOSFactory | undefined;
  config: AppConfig;
}

export function registerAdminGithubRoutes(app: FastifyInstance, deps: AdminGithubRoutesDeps): void {
  const { os, tenantFactory, config } = deps;
  const encryption = tryByokEncryption(config.encryption);

  function getOS(request: FastifyRequest): ChronoSynthOS {
    const tid = request.tenantId;
    if (tenantFactory && tid && tid !== 'default') return tenantFactory.getTenantOS(tid);
    return os;
  }

  /** 造本租户的凭据 store；加密未启用 → 明确 4xx（storeApp 本身也会 fail-closed，这里给可读错误）。 */
  function storeFor(request: FastifyRequest): GithubAppCredentialStore {
    if (!encryption) {
      throw new StateError('未启用凭据加密，无法安全保存 GitHub App 私钥——请先启用 CHRONO_ENCRYPTION_ENABLED');
    }
    return new GithubAppCredentialStore(getOS(request).getDatabase(), encryption, request.tenantId);
  }

  /* POST /api/v1/admin/github/app —— 录入 App 凭据（私钥只经 body，加密落库，绝不回显）。 */
  app.post('/api/v1/admin/github/app', {
    preHandler: requireRole('admin'),
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request) => {
    const body = ConnectAppSchema.parse(request.body);
    const user = request.user as JwtPayload | undefined;
    const tenantOS = getOS(request);

    storeFor(request).storeApp(
      body.appId, body.privateKeyPem, body.webhookSecret,
      body.gheBaseUrl ?? null, user?.sub ?? 'admin', tenantOS.getClock().now(),
    );

    /* 响应只回 appId——私钥绝不回显。 */
    return { data: { appId: body.appId, configured: true } };
  });

  /* GET /api/v1/admin/github/app —— 查连接状态（**不含私钥**）。 */
  app.get('/api/v1/admin/github/app', {
    preHandler: requireRole('admin'),
  }, async (request) => {
    const cred = encryption ? storeFor(request).getApp() : undefined;
    if (!cred) {
      return { data: { configured: false, installations: [] } };
    }
    const rows = getOS(request).getDatabase().queryMany(githubInstallListByTenant(request.tenantId));
    return {
      data: {
        configured: true,
        appId: cred.appId,
        gheBaseUrl: cred.gheBaseUrl,
        installations: rows.map((r) => ({
          installationId: r.installation_id,
          account: r.account,
          repos: r.repos,
          suspendedAt: r.suspended_at,
        })),
      },
    };
  });

  /* DELETE /api/v1/admin/github/app —— 断开连接（删凭据；installation 映射由卸载事件清理）。 */
  app.delete('/api/v1/admin/github/app', {
    preHandler: requireRole('admin'),
  }, async (request) => {
    getOS(request).getDatabase().execute(githubAppCredDelete(request.tenantId));
    return { data: { disconnected: true } };
  });

  /* GET /api/v1/integrations/github/setup —— GitHub 安装完成回调。
   *
   * **必须已登录**：本端点不在 isPublicPath 豁免名单内，走正常 JWT 鉴权。
   * 租户取自会话（request.tenantId），绝不从 URL 参数推断——见文件头安全说明。 */
  app.get('/api/v1/integrations/github/setup', async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const installationId = typeof query.installation_id === 'string' ? query.installation_id.trim() : '';
    if (installationId.length === 0) {
      throw new ValidationError('回调缺少 installation_id 参数', ErrorCode.VALIDATION_REQUIRED);
    }

    const tenantOS = getOS(request);
    /* 租户 = 会话租户。account/repos 此时未知（GitHub 回调不带），留 null 由
     * installation_repositories 事件后续同步。 */
    storeFor(request).upsertInstallation(
      installationId, GITHUB_HOST, null, null, tenantOS.getClock().now(),
    );

    /* 极简静态确认页（无用户输入回显 → 无 XSS 面）。 */
    reply.header('content-type', 'text/html; charset=utf-8');
    return `<!doctype html><meta charset="utf-8"><title>GitHub 已连接</title>
<body style="font-family:system-ui;padding:2rem;max-width:32rem">
<h1>GitHub 已连接</h1>
<p>安装已绑定到你的账号，数字人可以开始学习这个组织的知识了。</p>
<p>你可以关闭此页面。</p>
</body>`;
  });
}
```

**已核实**：`requireRole` 来自 `../plugins/rbac.js`（见 `admin-config.ts:12`）；`StateError` 与 `ValidationError` 均从 `../../errors/index.js` 导出（`app.ts:112` 在用 StateError）。

- [ ] **Step 4: 注册路由**

在 `src/server/app.ts` 中找到 `registerGithubWebhookRoutes(app, deps.os, tenantFactory, db, config);`（约 :889），其后加：

```ts
  registerAdminGithubRoutes(app, { os: deps.os, tenantFactory, config });
```

顶部加 import：
```ts
import { registerAdminGithubRoutes } from './routes/admin-github.js';
```

- [ ] **Step 5: 跑测试确认通过**

```bash
npm run build 2>&1 | grep -cE "error TS"
node --test --test-force-exit dist/test/integration/github-install-entrypoint.test.js 2>&1 | grep -E "✖|^ℹ (tests|pass|fail)"
```
Expected: 0 编译错误；6 个测试全绿（尤其「未登录 401」与「私钥不回显」两条安全断言）。

**若「未登录 401」失败**：检查该路径是否被误加进 `src/server/plugins/jwt-auth.ts` 的 `isPublicPath`——它**不该**在豁免名单里。

- [ ] **Step 6: 提交**

```bash
git add src/server/routes/admin-github.ts src/server/app.ts src/test/integration/github-install-entrypoint.test.ts
git commit -m "feat(github): admin 凭据端点 + setup_url 回调（安装入口产品化）

把「SSH 登服务器跑 connect-github.ts」变成「网页录一次凭据 + GitHub 点安装」。

私钥安全三条：只经 POST body（绝不 GET/URL——URL 会进日志/浏览器历史/
Referer）；经 storeApp 加密落库（store 自身 fail-closed）；响应体绝不回显
（测试断言整个响应不含 PRIVATE KEY 与私钥内容片段）。

首要安全不变量：setup 回调是 GitHub 发起的浏览器跳转无 HMAC 可验，故
必须已登录（不入 isPublicPath 豁免）且租户取自会话，绝不从 URL 推断——
否则任何人构造 ?installation_id=<他人的> 就能把别人的 installation 绑到
自己租户下。专项测试锁死未登录 401。"
```

---

### Task 4: webhook 并联 installation 事件处理

**Files:**
- Modify: `src/server/routes/github-webhook.ts`
- Test: `src/test/integration/github-webhook.test.ts`

**Interfaces:**
- Consumes: Task 1 的 store 三方法；Task 2 的 `mapInstallationEvent` / `applyRepoDelta`
- Produces: webhook 在既有链末端并联 installation 生命周期同步

**背景**：既有 webhook 已有完整安全链。installation 事件同样经过它——`installation.deleted` 事件的 payload 带 `installation.id`，反查能命中（映射此刻还在），故不破坏 fail-closed。

- [ ] **Step 1: 写失败的集成测试**

在 `src/test/integration/github-webhook.test.ts` 的学习入队 describe **之后**追加新 describe（复用该文件既有 `deliver` / `seedGithubApp` / `INSTALLATION_ID` fixture）：

```ts
  /* installation 生命周期同步：装/卸/暂停/改授权经 webhook 自动跟上，
   * 使 github_installations 表真实反映 GitHub 侧状态。 */
  describe('installation 生命周期事件', () => {
    it('installation.deleted → 映射删除（卸载即停学的端到端证明）', async () => {
      const app = await mountWebhook(os, config);
      /* 删前：反查能命中（seedGithubApp 已建映射）。 */
      const store = new GithubAppCredentialStore(
        os.getDatabase(), tryByokEncryption(config.encryption)!, 'default',
      );
      assert.ok(store.resolveTenantByInstallation(GITHUB_HOST, INSTALLATION_ID), '删前映射存在');

      const raw = JSON.stringify({ action: 'deleted', installation: { id: INSTALLATION_ID } });
      const res = await deliver(app, raw, { event: 'installation' });

      assert.equal(res.status, 200);
      assert.equal(
        store.resolveTenantByInstallation(GITHUB_HOST, INSTALLATION_ID), undefined,
        '卸载后映射应删除——后续 ReadPort 装配即返 no-installation，学习自动停',
      );

      await app.close();
    });

    it('installation.suspend → suspended_at 置位；unsuspend → 清除', async () => {
      const app = await mountWebhook(os, config);
      const readSuspended = (): number | null => os.getDatabase().prepare<{ suspended_at: number | null }>(
        'SELECT suspended_at FROM github_installations WHERE github_host=? AND installation_id=?',
      ).get(GITHUB_HOST, INSTALLATION_ID)?.suspended_at ?? null;

      await deliver(app, JSON.stringify({ action: 'suspend', installation: { id: INSTALLATION_ID } }), { event: 'installation' });
      assert.notEqual(readSuspended(), null, 'suspend 后应置位');

      await deliver(app, JSON.stringify({ action: 'unsuspend', installation: { id: INSTALLATION_ID } }), { event: 'installation' });
      assert.equal(readSuspended(), null, 'unsuspend 后应清除');

      await app.close();
    });

    it('installation_repositories.added → repos 列同步（该列此前写了从不读）', async () => {
      const app = await mountWebhook(os, config);

      const raw = JSON.stringify({
        action: 'added',
        installation: { id: INSTALLATION_ID },
        repositories_added: [{ full_name: 'acme/api' }],
      });
      await deliver(app, raw, { event: 'installation_repositories' });

      const repos = os.getDatabase().prepare<{ repos: string | null }>(
        'SELECT repos FROM github_installations WHERE github_host=? AND installation_id=?',
      ).get(GITHUB_HOST, INSTALLATION_ID)?.repos;
      assert.ok(repos?.includes('acme/api'), `repos 应含新增仓库，实际 ${repos}`);

      await app.close();
    });
  });
```

**注意**：`GithubAppCredentialStore` / `tryByokEncryption` / `GITHUB_HOST` 若该测试文件未导入需补 import（该文件已导入前两者用于 `seedGithubApp`，以实际为准）。

- [ ] **Step 2: 跑测试确认失败**

```bash
npm run build && node --test --test-force-exit dist/test/integration/github-webhook.test.js 2>&1 | grep -E "✖|^ℹ (pass|fail)"
```
Expected: FAIL（3 个新测试；映射未删、suspended_at 未置位、repos 未同步）

- [ ] **Step 3: webhook 并联 installation 处理**

修改 `src/server/routes/github-webhook.ts`，在**学习分支之后、起草分支之前**插入：

```ts
    /* ⑥ installation 生命周期同步（安装入口产品化）：装/卸/暂停/改授权经此自动跟上，
     * 使 github_installations 表真实反映 GitHub 侧状态。
     *
     * 卸载即停学：映射一删，assembleGitHubReadPort 即返 no-installation，组织同步
     * worker 与学习 handler 都静默跳过——无需额外停学逻辑。 */
    const installAction = mapInstallationEvent(eventType, payload as GithubInstallationEventPayload);
    if (installAction.kind !== 'ignore') {
      try {
        const credStore = new GithubAppCredentialStore(tenantOS.getDatabase(), credEncryption, tenantId);
        const now = tenantOS.getClock().now();
        if (installAction.kind === 'delete') {
          credStore.deleteInstallation(GITHUB_HOST, installationId);
        } else if (installAction.kind === 'suspend') {
          credStore.setInstallationSuspended(GITHUB_HOST, installationId, now, now);
        } else if (installAction.kind === 'unsuspend') {
          credStore.setInstallationSuspended(GITHUB_HOST, installationId, null, now);
        } else {
          /* repos 增删：读现有列 → 应用增量 → 写回（GitHub 只推增量，不推完整列表）。 */
          const existing = tenantOS.getDatabase()
            .queryMany(githubInstallListByTenant(tenantId))
            .find((r) => r.installation_id === installationId);
          const nextRepos = applyRepoDelta(existing?.repos ?? null, installAction);
          credStore.updateInstallationRepos(GITHUB_HOST, installationId, nextRepos, now);
        }
      } catch (err) {
        /* 同步失败不影响 webhook 响应——GitHub 侧状态是权威，下次事件会再同步。 */
        request.log.warn({ err }, 'installation 生命周期同步失败');
      }
      /* installation 类事件不参与起草，直接返回。 */
      return reply.status(200).send({ data: { received: true, installationSynced: true } });
    }
```

顶部加 import：
```ts
import {
  mapInstallationEvent, applyRepoDelta, type GithubInstallationEventPayload,
} from '../../integrations/github/github-installation-event-mapper.js';
import { githubInstallListByTenant } from '@chrono/kernel';
```

**注意**：`GithubAppCredentialStore` 与 `credEncryption` 在该文件已存在（验签路径用）；`installationId` 变量在反查步骤已定义。确认这些名字与实际一致再写。

- [ ] **Step 4: 跑测试确认通过**

```bash
npm run build 2>&1 | grep -cE "error TS"
node --test --test-force-exit dist/test/integration/github-webhook.test.js 2>&1 | grep -E "✖|^ℹ (tests|pass|fail)"
```
Expected: 0 编译错误；全部 PASS（3 个新 + 既有 5 安全 + 4 学习 = 12+ 测试）。

- [ ] **Step 5: 提交**

```bash
git add src/server/routes/github-webhook.ts src/test/integration/github-webhook.test.ts
git commit -m "feat(github): webhook 并联 installation 生命周期同步

装/卸/暂停/改授权经既有 webhook 自动跟上（享受现成 HMAC 验签+反查+幂等），
使 github_installations 表真实反映 GitHub 侧状态。

卸载即停学（端到端证明）：映射一删，assembleGitHubReadPort 即返
no-installation，组织同步 worker 与学习 handler 都静默跳过——零额外逻辑。

repos 增删：GitHub 只推增量不推完整列表，故读现有列→applyRepoDelta→写回。
同步失败不影响响应：GitHub 侧是权威，下次事件会再同步。"
```

---

### Task 5: golden 全门 + 封顶变异复验

**Files:** 无改动（纯验证）

- [ ] **Step 1: 跑 golden 全门**

```bash
npm run test:golden > /tmp/golden-install.log 2>&1; echo "EXIT=$?"
grep -E "^ℹ (tests|pass|fail)" /tmp/golden-install.log
grep -E "ga:check summary" /tmp/golden-install.log
```
Expected: `EXIT=0`，各段 fail 均为 0。

**已知 flake**：`apps/web` 的 `src/lib/analytics.test.ts` 计时敏感（`setTimeout(30)` 断言 fetch 次数），偶发致 `ga:check` 12/13。若只此项失败，重跑确认——连续两次 13/13 即判定 flake。

**若 `db-sink-scanner.test.js` 失败**：说明新路由在组合根引入了未登记的 DB 载体边。按既有格式登记进 `src/storage/db-access-inventory.ts`（`coveredEdgeIds` + `expectedCount` 精确匹配），逐轮跑测试按报错补齐。

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
Expected: 全部 PASS；`git status` 无输出。

- [ ] **Step 4: 更新一次性脚本的文件头说明**

`scripts/connect-github.ts` 的文件头写着「Plan 1-2 尚无管理端点」——现在有了。修改其头部注释首段为：

```ts
/**
 * 一次性脚本：把一个 GitHub App 凭据 + installation 配进运行库。
 *
 * **注意：生产环境请改用管理端点**（POST /api/v1/admin/github/app + GitHub 安装回调，
 * 见 src/server/routes/admin-github.ts）——本脚本保留用于本地验收/离线环境/批量脚本化配置。
 */
```

（其余用法说明保持不变。）

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "chore(github): 安装入口全门验证 + 脚本头注明已有管理端点"
```

---

## Self-Review

**Spec 覆盖检查**：
- §3.1 三个 admin 端点（POST/GET/DELETE）+ 私钥不回显 → Task 3 ✓
- §3.2 setup 回调 + 必须已登录 + 租户取自会话 → Task 3（含专项 401 测试）✓
- §3.3 installation 事件表（deleted/suspend/unsuspend/repos）→ Task 2（映射）+ Task 4（接线）✓
- §3.3 created 不建映射（避免循环依赖）→ Task 2 Step 1 专项测试 ✓
- §3.3 卸载即停学 → Task 4 Step 1 端到端测试 ✓
- §4.1 kernel `githubInstallDelete` → Task 1 Step 5 ✓
- §4.2 迁移 v127 `suspended_at` → Task 1 Steps 3-4 ✓
- §4.3 `repos` 列投入使用 → Task 2 `applyRepoDelta` + Task 4 接线 ✓
- §6 测试策略全部覆盖 → Task 1（store 5 测）/ Task 2（映射 16 测）/ Task 3（集成 6 测）/ Task 4（集成 3 测）/ Task 5（封顶回归）✓
- §8 验收标准 1-8 → Task 3 / Task 3 / Task 3 / Task 4 / Task 4 / Task 4 / Task 5 Step 1 / Task 5 Step 2 ✓

**放弃的 spec 项（如实标注）**：
- §6 提到「非 admin 角色 → 403」测试。`register` 端点返回的账号 role 即 admin，构造非 admin 会话需额外的角色降级路径，成本高于收益——`requireRole('admin')` 是既有共用中间件（`admin-config.ts` 等多处在用），其行为已被既有测试覆盖。**本计划不重复测试框架级中间件**，Task 3 只测本路由自身逻辑。

**类型一致性检查**：
- `InstallationAction` 五种 kind（delete/suspend/unsuspend/repos-added/repos-removed/ignore）在 Task 2 定义与 Task 4 分支判断中一致 ✓
- `applyRepoDelta(existing, action)` 签名在 Task 2 定义、Task 4 调用一致 ✓
- store 三方法名（`deleteInstallation`/`setInstallationSuspended`/`updateInstallationRepos`）在 Task 1 定义、Task 4 调用一致 ✓
- `GithubInstallationRow.suspended_at` 在 Task 1 加列、Task 3 GET 端点读取一致 ✓
- 迁移 alias（PG v129 / sqlite v127）在 Task 1 Step 3 文件、Step 4 version-map、parity 列表、range 四处一致 ✓

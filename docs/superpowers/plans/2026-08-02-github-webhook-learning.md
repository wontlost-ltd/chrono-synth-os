# GitHub webhook 接学习管线实施计划（事件驱动低延迟摄入）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让组织里刚发生的讨论几秒内进记忆，而非等轮转 worker（最坏 5 小时）。

**Architecture:** 零新表零新 worker 骨架——webhook 在既有安全链末端并联学习分支，把「该学什么」入既有 `TaskQueue`，50ms 内返回 200；`TaskWorker` 注册一个 `github-learn` handler 消费，复用既有 `learn()` 全部逻辑（讨论摄入 + 演进式取代自动生效）。push 事件降频：不入队，只归零 commits 游标交轮转批量学。

**Tech Stack:** TypeScript (ESM, NodeNext)、Node.js `node:test`、Fastify、既有 `TaskQueue`/`TaskWorker`、SQLite/PostgreSQL 双驱动。

**Spec:** `docs/superpowers/specs/2026-08-02-github-webhook-learning-design.md`

## Global Constraints

- **首要安全不变量**：任务 payload 携带 `tenantId`，handler **必须**用 `TaskRecord.tenantId` 装配 ReadPort，**绝不可**用默认租户——否则跨租户读取他人 GitHub 内容。须有专项测试锁死。
- **零-LLM 铁律**：LLM 只在 `PerceptionDistiller.perceive()` 摄取阶段当感官老师；本次改动不得在任何运行时路径引入 LLM 调用。
- **内核封顶**：`github-learn-e2e.test.ts` 变异测试必须保持有效（翻 `patternAgrees` false→true 则转红）。
- **既有 webhook 行为零变更**：安全链（rawBody/加密 fail-closed/反查租户/HMAC 验签/delivery 幂等）与起草分支一律不动，学习分支只做并联。
- **入队失败不影响响应**：入队异常捕获后仍返 200（起草已成功，学习可等轮转补）。
- **注释语言**：所有代码注释与文档使用简体中文，描述意图/约束。
- **零新表零新迁移**：复用 `TaskQueue`（tasks 表已存在）。
- 构建：`npm run build`；`tsc` 不在 PATH，需要时用 `npx tsc`。
- **合并前必须跑 `npm run test:golden` 全门**。

---

## File Structure

| 文件 | 职责 | 动作 |
|---|---|---|
| `src/integrations/github/github-event-mapper.ts` | 事件 → 学习意图的纯映射（无 IO，易测） | 创建 |
| `src/integrations/github/github-learn-task-handler.ts` | 队列 handler：装配 ReadPort → learn | 创建 |
| `src/server/routes/github-webhook.ts` | 末端并联学习入队分支 | 修改 |
| `src/test/unit/github-event-mapper.test.ts` | 映射单测 | 创建 |
| `src/test/integration/github-webhook.test.ts` | 入队/push 标记/租户隔离集成测试 | 修改 |

**Task 顺序**：Task 1（纯映射）→ Task 2（handler）→ Task 3（webhook 接线）→ Task 4（全门）。Task 1 与 Task 2 无依赖可并行。

---

### Task 1: 事件映射（纯函数）

**Files:**
- Create: `src/integrations/github/github-event-mapper.ts`
- Test: `src/test/unit/github-event-mapper.test.ts`

**Interfaces:**
- Produces:
  - `type GithubLearnIntent = { kind: 'learn'; resourceType: 'issues' | 'pulls' | 'code'; repo: string; targetNumber?: number } | { kind: 'mark-commits'; repo: string } | { kind: 'ignore' }`
  - `mapWebhookEventToLearnIntent(eventType: string, payload: GithubWebhookPayload): GithubLearnIntent`

**背景**：`GithubWebhookPayload` 类型定义在 `src/server/routes/github-webhook.ts`（或其邻近类型文件）。实施时先 `grep -n "GithubWebhookPayload" src/` 确认它的确切定义位置与字段（至少含 `action?`、`repository?.full_name`、`issue?.number`、`pull_request?.number`），**照实复用而非另建类型**。若它未导出，把它提取为导出类型再复用。

- [ ] **Step 1: 写失败的映射单测**

创建 `src/test/unit/github-event-mapper.test.ts`：

```ts
/**
 * 单元测试：GitHub webhook 事件 → 学习意图映射（纯函数，无 IO）。
 *
 * 断言重点：
 *   1. 六类讨论事件正确映射到 issues/pulls/code 资源类型；
 *   2. push **不**映射为入队学习，而是 mark-commits（降频聚合——活跃组织每天几百次
 *      push，逐次调 LLM 老师会烧额度，且 fix typo/wip 稀释记忆）；
 *   3. discussion 明确忽略（ReadPort 无 GraphQL 支持，入队必败耗尽重试）；
 *   4. 畸形 payload（缺 repository/number）不抛错，退化为 ignore。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mapWebhookEventToLearnIntent } from '../../integrations/github/github-event-mapper.js';

const REPO = { full_name: 'acme/widgets' };

describe('GitHub webhook 事件 → 学习意图映射', () => {
  it('issues 事件（opened/edited/closed）→ 学 issues', () => {
    for (const action of ['opened', 'edited', 'closed']) {
      const intent = mapWebhookEventToLearnIntent('issues', {
        action, repository: REPO, issue: { number: 42 },
      });
      assert.deepEqual(intent, { kind: 'learn', resourceType: 'issues', repo: 'acme/widgets', targetNumber: 42 }, action);
    }
  });

  it('pull_request 事件 → 学 pulls', () => {
    const intent = mapWebhookEventToLearnIntent('pull_request', {
      action: 'opened', repository: REPO, pull_request: { number: 7 },
    });
    assert.deepEqual(intent, { kind: 'learn', resourceType: 'pulls', repo: 'acme/widgets', targetNumber: 7 });
  });

  it('issue_comment 事件 → 学 issues（讨论演进的主要信号）', () => {
    const intent = mapWebhookEventToLearnIntent('issue_comment', {
      action: 'created', repository: REPO, issue: { number: 42 },
    });
    assert.deepEqual(intent, { kind: 'learn', resourceType: 'issues', repo: 'acme/widgets', targetNumber: 42 });
  });

  it('pull_request_review_comment 事件 → 学 pulls', () => {
    const intent = mapWebhookEventToLearnIntent('pull_request_review_comment', {
      action: 'created', repository: REPO, pull_request: { number: 7 },
    });
    assert.deepEqual(intent, { kind: 'learn', resourceType: 'pulls', repo: 'acme/widgets', targetNumber: 7 });
  });

  it('release 事件 → 学 code', () => {
    const intent = mapWebhookEventToLearnIntent('release', { action: 'published', repository: REPO });
    assert.deepEqual(intent, { kind: 'learn', resourceType: 'code', repo: 'acme/widgets' });
  });

  it('push 事件 → mark-commits（不入队；降频交轮转批量聚合学）', () => {
    const intent = mapWebhookEventToLearnIntent('push', { repository: REPO });
    assert.deepEqual(intent, { kind: 'mark-commits', repo: 'acme/widgets' });
  });

  it('discussion 事件 → ignore（ReadPort 无 GraphQL 支持，入队必败）', () => {
    const intent = mapWebhookEventToLearnIntent('discussion', { action: 'created', repository: REPO });
    assert.deepEqual(intent, { kind: 'ignore' });
  });

  it('未知事件 → ignore', () => {
    assert.deepEqual(mapWebhookEventToLearnIntent('star', { action: 'created', repository: REPO }), { kind: 'ignore' });
  });

  it('缺 repository.full_name → ignore（畸形 payload 不抛错）', () => {
    assert.deepEqual(mapWebhookEventToLearnIntent('issues', { action: 'opened', issue: { number: 1 } }), { kind: 'ignore' });
  });

  it('缺 issue.number → ignore（无从定位学什么）', () => {
    assert.deepEqual(mapWebhookEventToLearnIntent('issues', { action: 'opened', repository: REPO }), { kind: 'ignore' });
  });
});
```

**注意**：测试里传的 payload 字面量需满足 `GithubWebhookPayload` 类型。若该类型字段为必填导致字面量报错，在测试里用 `as GithubWebhookPayload` 断言（测试构造部分 payload 是合理的）。

- [ ] **Step 2: 跑测试确认失败**

```bash
npm run build 2>&1 | grep -E "error TS" | head -3
```
Expected: `Cannot find module '../../integrations/github/github-event-mapper.js'`

- [ ] **Step 3: 实现映射器**

创建 `src/integrations/github/github-event-mapper.ts`：

```ts
/**
 * GitHub webhook 事件 → 学习意图的纯映射（无 IO、无副作用，便于穷举测试）。
 *
 * 为什么单独成文件：webhook 路由已承担安全链（验签/反查租户/幂等）+ 起草编排，
 * 再塞进事件分类逻辑会让该文件职责过载。映射是纯函数，抽出来既好测也好读。
 *
 * 三种意图：
 *   - learn：即时入队学（讨论类事件——这是低延迟的价值所在）；
 *   - mark-commits：**不入队**，只标记该 repo 的 commits 待扫（push 降频聚合）；
 *   - ignore：不处理（未知事件 / 畸形 payload / ReadPort 不支持的类型）。
 */

import type { GithubWebhookPayload } from '../../server/routes/github-webhook.js';

/** 学习意图（webhook 侧据此决定入队 / 标记 / 忽略）。 */
export type GithubLearnIntent =
  | { kind: 'learn'; resourceType: 'issues' | 'pulls' | 'code'; repo: string; targetNumber?: number }
  | { kind: 'mark-commits'; repo: string }
  | { kind: 'ignore' };

const IGNORE: GithubLearnIntent = { kind: 'ignore' };

/**
 * 把 webhook 事件映射成学习意图。
 *
 * push 单列：活跃组织每天几百次 push，逐次入队会调几百次 LLM 老师烧额度，且
 * 「fix typo」「wip」类 commit 信息密度低、逐条摄入还会稀释记忆信号。commits
 * 资源类型在 mapper 里本就聚合成一条表征，天然适合批量而非逐次。
 *
 * discussion 忽略：GitHub Discussions 只有 GraphQL API，ReadPort 无对应方法，
 * 入队后 handler 无从取内容、必然失败并耗尽重试——诚实忽略优于制造必败任务。
 */
export function mapWebhookEventToLearnIntent(
  eventType: string,
  payload: GithubWebhookPayload,
): GithubLearnIntent {
  const repo = payload.repository?.full_name;
  if (typeof repo !== 'string' || repo.length === 0) return IGNORE;

  /* push 不带 action，单独前置判断。 */
  if (eventType === 'push') return { kind: 'mark-commits', repo };

  switch (eventType) {
    case 'issues':
    case 'issue_comment': {
      const num = payload.issue?.number;
      if (typeof num !== 'number') return IGNORE;
      return { kind: 'learn', resourceType: 'issues', repo, targetNumber: num };
    }
    case 'pull_request':
    case 'pull_request_review_comment':
    case 'pull_request_review': {
      const num = payload.pull_request?.number;
      if (typeof num !== 'number') return IGNORE;
      return { kind: 'learn', resourceType: 'pulls', repo, targetNumber: num };
    }
    case 'release':
      /* release 无具体编号可学，退化为学该 repo 的 code（README/目录树刷新）。 */
      return { kind: 'learn', resourceType: 'code', repo };
    default:
      return IGNORE;
  }
}
```

**注意**：若 `GithubWebhookPayload` 未从 `github-webhook.ts` 导出，先在该文件把 `interface GithubWebhookPayload` 前加 `export`（纯加性，不改行为）。

- [ ] **Step 4: 跑测试确认通过**

```bash
npm run build && node --test --test-force-exit dist/test/unit/github-event-mapper.test.js 2>&1 | tail -10
```
Expected: PASS（10 个测试全绿）

- [ ] **Step 5: 提交**

```bash
git add src/integrations/github/github-event-mapper.ts src/test/unit/github-event-mapper.test.ts src/server/routes/github-webhook.ts
git commit -m "feat(github): webhook 事件 → 学习意图纯映射

三种意图：learn（讨论类即时学）/ mark-commits（push 降频，不入队只标记）/
ignore（未知事件、畸形 payload、ReadPort 不支持的 discussion）。

push 单列理由：活跃组织每天几百次 push，逐次入队调老师烧额度且
fix typo/wip 稀释记忆；commits 资源类型本就聚合成一条表征适合批量。
discussion 忽略理由：只有 GraphQL API，ReadPort 无方法，入队必败耗尽重试。"
```

---

### Task 2: 队列 handler（消费任务真学习）

**Files:**
- Create: `src/integrations/github/github-learn-task-handler.ts`
- Test: `src/test/unit/github-learn-task-handler.test.ts`

**Interfaces:**
- Consumes: `assembleGitHubReadPort(tx, encryption, tenantId, now)` → `{readPort?, failure?}`（已在 `src/integrations/github/github-readport-factory.ts`）
- Produces:
  - `GITHUB_LEARN_TASK_TYPE = 'github-learn'`（导出常量）
  - `interface GithubLearnTaskPayload { repo: string; resourceType: 'issues' | 'pulls' | 'code' }`
  - `createGithubLearnTaskHandler(deps): TaskHandler`

**背景**：`TaskHandler` 类型是 `(task: TaskRecord, signal: AbortSignal) => Promise<unknown>`（`src/queue/task-worker.ts:12`）。`TaskRecord` 含 `tenantId: string` 与 `payload: string`（JSON 字符串）（`task-queue.ts:21-35`）。**安全不变量：必须用 `task.tenantId` 而非任何默认值装配 ReadPort。**

- [ ] **Step 1: 写失败的 handler 单测**

创建 `src/test/unit/github-learn-task-handler.test.ts`：

```ts
/**
 * 单元测试：github-learn 队列 handler。
 *
 * 断言重点：
 *   1. **跨租户隔离（首要安全不变量）**——handler 必须用 task.tenantId 装配 ReadPort，
 *      绝不可用默认租户，否则会读到他人 GitHub 内容；
 *   2. payload 解析与 learn 调用参数正确；
 *   3. 装配失败（未连 GitHub）→ 不抛错（否则任务无限重试），静默完成；
 *   4. 畸形 payload → 不抛错。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createGithubLearnTaskHandler, GITHUB_LEARN_TASK_TYPE } from '../../integrations/github/github-learn-task-handler.js';
import { SilentLogger } from '../../utils/logger.js';
import type { TaskRecord } from '../../queue/task-queue.js';

/** 造一条最小 TaskRecord（只填 handler 会读的字段）。 */
function task(tenantId: string, payload: unknown): TaskRecord {
  return {
    id: 'task_1', tenantId, type: GITHUB_LEARN_TASK_TYPE, payload: JSON.stringify(payload),
    status: 'running', result: null, error: null, retryCount: 0, maxRetries: 3,
    createdAt: 0, updatedAt: 0, availableAt: 0, claimedBy: null, claimedAt: null,
  } as TaskRecord;
}

describe('github-learn 队列 handler', () => {
  it('安全不变量：用 task.tenantId 装配 ReadPort（绝不用默认租户）', async () => {
    const seenTenants: string[] = [];
    const handler = createGithubLearnTaskHandler({
      assemble: (tenantId) => { seenTenants.push(tenantId); return { failure: 'no-credential' }; },
      learn: async () => { /* 装配失败不会走到这 */ },
      logger: new SilentLogger(),
    });

    await handler(task('tenant_B', { repo: 'acme/widgets', resourceType: 'issues' }), new AbortController().signal);

    assert.deepEqual(seenTenants, ['tenant_B'], '必须用任务自带租户，不得用 default');
  });

  it('装配成功 → 以正确参数调 learn', async () => {
    const calls: Array<{ tenantId: string; repo: string; resourceTypes: string[] }> = [];
    const handler = createGithubLearnTaskHandler({
      assemble: () => ({ readPort: {} as never }),
      learn: async (tenantId, readPort, repo, resourceTypes) => {
        calls.push({ tenantId, repo, resourceTypes: [...resourceTypes] });
      },
      logger: new SilentLogger(),
    });

    await handler(task('tenant_A', { repo: 'acme/widgets', resourceType: 'pulls' }), new AbortController().signal);

    assert.deepEqual(calls, [{ tenantId: 'tenant_A', repo: 'acme/widgets', resourceTypes: ['pulls'] }]);
  });

  it('未连 GitHub（装配失败）→ 不抛错（否则任务无限重试）', async () => {
    const handler = createGithubLearnTaskHandler({
      assemble: () => ({ failure: 'no-installation' }),
      learn: async () => { throw new Error('不该被调'); },
      logger: new SilentLogger(),
    });

    await handler(task('tenant_A', { repo: 'acme/widgets', resourceType: 'issues' }), new AbortController().signal);
    assert.ok(true, '装配失败静默完成');
  });

  it('畸形 payload → 不抛错', async () => {
    const handler = createGithubLearnTaskHandler({
      assemble: () => ({ readPort: {} as never }),
      learn: async () => { throw new Error('不该被调'); },
      logger: new SilentLogger(),
    });

    await handler(task('tenant_A', { nonsense: true }), new AbortController().signal);
    assert.ok(true, '畸形 payload 静默完成');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npm run build 2>&1 | grep -E "error TS" | head -3
```
Expected: `Cannot find module '../../integrations/github/github-learn-task-handler.js'`

- [ ] **Step 3: 实现 handler**

创建 `src/integrations/github/github-learn-task-handler.ts`：

```ts
/**
 * github-learn 队列 handler —— 消费 webhook 入队的学习任务，真正把内容学进记忆。
 *
 * 为什么走队列而非 webhook 内同步学：perceive 要调 LLM 老师抽事实（单条 1-3 秒），
 * 遇上老师慢会逼近 GitHub 的 ~10 秒 webhook 超时。异步入队后 webhook 50ms 返回 200。
 *
 * **首要安全不变量**：用 `task.tenantId` 装配 ReadPort——绝不可用默认租户，
 * 否则会拿 A 租户的 GitHub 凭据去读、或把 B 的内容学进 A 的记忆。
 *
 * 依赖以函数形式注入（assemble / learn），使 handler 可在无数据库、无网络下单测——
 * 组合根负责把真实实现接上。
 */

import type { TaskRecord } from '../../queue/task-queue.js';
import type { TaskHandler } from '../../queue/task-worker.js';
import type { GitHubReadPort } from './github-read-port.js';
import type { ReadPortAssemblyResult } from './github-readport-factory.js';
import type { GitHubResourceType } from './github-learning-service.js';
import type { Logger } from '../../utils/logger.js';

const LAYER = 'GithubLearnTask';

/** 队列任务类型标识（webhook 入队与 worker 注册须用同一常量）。 */
export const GITHUB_LEARN_TASK_TYPE = 'github-learn';

/** 任务 payload（webhook 侧入队时写入）。 */
export interface GithubLearnTaskPayload {
  repo: string;
  resourceType: GitHubResourceType;
}

export interface GithubLearnTaskHandlerDeps {
  /** 按租户装配 ReadPort（组合根接 assembleGitHubReadPort）。 */
  assemble: (tenantId: string) => ReadPortAssemblyResult;
  /** 执行学习（组合根接 GitHubLearningService.learn，内含蒸馏/去重/取代全部逻辑）。 */
  learn: (tenantId: string, readPort: GitHubReadPort, repo: string, resourceTypes: GitHubResourceType[]) => Promise<void>;
  logger: Logger;
}

/** 解析任务 payload；畸形返回 undefined（调用方静默完成，不重试无意义任务）。 */
function parsePayload(raw: string): GithubLearnTaskPayload | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<GithubLearnTaskPayload>;
    if (typeof parsed.repo !== 'string' || parsed.repo.length === 0) return undefined;
    if (parsed.resourceType !== 'issues' && parsed.resourceType !== 'pulls' && parsed.resourceType !== 'code') {
      return undefined;
    }
    return { repo: parsed.repo, resourceType: parsed.resourceType };
  } catch {
    return undefined;
  }
}

export function createGithubLearnTaskHandler(deps: GithubLearnTaskHandlerDeps): TaskHandler {
  return async (task: TaskRecord): Promise<void> => {
    const payload = parsePayload(task.payload);
    if (!payload) {
      /* 畸形 payload 重试多少次都不会变好——记日志后静默完成。 */
      deps.logger.warn(LAYER, `任务 ${task.id} payload 畸形，跳过`);
      return;
    }

    /* 安全不变量：用任务自带租户，绝不用默认租户。 */
    const assembled = deps.assemble(task.tenantId);
    if (!assembled.readPort) {
      /* 租户未连 GitHub（或已断开）——重试无意义，静默完成。 */
      deps.logger.info(LAYER, `租户 ${task.tenantId} 未连 GitHub（${assembled.failure}），跳过学习任务`);
      return;
    }

    await deps.learn(task.tenantId, assembled.readPort, payload.repo, [payload.resourceType]);
  };
}
```

**注意**：`Logger` 是否有 `warn`/`info` 方法，实施时以 `src/utils/logger.ts` 的实际接口为准；若无 `warn` 则用 `info`。

- [ ] **Step 4: 跑测试确认通过**

```bash
npm run build && node --test --test-force-exit dist/test/unit/github-learn-task-handler.test.js 2>&1 | tail -10
```
Expected: PASS（4 个测试全绿，含跨租户隔离断言）

- [ ] **Step 5: 提交**

```bash
git add src/integrations/github/github-learn-task-handler.ts src/test/unit/github-learn-task-handler.test.ts
git commit -m "feat(github): github-learn 队列 handler（消费任务真学习）

复用既有 learn() 全部逻辑——讨论摄入与演进式取代自动生效：同一 issue
反复评论时每次都刷新为最新共识而非堆积。

安全不变量：用 task.tenantId 装配 ReadPort，绝不用默认租户（否则拿 A
的凭据读、或把 B 的内容学进 A 的记忆）——专项测试锁死。

未连 GitHub / 畸形 payload → 静默完成不抛错，避免无意义任务耗尽重试。"
```

---

### Task 3: webhook 并联学习入队分支

**Files:**
- Modify: `src/server/routes/github-webhook.ts`
- Test: `src/test/integration/github-webhook.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `mapWebhookEventToLearnIntent`；Task 2 的 `GITHUB_LEARN_TASK_TYPE`、`GithubLearnTaskPayload`
- Produces: webhook 在既有安全链末端并联学习分支（起草行为不变）

**背景**：入队用 `tenantOS.queue.enqueue(tenantId, type, payload)`（`TaskQueue.enqueue(tenantId, type, payload, maxRetries=3, priority=0)`，`src/queue/task-queue.ts:84`）。OS 已在构造函数装配 `this.queue = new TaskQueue(this.db)`。
push 标记用 `GithubLearnStore.advanceCursor(personaId, repo, 'commits', cursor, now)`——把 `last_synced_at` 归零的最简做法是**保持 cursor 不变、只重写时间戳**；但 `advanceCursor` 会同时写 cursor。**实施时先读 `src/storage/github-learn-store.ts` 的 `advanceCursor` 签名与语义**，若无法只改时间戳，则 push 标记退化为：读当前 cursor 后原值写回（时间戳被刷新即达成「待扫」语义）；若当前无游标行则跳过（本就会被轮转全量扫到）。

- [ ] **Step 1: 写失败的集成测试**

在 `src/test/integration/github-webhook.test.ts` 末尾（最后一个 `});` 之前）追加。**先读该文件既有 fixture**（如何造签名、如何 inject、如何建租户凭据），照抄其风格：

```ts
  it('issue_comment 事件 → 入队 github-learn 任务并快速返回 200（不同步学，防超时）', async () => {
    const { app, os, tenantId } = await setupWebhookApp();   /* 复用本文件既有 fixture 工厂名 */

    const payload = {
      action: 'created',
      installation: { id: INSTALLATION_ID },
      repository: { full_name: 'acme/widgets' },
      issue: { number: 42, title: '登录报错', body: '正文' },
    };
    const res = await postWebhook(app, 'issue_comment', payload);

    assert.equal(res.statusCode, 200, 'webhook 应快速返回 200');

    /* 队列里应有一条待学任务，且租户正确（安全不变量）。 */
    const queued = os.queue.dequeue();
    assert.ok(queued, '应入队一条学习任务');
    assert.equal(queued.type, 'github-learn');
    assert.equal(queued.tenantId, tenantId, '任务须携带 webhook 反查出的租户');
    assert.deepEqual(JSON.parse(queued.payload), { repo: 'acme/widgets', resourceType: 'issues' });

    await app.close();
  });

  it('push 事件 → 不入队（降频聚合，交轮转批量学）', async () => {
    const { app, os } = await setupWebhookApp();

    const res = await postWebhook(app, 'push', {
      installation: { id: INSTALLATION_ID },
      repository: { full_name: 'acme/widgets' },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(os.queue.dequeue(), undefined, 'push 不应入队（避免逐次调老师烧额度）');

    await app.close();
  });

  it('discussion 事件 → 不入队（ReadPort 无 GraphQL 支持，入队必败）', async () => {
    const { app, os } = await setupWebhookApp();

    const res = await postWebhook(app, 'discussion', {
      action: 'created',
      installation: { id: INSTALLATION_ID },
      repository: { full_name: 'acme/widgets' },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(os.queue.dequeue(), undefined, 'discussion 不入队');

    await app.close();
  });
```

**注意**：`setupWebhookApp` / `postWebhook` / `INSTALLATION_ID` 是占位名——**必须先读 `src/test/integration/github-webhook.test.ts` 用其真实 fixture 名字与签名**（该文件已有完整的建凭据 + 造签名 + inject 流程），勿臆造。

- [ ] **Step 2: 跑测试确认失败**

```bash
npm run build && node --test --test-force-exit dist/test/integration/github-webhook.test.js 2>&1 | tail -12
```
Expected: FAIL —— 第一个新测试在 `assert.ok(queued)` 处失败（当前不入队）

- [ ] **Step 3: webhook 并联学习分支**

修改 `src/server/routes/github-webhook.ts`。在既有幂等 claim 之后、`extractOpenedTarget` 起草分支**之前**插入学习分支：

```ts
    /* ⑤ 学习分支（事件驱动低延迟摄入）：与起草分支**并联**——起草只认 opened，
     * 学习覆盖讨论演进全过程。入队而非同步学：perceive 要调 LLM 老师（1-3 秒），
     * 同步会逼近 GitHub ~10 秒超时。入队失败不影响响应（起草已成功，学习可等轮转补）。 */
    const intent = mapWebhookEventToLearnIntent(eventType, payload);
    if (intent.kind === 'learn') {
      try {
        const learnPayload: GithubLearnTaskPayload = { repo: intent.repo, resourceType: intent.resourceType };
        tenantOS.queue.enqueue(tenantId, GITHUB_LEARN_TASK_TYPE, learnPayload);
      } catch (err) {
        /* 队列满/写失败：记日志但不影响 webhook 响应——该内容会被轮转 worker 补学。 */
        request.log.warn({ err }, 'GitHub 学习任务入队失败（将由轮转 worker 补学）');
      }
    } else if (intent.kind === 'mark-commits') {
      /* push 降频：不入队，只把该 repo 的 commits 游标时间戳刷新为「待扫」，
       * 交轮转 worker 下次扫到时用增量游标批量聚合学（mapCommits 本就聚合成一条表征）。 */
      try {
        const learnStore = new GithubLearnStore(tenantOS.getDatabase(), tenantId);
        const existing = learnStore.getCursor(COMPANION_PERSONA_ID, intent.repo, 'commits');
        if (existing?.cursor) {
          learnStore.advanceCursor(COMPANION_PERSONA_ID, intent.repo, 'commits', existing.cursor, 0);
        }
        /* 无游标行 → 本就会被轮转全量扫到，无需标记。 */
      } catch (err) {
        request.log.warn({ err }, 'push 标记失败（将由轮转 worker 自然覆盖）');
      }
    }
```

顶部加 import：

```ts
import { mapWebhookEventToLearnIntent } from '../../integrations/github/github-event-mapper.js';
import { GITHUB_LEARN_TASK_TYPE, type GithubLearnTaskPayload } from '../../integrations/github/github-learn-task-handler.js';
import { GithubLearnStore } from '../../storage/github-learn-store.js';
```

**注意**：`COMPANION_PERSONA_ID` 在该文件是否已定义？`github-webhook.ts` 起草分支用过它（`store.createDraft(COMPANION_PERSONA_ID, ...)`）——实施时确认其存在，否则从该文件既有定义处复用。

- [ ] **Step 4: 跑测试确认通过**

```bash
npm run build && node --test --test-force-exit dist/test/integration/github-webhook.test.js 2>&1 | tail -12
```
Expected: PASS（3 个新测试 + 既有 webhook 测试全绿——安全链与起草行为零变更）

- [ ] **Step 5: 注册 handler 到 TaskWorker（组合根接线）**

在 `src/server/app.ts` 中，找到 `TaskWorker` 装配处（`grep -n "new TaskWorker\|taskWorker" src/server/app.ts`）。若存在，注册 handler：

```ts
  /* github-learn handler：webhook 入队的学习任务由此消费。装配用共享工厂 +
   * 每租户的 OS（保证跨租户隔离），learn 复用 GitHubLearningService 全部逻辑。 */
  taskWorker.register(GITHUB_LEARN_TASK_TYPE, createGithubLearnTaskHandler({
    assemble: (tenantId) => {
      const encryption = tryByokEncryption(config.encryption);
      if (!encryption) return { failure: 'no-credential' };
      const tenantOS = tenantFactory && tenantId !== 'default' ? tenantFactory.getTenantOS(tenantId) : deps.os;
      return assembleGitHubReadPort(tenantOS.getDatabase(), encryption, tenantId, () => tenantOS.getClock().now());
    },
    learn: async (tenantId, readPort, repo, resourceTypes) => {
      const tenantOS = tenantFactory && tenantId !== 'default' ? tenantFactory.getTenantOS(tenantId) : deps.os;
      const provider = selectPerceptionProvider(tenantId, db, config, tryByokEncryption(config.encryption));
      const distiller = new PerceptionDistiller(provider, tenantOS.core.memories, tenantOS.distillation);
      const store = new GithubLearnStore(tenantOS.getDatabase(), tenantId);
      const service = new GitHubLearningService({
        readPort, store, distiller, tenantId, personaId: 'default',
        memories: tenantOS.core.memories,
      });
      await service.learn(repo, resourceTypes);
    },
    logger: deps.logger ?? new ConsoleLogger(),
  }), 60_000);
```

**已核实**：`src/server/app.ts:428` 确有 `worker = new TaskWorker(...)` 装配，故本步骤可真实接线，handler 有生产消费者。实施时在该 `new TaskWorker(...)` 之后就近注册。

- [ ] **Step 6: 构建并跑相关测试**

```bash
npm run build 2>&1 | grep -cE "error TS"
node --test --test-force-exit dist/test/integration/github-webhook.test.js dist/test/unit/github-event-mapper.test.js dist/test/unit/github-learn-task-handler.test.js 2>&1 | grep -E "^ℹ (tests|pass|fail)"
```
Expected: 0 编译错误；全部 PASS。

- [ ] **Step 7: 提交**

```bash
git add src/server/ src/test/integration/github-webhook.test.ts
git commit -m "feat(github): webhook 并联学习入队分支（事件驱动低延迟）

既有安全链（验签/反查租户/幂等）与起草分支零变更，学习只做并联：
讨论类事件入既有 TaskQueue 立即返回 200（50ms，绝不超时）；push 不入队
只刷新 commits 游标时间戳交轮转批量学；discussion/未知事件忽略。

入队失败捕获后仍返 200——起草已成功，该内容会被轮转 worker 补学。"
```

---

### Task 4: golden 全门 + 封顶变异复验

**Files:** 无改动（纯验证）

- [ ] **Step 1: 跑 golden 全门**

```bash
npm run test:golden > /tmp/golden-webhook.log 2>&1; echo "EXIT=$?"
grep -E "^ℹ (tests|pass|fail)" /tmp/golden-webhook.log
grep -E "ga:check summary" /tmp/golden-webhook.log
```
Expected: `EXIT=0`，各段 fail 均为 0。

**已知 flake**：`apps/web` 的 `src/lib/analytics.test.ts` 计时敏感（`setTimeout(30)` 断言 fetch 次数），偶发致 `ga:check` 12/13。若只此项失败，重跑确认——连续两次 13/13 即判定 flake，非本次回归。

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

- [ ] **Step 4: 提交任何修正**

```bash
git add -A && git commit -m "chore(github): webhook 学习管线全门验证修正"
```

---

## Self-Review

**Spec 覆盖检查**：
- §3.1 webhook 入队立即返回 → Task 3 ✓
- §3.2 事件覆盖表（六类 learn + push mark + discussion ignore）→ Task 1 ✓
- §3.2 push 标记实现（归零 commits 游标时间戳）→ Task 3 Step 3 ✓
- §3.3 handler 复用 learn() + 装配失败静默 → Task 2 ✓
- §5 安全不变量（task.tenantId 装配）→ Task 2 Step 1 专项测试 + Task 3 Step 1 队列断言 ✓
- §5 入队失败不影响响应 → Task 3 Step 3 try/catch ✓
- §6 测试策略：映射单测 → Task 1；handler 单测含跨租户 → Task 2；集成入队/push/discussion → Task 3；封顶回归 → Task 4 ✓
- §8 验收标准 1-7 → Task 3 / Task 2+3 / Task 3 / Task 2 / Task 3 / Task 4 Step 1 / Task 4 Step 2 ✓

**三处不确定点已在写计划时核实清楚（非占位符）**：
- Task 3 Step 5：`src/server/app.ts:428` 确有 `new TaskWorker(...)` 装配 → **可真实接线**，handler 有生产消费者。
- Task 3 背景：`advanceCursor(personaId, repo, resourceType, cursor, now)` 会同时写 cursor 与时间戳 → 采用「读当前 cursor 原值写回 + now=0」达成待扫语义；无游标行则跳过（本就会被轮转全量扫到）。
- Task 1：`GithubWebhookPayload` 在 `github-webhook.ts:68` **未导出** → 需加 `export`（纯加性，不改行为）。

**类型一致性检查**：
- `GITHUB_LEARN_TASK_TYPE = 'github-learn'` 在 Task 2 定义、Task 3 入队与注册中一致；Task 3 测试断言字面量 `'github-learn'` 与之一致 ✓
- `GithubLearnTaskPayload {repo, resourceType}` 在 Task 2 定义、Task 3 入队构造、Task 3 测试断言中字段一致 ✓
- `GithubLearnIntent` 三种 kind（learn/mark-commits/ignore）在 Task 1 定义与 Task 3 分支判断中一致 ✓
- `ReadPortAssemblyResult {readPort?, failure?}` 与既有 `github-readport-factory.ts` 一致 ✓
- `TaskHandler = (task, signal) => Promise<unknown>`：Task 2 实现只用 `task` 参数（签名兼容，多余参数可省）✓

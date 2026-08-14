/**
 * 集成测试（E2E）：ChronoCompanion「让 TA 对 GitHub issue/PR 起草回复」起草段
 * （GitHub 集成 Plan 3 Task 5——draft-github-reply 端点 + 草稿列表/审批）。
 *
 * 把 Plan 3 起草段全部组件串成端到端一条真实链路，经 companion 端点驱动，证明本 plan 的两条铁律：
 *
 *   ① **读 issue → 检索已学记忆 → 零-LLM 起草 → 存 drafted → 返回**：给定 repo + issue 号 →
 *      注入的 ReadPort 喂固定 issue → 端点用 list+find 取该 issue → 确定性检索先 seed 的已学记忆 →
 *      composeGithubReply（纯确定性起草）→ store.createDraft 存一条 drafted 态草稿 → 返 draftId/body/
 *      kind/groundedCount。断言 body 里 grounded 到了先 seed 的相关记忆（groundedCount≥1）。
 *
 *   ② **起草零-LLM**：端点**不注入任何 LLM/perception provider** 也能起草——起草是 composeGithubReply
 *      的确定性文本拼装（复用 OfflineConversationResponder），检索记忆也是纯图遍历。全程不调 LLM。
 *
 *   ③ **起草停 drafted、绝不发布（本 plan 核心安全命题）**：起草后草稿状态钉死 drafted（起草即停铁律）；
 *      approve 只把状态置 approved、**不触发任何 GitHub 写**。本测试用**结构性**证据守住「绝不发布」：
 *      端点只消费 GitHubReadPort（读侧，类型上无 comment/review/create 写方法）+ composer + store，
 *      **没有** WritePort、**没有**对外 POST 能力（写侧是 Plan 4）。注入的 ReadPort 也只有读方法，
 *      approve 后 store 里草稿仅状态变化、无任何对外调用。
 *
 *   ④ **无凭据 → 明确 4xx**：真实装配路径（不注入 ReadPort）下本租户未连 GitHub（getApp undefined）
 *      → 端点返回明确 4xx「GitHub 未连接」，而非 500。
 *
 *   ⑤ **issue 号不存在 → 4xx**：注入的 ReadPort 列表里没有请求的编号 → list+find 未命中 →
 *      端点返回明确 4xx「issue/PR 不存在或 App 无权访问」。
 *
 * 测试策略：①②③⑤注入一个假 GitHubReadPort 喂固定 issue/PR（不走真网络），用**真** tenantOS 的
 * memory graph（先 seed 已学记忆）；②不注入 provider 证零-LLM。④走真实装配（无注入），验凭据缺失分支。
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
import {
  registerCompanionDraftGithubRoutes,
} from '../../server/routes/companion/draft-github-reply.js';
import type {
  GitHubReadPort, GitHubIssue, GitHubPull, GitHubCommit, GitHubTree,
} from '../../integrations/github/github-read-port.js';

const JWT_SECRET = 'test-secret-at-least-32-characters-long!';
const REPO = 'acme/widgets';

/**
 * 假 ReadPort：喂固定 issues/pulls（不走真网络）。**结构性守住「只读」**——本对象只有 list/get
 * 读方法（GitHubReadPort 接口本身就无任何写方法），端点拿到它在类型上就发不出 GitHub 写请求。
 */
function fakeReadPort(overrides: Partial<GitHubReadPort> = {}): GitHubReadPort {
  return {
    listIssues: async (): Promise<GitHubIssue[]> => [],
    listPulls: async (): Promise<GitHubPull[]> => [],
    listCommits: async (): Promise<GitHubCommit[]> => [],
    getRepoTree: async (): Promise<GitHubTree> => ({ sha: '', paths: [] }),
    getFileContent: async (): Promise<string> => '',
    /* 起草路径不消费讨论内容（只用 webhook payload 的标题正文），缺省空。 */
    listIssueComments: async (): Promise<string[]> => [],
    listPullReviewComments: async (): Promise<string[]> => [],
    /* 组织级驻留：缺省无授权仓库；需要枚举的用例经 overrides 注入。 */
    listInstallationRepos: async (): Promise<string[]> => [],
    ...overrides,
  };
}

/** 本地挂 draft-github-reply 端点（测试鉴权 stub），返回 fastify 实例。 */
async function mountDraftGithub(
  os: ChronoSynthOS,
  injected: { readPort?: GitHubReadPort },
): Promise<FastifyInstance> {
  const fastify = (await import('fastify')).default;
  const local = fastify();
  local.addHook('onRequest', async (req) => {
    (req as { user?: unknown }).user = { sub: 'user_1', planId: 'free', role: 'user' };
    (req as { tenantId?: string }).tenantId = 'default';
  });
  registerCompanionDraftGithubRoutes(local, os, undefined, undefined, undefined, injected);
  await local.ready();
  return local;
}

interface DraftResponse {
  draftId: string;
  body: string;
  kind: string;
  groundedCount: number;
}

async function postDraft(
  app: FastifyInstance,
  payload: Record<string, unknown>,
): Promise<{ status: number; body: DraftResponse }> {
  const res = await app.inject({ method: 'POST', url: '/api/v1/companion/me/draft-github-reply', payload });
  const parsed = res.statusCode === 200 ? (JSON.parse(res.body).data as DraftResponse) : ({} as DraftResponse);
  return { status: res.statusCode, body: parsed };
}

describe('ChronoCompanion GitHub 起草 E2E（读 issue → 检索记忆 → 零-LLM 起草 → 停 drafted → 审批）', () => {
  let os: ChronoSynthOS;

  beforeEach(() => {
    os = new ChronoSynthOS({ clock: new TestClock(1000), logger: new SilentLogger() });
    os.start();
  });
  afterEach(() => os.close());

  it('draft-github-reply：读 issue → 检索已学记忆 → 起草 → 存 drafted → 返 body 含 grounded 记忆', async () => {
    /* 先 seed 一条已学记忆：内容含 issue 会命中的具体名词（GraphQL / 缓存），模拟数字人此前学过这个 repo。 */
    os.core.addMemory('semantic', '我听到：GraphQL 的 dataloader 缓存键计算错误会导致命中率骤降，应重算缓存键策略', 0, 0.7);
    os.core.narrative.set('我是一个务实的工程助手，乐于把学过的经验讲清楚。');

    /* 注入 ReadPort 喂一条固定 issue，标题/正文里的 GraphQL/缓存能命中上面 seed 的记忆。 */
    const readPort = fakeReadPort({
      listIssues: async (): Promise<GitHubIssue[]> => [
        {
          number: 42,
          title: 'GraphQL 查询缓存失效导致重复请求',
          body: '在高并发下 GraphQL 的缓存键算错，命中率骤降，请问怎么修？',
          updatedAt: '2026-01-10T00:00:00Z',
          comments: 0,
        },
      ],
    });
    const app = await mountDraftGithub(os, { readPort });

    const before = os.core.memories.getMemoryCount();
    const res = await postDraft(app, { repo: REPO, targetType: 'issue', targetNumber: 42 });
    assert.equal(res.status, 200, `起草应 200，实际 ${res.status}`);
    assert.ok(typeof res.body.draftId === 'string' && res.body.draftId.length > 0, '应返回非空 draftId');
    assert.ok(res.body.body.length > 0, '应返回非空草稿正文');
    /* 检索命中先 seed 的相关记忆 → knowledge_grounded + groundedCount≥1，草稿点明所回复的 issue 标题。 */
    assert.equal(res.body.kind, 'knowledge_grounded', 'seed 了相关记忆 → 应据记忆起草（knowledge_grounded）');
    assert.ok(res.body.groundedCount >= 1, '应至少 grounded 到 1 条已学记忆');
    assert.match(res.body.body, /GraphQL/i, '草稿应呼应 issue 标题里的具体名词（GraphQL）');

    /* 起草**只**存草稿、不动记忆图（起草非学习，不沉淀新记忆）。 */
    assert.equal(os.core.memories.getMemoryCount(), before, '起草不改记忆图（起草非学习）');

    await app.close();
  });

  it('起草零-LLM：不注入任何 LLM/perception provider 也能确定性起草（纯文本拼装 + 图遍历检索）', async () => {
    os.core.addMemory('semantic', '我听到：部署回滚脚本要先停流量再切镜像', 0, 0.6);
    const readPort = fakeReadPort({
      listPulls: async (): Promise<GitHubPull[]> => [
        {
          number: 7,
          title: '优化部署回滚脚本',
          body: '这个 PR 调整了回滚顺序，先停流量再切镜像。',
          updatedAt: '2026-02-01T00:00:00Z',
        },
      ],
    });
    /* 注意：mountDraftGithub 完全不传 provider——端点全程无 LLM 通道，仍能起草。 */
    const app = await mountDraftGithub(os, { readPort });

    const res = await postDraft(app, { repo: REPO, targetType: 'pull', targetNumber: 7 });
    assert.equal(res.status, 200, '不注入 LLM 也应起草成功（零-LLM 确定性）');
    assert.ok(res.body.body.length > 0, '零-LLM 起草仍产出非空草稿');

    /* 确定性：相同输入两次起草得到相同 body（同人格状态 + 同 issue → 同草稿正文）。 */
    const res2 = await postDraft(app, { repo: REPO, targetType: 'pull', targetNumber: 7 });
    assert.equal(res2.body.body, res.body.body, '相同输入相同人格状态 → 相同草稿正文（确定性可复现）');

    await app.close();
  });

  it('无相关记忆 → honest_offline（诚实降级，不编造 review）', async () => {
    /* 不 seed 任何相关记忆；issue 讲的主题数字人没学过 → 诚实说不知道，不编造。 */
    const readPort = fakeReadPort({
      listIssues: async (): Promise<GitHubIssue[]> => [
        { number: 99, title: '量子退火调度器', body: '关于量子退火任务调度的讨论', updatedAt: '2026-03-01T00:00:00Z', comments: 0 },
      ],
    });
    const app = await mountDraftGithub(os, { readPort });

    const res = await postDraft(app, { repo: REPO, targetType: 'issue', targetNumber: 99 });
    assert.equal(res.status, 200);
    assert.equal(res.body.kind, 'honest_offline', '没学过 → honest_offline（不编造）');
    assert.equal(res.body.groundedCount, 0, 'honest_offline 无 grounded 记忆');

    await app.close();
  });

  it('列草稿 + approve → status=approved（起草停 drafted；审批不触发任何 GitHub 写）', async () => {
    os.core.addMemory('semantic', '我听到：缓存键要包含租户维度避免串号', 0, 0.6);
    const readPort = fakeReadPort({
      listIssues: async (): Promise<GitHubIssue[]> => [
        { number: 5, title: '缓存键串号', body: '不同租户命中同一缓存键，缓存键该加租户维度', updatedAt: '2026-04-01T00:00:00Z', comments: 0 },
      ],
    });
    const app = await mountDraftGithub(os, { readPort });

    /* 起草：得到一条 drafted 态草稿。 */
    const draft = await postDraft(app, { repo: REPO, targetType: 'issue', targetNumber: 5 });
    assert.equal(draft.status, 200);
    const draftId = draft.body.draftId;

    /* 列草稿（status=drafted）：应含刚起草的这条，且其状态为 drafted（起草即停铁律）。 */
    const listRes = await app.inject({ method: 'GET', url: '/api/v1/companion/me/github-drafts?status=drafted' });
    assert.equal(listRes.statusCode, 200);
    const drafts = JSON.parse(listRes.body).data as Array<{ id: string; status: string }>;
    const found = drafts.find((d) => d.id === draftId);
    assert.ok(found, '列草稿应含刚起草的草稿');
    assert.equal(found.status, 'drafted', '起草即停：草稿停在 drafted，绝不自动发布');

    /* approve：只把状态置 approved（本 plan 不发布——端点结构上无 WritePort/无对外 POST）。 */
    const approveRes = await app.inject({ method: 'POST', url: `/api/v1/companion/me/github-drafts/${draftId}/approve` });
    assert.equal(approveRes.statusCode, 200, `approve 应 200，实际 ${approveRes.statusCode}：${approveRes.body}`);

    /* approve 后列 approved：草稿状态确已变 approved（仅状态变化，无任何 GitHub 写）。 */
    const approvedList = await app.inject({ method: 'GET', url: '/api/v1/companion/me/github-drafts?status=approved' });
    const approvedDrafts = JSON.parse(approvedList.body).data as Array<{ id: string; status: string }>;
    assert.ok(approvedDrafts.some((d) => d.id === draftId && d.status === 'approved'), 'approve 后草稿状态应为 approved');

    /* 已 approved 的草稿从 drafted 列表里消失（状态机保护）。 */
    const draftedAfter = await app.inject({ method: 'GET', url: '/api/v1/companion/me/github-drafts?status=drafted' });
    const draftedDraftsAfter = JSON.parse(draftedAfter.body).data as Array<{ id: string }>;
    assert.ok(!draftedDraftsAfter.some((d) => d.id === draftId), 'approve 后不再是 drafted 态');

    await app.close();
  });

  it('reject → status=rejected（人工驳回，同样不发布）', async () => {
    os.core.addMemory('semantic', '我听到：日志要脱敏后再落盘', 0, 0.6);
    const readPort = fakeReadPort({
      listIssues: async (): Promise<GitHubIssue[]> => [
        { number: 8, title: '日志脱敏', body: '日志里有明文密码，落盘前要脱敏', updatedAt: '2026-05-01T00:00:00Z', comments: 0 },
      ],
    });
    const app = await mountDraftGithub(os, { readPort });

    const draft = await postDraft(app, { repo: REPO, targetType: 'issue', targetNumber: 8 });
    const draftId = draft.body.draftId;

    const rejectRes = await app.inject({ method: 'POST', url: `/api/v1/companion/me/github-drafts/${draftId}/reject` });
    assert.equal(rejectRes.statusCode, 200, `reject 应 200，实际 ${rejectRes.statusCode}：${rejectRes.body}`);

    const rejectedList = await app.inject({ method: 'GET', url: '/api/v1/companion/me/github-drafts?status=rejected' });
    const rejectedDrafts = JSON.parse(rejectedList.body).data as Array<{ id: string; status: string }>;
    assert.ok(rejectedDrafts.some((d) => d.id === draftId && d.status === 'rejected'), 'reject 后草稿状态应为 rejected');

    await app.close();
  });

  it('绝不发布（行为不变量）：draft → approve → reject 全程对 api.github.com 零对外写请求（fetch-spy 守）', async () => {
    /*
     * 本 plan 核心安全命题「绝不发布」的**行为层**断言（补类型/结构守之外的运行时守）：
     * 无论起草、审批、驳回，端点/store/composer 都**不应**发起任何对 GitHub 的写请求（POST/PATCH/PUT）。
     * 结构守（无 WritePort）证的是「发不出」；本用例用 fetch-spy 证「运行时确实没发」——
     * 若 Plan 4 误把真实发布 fetch 接进 approve/reject 分支（回归本 plan 铁律），本用例立即变红。
     *
     * spy 抓的是**对 api.github.com（含 GHE host）的写方法**：注入的 fakeReadPort 不走网络（起草只读也是 mock），
     * 所以正常路径下对 github.com 的写请求恒为零；一旦有额外对外写（如注入的发布 fetch）就会被记录。
     */
    const originalFetch = globalThis.fetch;
    const githubWriteCalls: Array<{ url: string; method: string }> = [];
    /* monkey-patch globalThis.fetch：记录每次调用（url + method），对 api.github.com 的写方法单独归档。
     * 不实际发出请求——返回一个最小的 2xx Response，避免误触真网络 / 让被测代码继续跑。 */
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
      const isGithubHost = /(^|\/\/|\.)api\.github\.com(\/|$|:)/i.test(url) || /github\.com/i.test(url);
      const isWrite = method === 'POST' || method === 'PATCH' || method === 'PUT';
      if (isGithubHost && isWrite) {
        githubWriteCalls.push({ url, method });
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof globalThis.fetch;

    try {
      os.core.addMemory('semantic', '我听到：重试要带指数退避 + 抖动，避免惊群', 0, 0.6);
      const readPort = fakeReadPort({
        listIssues: async (): Promise<GitHubIssue[]> => [
          { number: 11, title: '重试风暴', body: '大量客户端同时重试导致惊群，重试该加退避', updatedAt: '2026-06-01T00:00:00Z', comments: 0 },
        ],
      });
      const app = await mountDraftGithub(os, { readPort });

      /* 起草：只读 + 本地存草稿，不该有任何对外写。 */
      const draft = await postDraft(app, { repo: REPO, targetType: 'issue', targetNumber: 11 });
      assert.equal(draft.status, 200, `起草应 200，实际 ${draft.status}`);
      const draftId = draft.body.draftId;

      /* approve：只改本地状态，不该触发任何 GitHub 写（本 plan 无 WritePort；Plan 4 才发布）。 */
      const approveRes = await app.inject({ method: 'POST', url: `/api/v1/companion/me/github-drafts/${draftId}/approve` });
      assert.equal(approveRes.statusCode, 200, `approve 应 200，实际 ${approveRes.statusCode}：${approveRes.body}`);

      /* 再起草一条走 reject 路径——reject 同样只改本地状态，不该有对外写。 */
      const draft2 = await postDraft(app, { repo: REPO, targetType: 'issue', targetNumber: 11 });
      assert.equal(draft2.status, 200);
      const rejectRes = await app.inject({ method: 'POST', url: `/api/v1/companion/me/github-drafts/${draft2.body.draftId}/reject` });
      assert.equal(rejectRes.statusCode, 200, `reject 应 200，实际 ${rejectRes.statusCode}：${rejectRes.body}`);

      /* 行为不变量：draft/approve/reject 全程对 api.github.com 的写请求（POST/PATCH/PUT）**零次**。 */
      assert.equal(
        githubWriteCalls.length, 0,
        `绝不发布铁律被破坏：检测到 ${githubWriteCalls.length} 次对 GitHub 的对外写请求 → ${JSON.stringify(githubWriteCalls)}`,
      );

      await app.close();
    } finally {
      /* 务必还原全局 fetch（无论断言/接口是否抛错），不污染其他用例与真实装配路径。 */
      globalThis.fetch = originalFetch;
    }
  });

  it('issue 号不存在 → 4xx（list+find 未命中）', async () => {
    /* ReadPort 列表里只有 42 号，请求 999 号 → find 未命中 → 明确 4xx。 */
    const readPort = fakeReadPort({
      listIssues: async (): Promise<GitHubIssue[]> => [
        { number: 42, title: '存在的 issue', body: '正文', updatedAt: '2026-01-10T00:00:00Z', comments: 0 },
      ],
    });
    const app = await mountDraftGithub(os, { readPort });

    const res = await postDraft(app, { repo: REPO, targetType: 'issue', targetNumber: 999 });
    assert.ok(res.status >= 400 && res.status < 500, `不存在的 issue 号应 4xx，实际 ${res.status}`);

    await app.close();
  });

  it('无凭据 → 明确 4xx（真实装配路径下本租户未连 GitHub）', async () => {
    /* 不注入 ReadPort → 端点走真实装配：从 credential store getApp。默认租户未存 App 凭据 → undefined。 */
    const config = loadConfig({
      rateLimit: { max: 10000, timeWindowMs: 60_000 },
      websocket: { enabled: false, heartbeatIntervalMs: 30_000 },
      jwt: { enabled: true, secret: JWT_SECRET, issuer: 'test' },
      encryption: { enabled: true, masterKey: randomBytes(32).toString('base64'), defaultKeyRef: 'master', keyring: {}, keyRotationIntervalDays: 90 },
    });
    const app = await createApp({ os, config });
    const reg = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email: 'gh-draft-nocred@test.com', password: 'password123' } });
    assert.equal(reg.statusCode, 201, reg.body);
    const auth = JSON.parse(reg.body).data as { accessToken: string; tenantId: string };
    const headers = { authorization: `Bearer ${auth.accessToken}`, 'x-tenant-id': auth.tenantId };

    const res = await app.inject({
      method: 'POST', url: '/api/v1/companion/me/draft-github-reply', headers,
      payload: { repo: REPO, targetType: 'issue', targetNumber: 1 },
    });
    assert.ok(res.statusCode >= 400 && res.statusCode < 500, `未连 GitHub 应 4xx，实际 ${res.statusCode}：${res.body}`);
    assert.match(res.body, /GitHub/, '错误应明确指出 GitHub 未连接');

    await app.close();
  });
});

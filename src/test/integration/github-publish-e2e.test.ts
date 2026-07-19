/**
 * 集成测试（E2E）：ChronoCompanion「把已批准的 GitHub 回复草稿真发出去」发布段
 * （GitHub 集成 Plan 4 Task 5——POST /github-drafts/:id/publish）。
 *
 * 把 Plan 4 发布段全部组件串成端到端一条真实链路，经 companion 端点驱动，证明本 plan 的三条铁律：
 *
 *   ① **不可降级人工审批门**：approved 草稿的真发**必须**经 ToolInvocationPipeline 的 confirmation
 *      gate（github 写工具 highRisk 恒真）。首次调用（无 confirmationToken）→ pipeline 返
 *      pending_confirmation + confirmationTokenId → 端点返回 pending，**此时 WritePort 零调用、
 *      草稿仍 approved 未 published、GitHub 未写**。人工带 token 二次确认才真发——发布权不因任何
 *      参数降级，人始终在环里。
 *
 *   ② **原子防重复**：真发前 `store.claimForPublish` 原子 CAS approved→published（`WHERE
 *      status='approved'`）。同一草稿的真实 GitHub 写**至多发生一次**——重复 publish 已 published
 *      的草稿，第二次 claimForPublish 返 undefined → 端点 4xx，WritePort 不再被调。
 *
 *   ③ **零-LLM**：发布是网络动作，草稿内容 Plan 3 起草时已确定；端点全程不改草稿正文、不调 LLM。
 *
 * 测试策略：用**真** tenantOS + **真** ToolInvocationPipeline（真 ToolRegistry 注册**真**
 * GithubCommentTool/GithubReviewTool + 真 ConfirmationTokenStore + 真 ToolPermissionService/
 * AgencyAuthorizationService，全走 os.getDatabase()），只把**最外层的 GitHubWritePort 换成 spy**
 * （记录调用次数 + 参数，不走真网络）。这样审批门/原子 claim/token 一次性绑定全是真实链路，
 * 只有「对 GitHub 发 POST」这一步被 spy 拦下——审批门是真的、防重复是真的。
 *
 * 全部用例走 pending(200)/published(200)/4xx 正常路径（不制造 500，避免 node --test teardown 挂）。
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { SilentLogger } from '../../utils/logger.js';
import { TestClock } from '../../utils/clock.js';
import { registerCompanionDraftGithubRoutes } from '../../server/routes/companion/draft-github-reply.js';
import { GithubDraftStore } from '../../storage/github-draft-store.js';
import { ToolRegistry } from '../../agent/tool-registry.js';
import { ToolInvocationPipeline } from '../../agent/tool-invocation-pipeline.js';
import { ToolPermissionService } from '../../agent/tool-permission-service.js';
import { AgencyAuthorizationService } from '../../agent/agency-authorization-service.js';
import { ConfirmationTokenStore } from '../../conversation/confirmation-token-store.js';
import { GithubCommentTool } from '../../agent/tools/github-comment-tool.js';
import { GithubReviewTool } from '../../agent/tools/github-review-tool.js';
import type {
  GitHubWritePort, GitHubWriteResult,
} from '../../integrations/github/github-write-port.js';

const REPO = 'acme/widgets';
const PERSONA = 'default'; /* companion 单 persona core-self（与 chat/draft 一致）。 */

/**
 * WritePort spy：记录每次 createIssueComment/createReview（次数 + 参数），返回固定 {id, htmlUrl}。
 * 结构上只有两个写方法——真发这一步被它拦下，不走真网络；但审批门/claim/token 全是真实链路。
 */
interface WritePortSpy extends GitHubWritePort {
  readonly comments: Array<{ repo: string; issueNumber: number; body: string }>;
  readonly reviews: Array<{ repo: string; prNumber: number; body: string; event: string }>;
  calls(): number;
}

function makeWritePortSpy(): WritePortSpy {
  const comments: Array<{ repo: string; issueNumber: number; body: string }> = [];
  const reviews: Array<{ repo: string; prNumber: number; body: string; event: string }> = [];
  return {
    comments,
    reviews,
    calls: () => comments.length + reviews.length,
    async createIssueComment(repo, issueNumber, body): Promise<GitHubWriteResult> {
      comments.push({ repo, issueNumber, body });
      return { id: 98765, htmlUrl: `https://github.com/${repo}/issues/${issueNumber}#issuecomment-98765` };
    },
    async createReview(repo, prNumber, body, event): Promise<GitHubWriteResult> {
      reviews.push({ repo, prNumber, body, event });
      return { id: 54321, htmlUrl: `https://github.com/${repo}/pull/${prNumber}#pullrequestreview-54321` };
    },
  };
}

/** 构造真 pipeline（真 registry + 真 github 写工具 + WritePort spy resolver）。 */
function makePipeline(os: ChronoSynthOS, spy: GitHubWritePort): ToolInvocationPipeline {
  const db = os.getDatabase();
  const registry = new ToolRegistry();
  const resolveWritePort = (): GitHubWritePort => spy;
  registry.register(new GithubCommentTool(resolveWritePort));
  registry.register(new GithubReviewTool(resolveWritePort));
  registry.freeze();
  return new ToolInvocationPipeline({
    tx: db,
    registry,
    logger: new SilentLogger(),
    permissions: new ToolPermissionService(db),
    authorizations: new AgencyAuthorizationService(db),
    confirmationStore: new ConfirmationTokenStore(db),
  });
}

/** 授权 companion persona 使用 github 写工具（否则 pipeline 在 authorization/permission 步就拒）。 */
function grantGithubWriteTools(os: ChronoSynthOS): void {
  const db = os.getDatabase();
  new AgencyAuthorizationService(db).create({
    tenantId: 'default',
    personaId: PERSONA,
    principalUserId: 'user_1',
    scope: 'communication',
    scopeDescription: 'test：允许 companion 发布 GitHub 回复',
    allowedTools: ['github.comment', 'github.review'],
  });
  const perms = new ToolPermissionService(db);
  perms.grant({ tenantId: 'default', personaId: PERSONA, toolId: 'github.comment', scope: 'execute', constraints: {}, grantedBy: 'user_1' });
  perms.grant({ tenantId: 'default', personaId: PERSONA, toolId: 'github.review', scope: 'execute', constraints: {}, grantedBy: 'user_1' });
}

/** seed 一条草稿并推进到指定状态（drafted / approved），返回 draftId。 */
function seedDraft(
  os: ChronoSynthOS,
  targetType: 'issue' | 'pull',
  targetNumber: number,
  status: 'drafted' | 'approved',
): string {
  const store = new GithubDraftStore(os.getDatabase(), 'default');
  const now = os.getClock().now();
  const id = store.createDraft(PERSONA, REPO, targetType, targetNumber, '这是一条已起草的回复正文（Plan 3 确定性起草产物）。', now);
  if (status === 'approved') {
    const ok = store.setStatus(PERSONA, id, 'approved', now);
    assert.equal(ok, true, 'seed：应能把 drafted 推进 approved');
  }
  return id;
}

/** 本地挂 draft-github-reply 端点（含 publish），传入真 pipeline。 */
async function mount(os: ChronoSynthOS, pipeline: ToolInvocationPipeline): Promise<FastifyInstance> {
  const fastify = (await import('fastify')).default;
  const local = fastify();
  local.addHook('onRequest', async (req) => {
    (req as { user?: unknown }).user = { sub: 'user_1', planId: 'free', role: 'user' };
    (req as { tenantId?: string }).tenantId = 'default';
  });
  registerCompanionDraftGithubRoutes(local, os, undefined, undefined, undefined, undefined, pipeline);
  await local.ready();
  return local;
}

interface PublishResponse {
  status: string;
  confirmationTokenId?: string;
  githubRef?: string;
  htmlUrl?: string;
}

async function publish(
  app: FastifyInstance,
  id: string,
  confirmationToken?: string,
): Promise<{ status: number; body: PublishResponse; raw: string }> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/companion/me/github-drafts/${id}/publish`,
    payload: confirmationToken ? { confirmationToken } : {},
  });
  const body = res.statusCode === 200 ? (JSON.parse(res.body).data as PublishResponse) : ({} as PublishResponse);
  return { status: res.statusCode, body, raw: res.body };
}

/** 直读草稿行（断言 status / github_ref）。 */
function readDraft(os: ChronoSynthOS, id: string) {
  return new GithubDraftStore(os.getDatabase(), 'default').getDraft(PERSONA, id);
}

describe('ChronoCompanion GitHub 发布 E2E（approved → pipeline highRisk → 不可降级人工确认 → 真发 + 原子防重复）', () => {
  let os: ChronoSynthOS;

  beforeEach(() => {
    os = new ChronoSynthOS({ clock: new TestClock(1000), logger: new SilentLogger() });
    os.start();
    grantGithubWriteTools(os);
  });
  afterEach(() => os.close());

  it('无 confirmationToken → pending_confirmation（不可降级门核心：WritePort 零调用、草稿仍 approved）', async () => {
    const spy = makeWritePortSpy();
    const app = await mount(os, makePipeline(os, spy));
    const id = seedDraft(os, 'issue', 42, 'approved');

    const res = await publish(app, id); /* 无 token */
    assert.equal(res.status, 200, `无 token 应返 pending(200)，实际 ${res.status}：${res.raw}`);
    assert.equal(res.body.status, 'pending_confirmation', '无 token 必返 pending_confirmation（不可降级门）');
    assert.ok(
      typeof res.body.confirmationTokenId === 'string' && res.body.confirmationTokenId.length > 0,
      'pending 应带非空 confirmationTokenId（人工凭此二次确认）',
    );

    /* 不可降级门铁律：GitHub 未写、草稿状态未变。 */
    assert.equal(spy.calls(), 0, '无 token 时 WritePort 必须零调用（GitHub 未写）');
    assert.equal(readDraft(os, id)?.status, 'approved', '无 token 时草稿仍停在 approved（未被误标 published）');

    await app.close();
  });

  it('带正确 token → 真发布（issue → github.comment：WritePort 被调、草稿 published、返 htmlUrl + github_ref）', async () => {
    const spy = makeWritePortSpy();
    const app = await mount(os, makePipeline(os, spy));
    const id = seedDraft(os, 'issue', 42, 'approved');

    /* 首次探测拿 pending token（不发）。 */
    const pending = await publish(app, id);
    assert.equal(pending.body.status, 'pending_confirmation');
    const token = pending.body.confirmationTokenId!;
    assert.equal(spy.calls(), 0, '探测阶段仍零调用');

    /* 二次带 token 真发。 */
    const published = await publish(app, id, token);
    assert.equal(published.status, 200, `带正确 token 应真发 200，实际 ${published.status}：${published.raw}`);
    assert.equal(published.body.status, 'published', '带 token 真发 → published');
    assert.ok(typeof published.body.htmlUrl === 'string' && published.body.htmlUrl!.includes('github.com'), '应返回 GitHub htmlUrl');
    assert.equal(published.body.githubRef, '98765', 'githubRef 取自 WritePort 返回的 comment id');

    /* WritePort 恰被调一次，参数落到 issue 写路径（issueNumber）。 */
    assert.equal(spy.calls(), 1, '真发恰调 WritePort 一次');
    assert.equal(spy.comments.length, 1, 'issue → createIssueComment');
    assert.equal(spy.comments[0].issueNumber, 42, 'issueNumber 取自草稿 target_number');
    assert.equal(spy.comments[0].repo, REPO, 'repo 取自草稿');

    /* 草稿终态 published + github_ref 回填（发布审计佐证）。 */
    const row = readDraft(os, id);
    assert.equal(row?.status, 'published', '真发后草稿终态 published');
    assert.equal(row?.github_ref, '98765', '发布成功回填 github_ref');

    await app.close();
  });

  it('带正确 token → 真发布（pull → github.review：走 createReview + prNumber + event=COMMENT）', async () => {
    const spy = makeWritePortSpy();
    const app = await mount(os, makePipeline(os, spy));
    const id = seedDraft(os, 'pull', 7, 'approved');

    const pending = await publish(app, id);
    assert.equal(pending.body.status, 'pending_confirmation');
    const published = await publish(app, id, pending.body.confirmationTokenId!);
    assert.equal(published.status, 200, published.raw);
    assert.equal(published.body.status, 'published');
    assert.equal(published.body.githubRef, '54321');

    assert.equal(spy.reviews.length, 1, 'pull → createReview');
    assert.equal(spy.reviews[0].prNumber, 7, 'prNumber 取自草稿 target_number');
    assert.equal(spy.reviews[0].event, 'COMMENT', 'review event 首版锁死 COMMENT');
    assert.equal(spy.comments.length, 0, 'pull 不走 comment 路径');

    await app.close();
  });

  it('非 approved（drafted）草稿 publish → 4xx（只 approved 可发；探测阶段就拒，不 pending）', async () => {
    const spy = makeWritePortSpy();
    const app = await mount(os, makePipeline(os, spy));
    const id = seedDraft(os, 'issue', 42, 'drafted'); /* 未 approve */

    const res = await publish(app, id); /* 无 token */
    assert.ok(res.status >= 400 && res.status < 500, `drafted 草稿发布应 4xx，实际 ${res.status}：${res.raw}`);
    assert.equal(spy.calls(), 0, 'drafted 不发布 → WritePort 零调用');
    assert.equal(readDraft(os, id)?.status, 'drafted', 'drafted 草稿状态不变');

    await app.close();
  });

  it('重复 publish 已 published 草稿 → 4xx（原子 CAS 防重复：第二次 claimForPublish undefined）', async () => {
    const spy = makeWritePortSpy();
    const app = await mount(os, makePipeline(os, spy));
    const id = seedDraft(os, 'issue', 42, 'approved');

    /* 第一轮：探测 → 带 token 真发 → published。 */
    const token1 = (await publish(app, id)).body.confirmationTokenId!;
    const first = await publish(app, id, token1);
    assert.equal(first.body.status, 'published', '第一次发布应成功');
    assert.equal(spy.calls(), 1, '第一次真发调 WritePort 一次');

    /* 第二轮（重复发同一草稿）：
     *  a) 无 token 探测：草稿已 published ≠ approved → 探测阶段 4xx（不再 pending）。 */
    const reprobe = await publish(app, id);
    assert.ok(reprobe.status >= 400 && reprobe.status < 500, `已 published 草稿重探应 4xx，实际 ${reprobe.status}：${reprobe.raw}`);

    /*  b) 直接带（伪造/旧）token 走真发路径：claimForPublish CAS 返 undefined → 4xx，WritePort 不再被调。 */
    const republish = await publish(app, id, 'cct_fake-or-stale-token');
    assert.ok(republish.status >= 400 && republish.status < 500, `重复发布应 4xx，实际 ${republish.status}：${republish.raw}`);

    /* 核心不变量：无论重探/重发，真实 GitHub 写至多一次（仍为 1）。 */
    assert.equal(spy.calls(), 1, '原子防重复：真实 GitHub 写至多一次');
    assert.equal(readDraft(os, id)?.github_ref, '98765', 'github_ref 仍是第一次发布的 id（未被覆盖/重发）');

    await app.close();
  });

  it('CAS 独立守卫（双有效 token）→ 第二个有效 token 真发路径被原子 CAS 单独挡下（WritePort 恰 1 次）', async () => {
    /* ── 专测 CAS 隔离守卫，而非 token 门兜底 ──
     * 上一条「重复 publish 已 published 草稿」用例的第二次写，是被 **token 门** 兜底挡下的：
     * 已 published 草稿重探（status≠approved）在探测阶段 4xx 拿不到新 token，随后只能用 **伪造/失效**
     * token 去撞真发路径——token 门先失败，CAS 从没被独立验证过（把端点 CAS 去掉，那条用例仍全绿）。
     *
     * 本用例把 CAS 单独隔离出来验证：对**同一条 approved 草稿探测两次**，各签发一个**独立有效**
     * token A、B（探测不 claim，草稿始终 approved，两 token 绑同一 args-hash、均未消费、均未过期）。
     * 带 A 真发成功（approved→published）；再带 **仍有效、未消费** 的 B 走真发路径——此时 **token 门
     * 挡不住**（B consume 本会通过），因 `claimForPublish` 紧邻在 `pipeline.invoke` 之前，草稿已
     * published、CAS `WHERE status='approved'` 返 undefined → 4xx，真发路径在触达 pipeline/token/写侧
     * **之前**就被斩断。故此路的**唯一防线是 CAS**——WritePort 只应被调恰好 1 次（不是 2 次）。 */
    const spy = makeWritePortSpy();
    const app = await mount(os, makePipeline(os, spy));
    const id = seedDraft(os, 'issue', 42, 'approved');

    /* 两次无 token 探测：草稿仍 approved，各签发一个独立有效 token（探测不 claim、不发）。 */
    const probeA = await publish(app, id);
    assert.equal(probeA.body.status, 'pending_confirmation', '第一次探测应返 pending + tokenA');
    const tokenA = probeA.body.confirmationTokenId!;
    const probeB = await publish(app, id);
    assert.equal(probeB.body.status, 'pending_confirmation', '第二次探测应返 pending + tokenB');
    const tokenB = probeB.body.confirmationTokenId!;

    /* 两 token 确为**独立**签发（不同 id），且探测阶段 GitHub 零写、草稿仍 approved（未被误占位）。 */
    assert.notEqual(tokenA, tokenB, '两次探测应签发两个独立 token（非同一 token）');
    assert.equal(spy.calls(), 0, '两次探测阶段 WritePort 零调用（探测不发）');
    assert.equal(readDraft(os, id)?.status, 'approved', '两次探测后草稿仍 approved（探测不 claim）');

    /* 带 token A 真发：claimForPublish CAS approved→published 成功 → 真发（spy +1）。 */
    const withA = await publish(app, id, tokenA);
    assert.equal(withA.status, 200, `带 token A 应真发 200，实际 ${withA.status}：${withA.raw}`);
    assert.equal(withA.body.status, 'published', '带 token A 真发 → published');
    assert.equal(spy.calls(), 1, '带 token A 真发恰调 WritePort 一次');
    assert.equal(readDraft(os, id)?.status, 'published', 'token A 真发后草稿终态 published');

    /* 带**仍有效**的 token B 走真发路径：token 门本会通过（B 未消费/未过期/args 匹配），
     * 但 claimForPublish 先跑——草稿已 published、CAS 返 undefined → 4xx。CAS 是此路唯一防线。 */
    const withB = await publish(app, id, tokenB);
    assert.ok(
      withB.status >= 400 && withB.status < 500,
      `双有效 token 攻击：第二个有效 token B 应被 CAS 单独挡下（4xx），实际 ${withB.status}：${withB.raw}`,
    );

    /* CAS 独立守卫核心断言：真实 GitHub 写**恰好 1 次**（不是 2 次）——第二个有效 token 未穿透。 */
    assert.equal(spy.calls(), 1, 'CAS 独立守卫：双有效 token 下真实 GitHub 写恰好一次（非两次）');
    assert.equal(readDraft(os, id)?.status, 'published', '双有效 token 后草稿终态仍 published（不重复写）');
    assert.equal(readDraft(os, id)?.github_ref, '98765', 'github_ref 仍是 token A 那次发布的 id（未被 token B 覆盖）');

    await app.close();
  });

  it('无凭据/未授权 → 4xx（未 grant github 写工具 → pipeline denied_authorization）', async () => {
    /* 新起一个未授权的 OS（beforeEach 的 grant 不生效——这里自建纯净 OS）。 */
    const bare = new ChronoSynthOS({ clock: new TestClock(1000), logger: new SilentLogger() });
    bare.start();
    try {
      const spy = makeWritePortSpy();
      const app = await mount(bare, makePipeline(bare, spy));
      const id = seedDraft(bare, 'issue', 42, 'approved');

      const res = await publish(app, id); /* 无授权 → 无 token 探测即被 pipeline 拒 */
      assert.ok(res.status >= 400 && res.status < 500, `未授权发布应 4xx，实际 ${res.status}：${res.raw}`);
      assert.equal(spy.calls(), 0, '未授权 → WritePort 零调用');
      assert.equal(readDraft(bare, id)?.status, 'approved', '未授权时草稿仍 approved（未误标 published）');

      await app.close();
    } finally {
      bare.close();
    }
  });
});

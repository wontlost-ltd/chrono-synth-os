/**
 * 集成测试：GitHub webhook 接收器（GitHub 集成 Plan 3 Task 6——可选入站入口）。
 *
 * webhook 是**系统入站**（GitHub 主动发来 issue/PR opened 事件），非用户动作，故挂在
 * `integrations/github` 前缀下、公网无 JWT/API-Key（由 HMAC 签名保护，照 Stripe webhook 纪律）。
 * 本 plan 的铁律在 webhook 侧同样成立：**只起草停 drafted，绝不发布**——接收器结构上无 WritePort、
 * 无任何对外写通道；起草是零-LLM 确定性拼装（composeGithubReply）+ 纯图遍历检索记忆。
 *
 * 本测试用**构造带真实 HMAC-SHA256 签名的 payload** 驱动（不走公网），证明四条安全命题：
 *
 *   ① **正确签名的 issues.opened → 起草草稿创建（drafted）**：payload 携带 opened issue 的
 *      标题/正文 → 反查租户（installation.id → tenant）→ 取该租户 webhook secret 验签 → 幂等 claim
 *      → 确定性检索先 seed 的已学记忆 → composeGithubReply 起草 → store.createDraft 存一条 **drafted**
 *      态草稿。断言 200 + 草稿确实落库、状态 drafted、grounded 到相关记忆。
 *
 *   ② **错误签名 → 401 拒绝，不进流程（安全命题·变异关键）**：签名头对不上 secret 算出的期望值 →
 *      **401 直接拒**，绝不反查后续、绝不起草。断言 401 + 草稿数**零增长**（变异守：若签名校验被绕过，
 *      本用例的「草稿零增长」立即变红）。
 *
 *   ③ **重投同 X-GitHub-Delivery → 幂等，不重复起草**：同一 deliveryId 第二次投递 →
 *      claimWebhookEvent 返 false → 200 直接返，**不重复起草**。断言两次 200 但草稿只增 1 条。
 *
 *   ④ **installation 反查不到租户 → fail-closed 拒绝**：payload 里 installation.id 在本地无映射 →
 *      resolveTenantByInstallation 返 undefined → **拒绝**（不猜租户、不进流程）。断言 4xx + 草稿零增长。
 *
 *   ⑤（补）**非 opened 事件 → 忽略 200 不起草**：合法签名 + 反查命中 + 幂等，但 action 非 opened
 *      （如 closed）→ 200 忽略、不起草。断言 200 + 草稿零增长。
 *
 * 测试策略：seed **真** GithubAppCredentialStore（storeApp 配 webhook secret + upsertInstallation 建
 * installation→tenant 映射），本地挂 webhook 路由（不走公网），用 Node crypto.createHmac **真** 签名。
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { createApp } from '../../server/index.js';
import { loadConfig } from '../../config/schema.js';
import { SilentLogger } from '../../utils/logger.js';
import { TestClock } from '../../utils/clock.js';
import { tryByokEncryption } from '../../storage/llm-credential-store.js';
import { GithubAppCredentialStore } from '../../storage/github-app-credential-store.js';
import { GithubDraftStore } from '../../storage/github-draft-store.js';
import { registerGithubWebhookRoutes } from '../../server/routes/github-webhook.js';

const WEBHOOK_SECRET = 'test-webhook-secret-supersecret-1234567890';
const INSTALLATION_ID = '42424242';
const GITHUB_HOST = 'github.com';
const WEBHOOK_URL = '/api/v1/integrations/github/webhook';
/** companion 单 persona core-self 的 personaId（与起草端点一致），草稿按 (tenant, persona) 隔离读。 */
const COMPANION_PERSONA_ID = 'default';

/** 用真实 HMAC-SHA256 算 X-Hub-Signature-256（GitHub 官方格式：`sha256=<hex>`）。 */
function signGithub(rawBody: string, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
}

/** issues.opened payload（携带 opened issue 的标题/正文 + installation.id + repository）。 */
function issuesOpenedPayload(opts: {
  installationId?: string;
  action?: string;
  number?: number;
  title?: string;
  body?: string;
}): string {
  return JSON.stringify({
    action: opts.action ?? 'opened',
    issue: {
      number: opts.number ?? 7,
      title: opts.title ?? 'GraphQL 缓存键算错导致命中率骤降',
      body: opts.body ?? '高并发下 GraphQL 的缓存键计算错误，命中率骤降，请问怎么修？',
    },
    repository: { full_name: 'acme/widgets' },
    installation: { id: opts.installationId ?? INSTALLATION_ID },
  });
}

/**
 * 本地挂 webhook 路由（不走公网），返回 fastify 实例。encryption 用真 FieldEncryption
 * （GithubAppCredentialStore 强制启用加密）；不加任何鉴权 stub——webhook 是公网入站，靠 HMAC 保护。
 */
async function mountWebhook(os: ChronoSynthOS, config: ReturnType<typeof loadConfig>): Promise<FastifyInstance> {
  const fastify = (await import('fastify')).default;
  const local = fastify();
  registerGithubWebhookRoutes(local, os, undefined, undefined, config);
  await local.ready();
  return local;
}

/** 直接投递一条带签名的 webhook（自算签名，除非 sigOverride 显式给错签名）。 */
async function deliver(
  app: FastifyInstance,
  rawBody: string,
  opts: { event?: string; deliveryId?: string; sig?: string } = {},
): Promise<{ status: number }> {
  const res = await app.inject({
    method: 'POST',
    url: WEBHOOK_URL,
    headers: {
      'content-type': 'application/json',
      'x-github-event': opts.event ?? 'issues',
      'x-github-delivery': opts.deliveryId ?? randomBytes(8).toString('hex'),
      'x-hub-signature-256': opts.sig ?? signGithub(rawBody, WEBHOOK_SECRET),
    },
    payload: rawBody,
  });
  return { status: res.statusCode };
}

describe('GitHub webhook 接收器（HMAC 验签 + 反查 fail-closed + 幂等 + 不发布）', () => {
  let os: ChronoSynthOS;
  let config: ReturnType<typeof loadConfig>;

  /** 用真 FieldEncryption seed App 凭据（webhook secret）+ installation→tenant 映射（tenant='default'）。 */
  function seedGithubApp(): void {
    const encryption = tryByokEncryption(config.encryption);
    assert.ok(encryption, '测试需启用凭据加密（GithubAppCredentialStore 强制）');
    const credStore = new GithubAppCredentialStore(os.getDatabase(), encryption, 'default');
    credStore.storeApp('123', '-----BEGIN KEY-----\nx\n-----END KEY-----', WEBHOOK_SECRET, null, null, 1000);
    credStore.upsertInstallation(INSTALLATION_ID, GITHUB_HOST, 'acme', null, 1000);
  }

  /** 读 default 租户 default persona 的草稿总数（用于「草稿零增长/增 1」断言）。 */
  function draftCount(): number {
    const store = new GithubDraftStore(os.getDatabase(), 'default');
    return store.listDrafts(COMPANION_PERSONA_ID).length;
  }

  beforeEach(() => {
    os = new ChronoSynthOS({ clock: new TestClock(1000), logger: new SilentLogger() });
    os.start();
    config = loadConfig({
      encryption: {
        enabled: true,
        masterKey: randomBytes(32).toString('base64'),
        defaultKeyRef: 'master',
        keyring: {},
        keyRotationIntervalDays: 90,
      },
    });
    seedGithubApp();
  });
  afterEach(() => os.close());

  it('正确 X-Hub-Signature-256 的 issues.opened → 起草草稿创建（drafted）', async () => {
    /* 先 seed 一条已学记忆，让 issue 标题里的名词（GraphQL/缓存）能命中 → knowledge_grounded 起草。 */
    os.core.addMemory('semantic', '我听到：GraphQL 的 dataloader 缓存键计算错误会导致命中率骤降，应重算缓存键策略', 0, 0.7);
    os.core.narrative.set('我是一个务实的工程助手，乐于把学过的经验讲清楚。');

    const app = await mountWebhook(os, config);
    const before = draftCount();
    const raw = issuesOpenedPayload({});
    const res = await deliver(app, raw, { event: 'issues' });
    assert.equal(res.status, 200, `正确签名的 issues.opened 应 200，实际 ${res.status}`);

    /* 草稿确实落库、+1 条，且状态钉死 drafted（起草即停铁律），呼应 issue 具体名词。 */
    const store = new GithubDraftStore(os.getDatabase(), 'default');
    const drafts = store.listDrafts(COMPANION_PERSONA_ID);
    assert.equal(drafts.length, before + 1, 'issues.opened 应起草恰好 1 条草稿');
    assert.equal(drafts[0].status, 'drafted', '起草即停：草稿停在 drafted，绝不自动发布');
    assert.match(drafts[0].draft_body, /GraphQL/i, '草稿应呼应 issue 标题里的具体名词（GraphQL）');

    await app.close();
  });

  it('错误签名 → 401 拒绝，不起草（安全命题·变异关键）', async () => {
    const app = await mountWebhook(os, config);
    const before = draftCount();
    const raw = issuesOpenedPayload({});
    /* 用一个格式正确但 secret 错的签名（对同 body 用不同 secret 签）——长度相同、值不同。 */
    const wrongSig = signGithub(raw, 'this-is-the-wrong-secret-000000000000000000');
    const res = await deliver(app, raw, { event: 'issues', sig: wrongSig });
    assert.equal(res.status, 401, `错误签名应 401，实际 ${res.status}`);

    /* 变异守：签名校验若被绕过则会起草——断言草稿零增长。 */
    assert.equal(draftCount(), before, '错误签名绝不进流程：草稿零增长');

    await app.close();
  });

  it('重投同 X-GitHub-Delivery → 幂等，不重复起草', async () => {
    os.core.addMemory('semantic', '我听到：重试要带指数退避 + 抖动，避免惊群', 0, 0.6);
    const app = await mountWebhook(os, config);
    const before = draftCount();
    const raw = issuesOpenedPayload({ number: 11, title: '重试风暴', body: '大量客户端同时重试导致惊群' });
    const deliveryId = 'delivery-fixed-abc123';

    const first = await deliver(app, raw, { event: 'issues', deliveryId });
    assert.equal(first.status, 200, '首次投递应 200 + 起草');
    const afterFirst = draftCount();
    assert.equal(afterFirst, before + 1, '首次投递起草 1 条');

    /* 同 deliveryId 重投：claimWebhookEvent=false → 200 直接返、不重复起草。 */
    const second = await deliver(app, raw, { event: 'issues', deliveryId });
    assert.equal(second.status, 200, '重投应 200（幂等直接返）');
    assert.equal(draftCount(), afterFirst, '重投同 delivery_id 不重复起草（草稿数不变）');

    await app.close();
  });

  it('installation 反查不到租户 → fail-closed 拒绝', async () => {
    const app = await mountWebhook(os, config);
    const before = draftCount();
    /* installation.id 在本地无映射（未 upsertInstallation 这个 id）→ 反查 undefined → 拒。
     * 用**该未知 installation 对应的 secret** 签名亦无用——反查在前，租户未知就无从取 secret 验签。 */
    const raw = issuesOpenedPayload({ installationId: '99999999' });
    /* 签名用真 secret 签（证明拒绝发生在反查阶段，而非签名阶段）。 */
    const res = await deliver(app, raw, { event: 'issues' });
    assert.ok(res.status >= 400 && res.status < 500, `反查不到租户应 4xx，实际 ${res.status}`);
    assert.equal(draftCount(), before, '反查失败绝不进流程：草稿零增长');

    await app.close();
  });

  it('非 opened 事件 → 忽略 200 不起草', async () => {
    const app = await mountWebhook(os, config);
    const before = draftCount();
    /* 合法签名 + 反查命中 + 幂等，但 action=closed（非 opened）→ 忽略、不起草。 */
    const raw = issuesOpenedPayload({ action: 'closed' });
    const res = await deliver(app, raw, { event: 'issues' });
    assert.equal(res.status, 200, `非 opened 事件应 200 忽略，实际 ${res.status}`);
    assert.equal(draftCount(), before, '非 opened 事件不起草：草稿零增长');

    await app.close();
  });

  /* 事件驱动学习（低延迟摄入）：与起草分支**并联**——起草只认 opened，学习覆盖讨论演进
   * 全过程。异步入队而非同步学：perceive 要调 LLM 老师（1-3 秒），同步会逼近 GitHub
   * ~10 秒 webhook 超时。 */
  describe('学习入队分支（事件驱动低延迟摄入）', () => {
    it('issue_comment 事件 → 入队 github-learn 任务并返回 200（携带反查出的租户）', async () => {
      const app = await mountWebhook(os, config);

      const raw = JSON.stringify({
        action: 'created',
        installation: { id: INSTALLATION_ID },
        repository: { full_name: 'acme/widgets' },
        issue: { number: 42, title: '登录报错', body: '正文' },
      });
      const res = await deliver(app, raw, { event: 'issue_comment' });

      assert.equal(res.status, 200, 'webhook 应快速返回 200（不同步学，防超时）');

      const queued = os.queue.dequeue();
      assert.ok(queued, '应入队一条学习任务');
      assert.equal(queued.type, 'github-learn');
      /* 安全不变量：任务须携带 webhook 反查出的租户，供 handler 装配 ReadPort。 */
      assert.equal(queued.tenantId, 'default', '任务须携带反查出的租户');
      assert.deepEqual(JSON.parse(queued.payload), { repo: 'acme/widgets', resourceType: 'issues' });

      await app.close();
    });

    it('push 事件 → 不入队（降频聚合，交轮转 worker 批量学）', async () => {
      const app = await mountWebhook(os, config);

      const raw = JSON.stringify({
        installation: { id: INSTALLATION_ID },
        repository: { full_name: 'acme/widgets' },
      });
      const res = await deliver(app, raw, { event: 'push' });

      assert.equal(res.status, 200);
      assert.equal(os.queue.dequeue(), undefined, 'push 不应入队（避免逐次调老师烧额度）');

      await app.close();
    });

    it('discussion 事件 → 不入队（ReadPort 无 GraphQL 支持，入队必败）', async () => {
      const app = await mountWebhook(os, config);

      const raw = JSON.stringify({
        action: 'created',
        installation: { id: INSTALLATION_ID },
        repository: { full_name: 'acme/widgets' },
      });
      const res = await deliver(app, raw, { event: 'discussion' });

      assert.equal(res.status, 200);
      assert.equal(os.queue.dequeue(), undefined, 'discussion 不入队');

      await app.close();
    });

    it('issues opened 事件 → 既起草**又**入队学习（两分支并联，互不干扰）', async () => {
      const app = await mountWebhook(os, config);
      const before = draftCount();

      const raw = issuesOpenedPayload({ action: 'opened' });
      const res = await deliver(app, raw, { event: 'issues' });

      assert.equal(res.status, 200);
      assert.equal(draftCount(), before + 1, '起草分支照常工作（零变更）');
      const queued = os.queue.dequeue();
      assert.ok(queued, '学习分支并联入队');
      assert.equal(queued.type, 'github-learn');

      await app.close();
    });
  });

  /* installation 生命周期同步（安装入口产品化）：装/卸/暂停/改授权经 webhook 自动跟上，
   * 使 github_installations 表真实反映 GitHub 侧状态。 */
  describe('installation 生命周期事件', () => {
    /** 造本租户凭据 store（seedGithubApp 已建 App 凭据 + installation 映射）。 */
    function credStore(): GithubAppCredentialStore {
      const enc = tryByokEncryption(config.encryption);
      assert.ok(enc, '测试需启用凭据加密');
      return new GithubAppCredentialStore(os.getDatabase(), enc, 'default');
    }

    /** 直查 suspended_at 列。 */
    function readSuspended(): number | null {
      const row = os.getDatabase().prepare<{ suspended_at: number | null }>(
        'SELECT suspended_at FROM github_installations WHERE github_host=? AND installation_id=?',
      ).get(GITHUB_HOST, INSTALLATION_ID);
      return row?.suspended_at ?? null;
    }

    it('installation.deleted → 映射删除（卸载即停学的端到端证明）', async () => {
      const app = await mountWebhook(os, config);
      assert.ok(credStore().resolveTenantByInstallation(GITHUB_HOST, INSTALLATION_ID), '删前映射存在');

      const raw = JSON.stringify({ action: 'deleted', installation: { id: INSTALLATION_ID } });
      const res = await deliver(app, raw, { event: 'installation' });

      assert.equal(res.status, 200);
      assert.equal(
        credStore().resolveTenantByInstallation(GITHUB_HOST, INSTALLATION_ID), undefined,
        '卸载后映射应删除——后续 ReadPort 装配即返 no-installation，学习自动停',
      );

      await app.close();
    });

    it('installation.suspend → suspended_at 置位；unsuspend → 清除', async () => {
      const app = await mountWebhook(os, config);

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
});

/**
 * jwt 豁免精确性测试（GitHub 集成 Plan 3 遗留 Low → Plan 4 结构守护）。
 *
 * `isPublicPath`（src/server/plugins/jwt-auth.ts）对 GitHub webhook 的豁免是**精确等值匹配**：
 *   `path === '/api/v1/integrations/github/webhook'`
 * ——只有这个确切路径无 JWT（由 HMAC-SHA256 签名 + 反查租户 fail-closed 保护），
 * `/api/v1/integrations/github/` 前缀下的**其它任何路径仍需鉴权**。
 *
 * 风险：若未来有人图省事把豁免改成 `path.startsWith('/api/v1/integrations/github')`（宽前缀），
 * 就会把该前缀下的 highRisk 发布相关端点一并变成免鉴权公网可打——静默暴露发布通道。
 * 本测试用 jwt.enabled=true + auth（API-Key）禁用的配置，让 jwt-auth 的 isPublicPath 成为
 * **唯一鉴权门**，据此断言：
 *   ① webhook 前缀下的非 webhook 路径（foobar / publish）无 token → 401（证豁免非前缀）；
 *   ② 恰好的 webhook 路径无 token → 非 401（证豁免真实存在且生效，本测试不是恒 401 的重言）。
 *
 * 若豁免被误改宽成 startsWith 前缀，① 的 foobar/publish 用例会立即变红——正是变异守。
 * 401 断言模式照 api.test.ts:897（无 token 打受保护路径断言 401）。
 */
describe('jwt 豁免精确性：仅确切 webhook 路径免鉴权，前缀下其它路径仍需 401', () => {
  let os: ChronoSynthOS;
  let app: FastifyInstance;

  /* jwt 启用 + auth（API-Key）保持默认禁用 → jwt-auth 的 isPublicPath 是唯一鉴权门：
   * 非公共路径 + 无 Bearer + auth 未启用 → 401 AUTH_REQUIRED（jwt-auth.ts onRequest）。
   * 同时启用凭据加密：让确切 webhook 路径通过 jwt-auth 后能真正进入路由逻辑（否则路由
   * 在「本机未启用凭据加密」处 fail-closed 返 401 AUTH_INVALID_TOKEN，虽非鉴权层 401 但
   * 会模糊对比守的语义）。启用后确切 webhook 无 installation.id → 路由返 400，与鉴权层 401
   * 泾渭分明。 */
  const authConfig = loadConfig({
    rateLimit: { max: 10000, timeWindowMs: 60_000 },
    websocket: { enabled: false, heartbeatIntervalMs: 30_000 },
    jwt: { enabled: true, secret: 'jwt-exempt-precision-secret-at-least-32-chars', issuer: 'test' },
    encryption: {
      enabled: true,
      masterKey: randomBytes(32).toString('base64'),
      defaultKeyRef: 'master',
      keyring: {},
      keyRotationIntervalDays: 90,
    },
  });

  beforeEach(async () => {
    os = new ChronoSynthOS({ clock: new TestClock(1000), logger: new SilentLogger() });
    os.start();
    app = await createApp({ os, config: authConfig });
  });

  afterEach(async () => {
    await app.close();
    os.close();
  });

  it('github 前缀下的非 webhook 路径无 token → 401（豁免是精确匹配，非宽前缀）', async () => {
    /* 若 isPublicPath 被误改成 startsWith('/api/v1/integrations/github')，下面两条会变成
     * 被豁免（非 401）→ 用例变红。这就是防「宽前缀静默暴露发布端点」的变异守。 */
    for (const path of [
      '/api/v1/integrations/github/foobar',
      '/api/v1/integrations/github/publish',
      '/api/v1/integrations/github', // 前缀本身（无尾随 /webhook）也不得豁免
    ]) {
      const res = await app.inject({ method: 'GET', url: path });
      assert.equal(
        res.statusCode,
        401,
        `${path} 不是确切的 webhook 路径，无 token 必须 401（豁免须精确匹配非前缀），实际 ${res.statusCode}`,
      );
      assert.equal(
        JSON.parse(res.body).code,
        'AUTH_REQUIRED',
        `${path} 应由 jwt-auth 因缺 Bearer 拒绝（AUTH_REQUIRED）`,
      );
    }
  });

  it('恰好的 webhook 路径无 token → 通过 jwt-auth（非鉴权层 401，证本测试非恒 401 重言）', async () => {
    /* 对比守：确切的 webhook 路径确实被 jwt-auth 豁免——请求通过鉴权层进入路由逻辑，
     * 路由因 payload 缺 installation.id 返 400（VALIDATION），而**不是**鉴权层的
     * 401 AUTH_REQUIRED。这保证「前缀下非 webhook → 401」不是「整段前缀都 401」的假象：
     * 豁免真实存在，且只对这一个确切路径生效。
     *
     * 断言用「非 AUTH_REQUIRED」而非「非 401」——因为路由自身的 HMAC/凭据 fail-closed
     * 也可能返 401（AUTH_INVALID_TOKEN），那是路由级安全拒绝、不是鉴权层豁免失效。
     * 我们只需证明：这条不是被 jwt-auth 以「缺 Bearer」挡下的。 */
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/integrations/github/webhook',
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });
    const code = (() => {
      try {
        return (JSON.parse(res.body) as { code?: string }).code;
      } catch {
        return undefined;
      }
    })();
    assert.notEqual(
      code,
      'AUTH_REQUIRED',
      `确切 webhook 路径应被 jwt-auth 豁免（进入路由，而非鉴权层以缺 Bearer 拒绝），` +
        `实际 status=${res.statusCode} code=${code} body=${res.body.slice(0, 200)}`,
    );
    /* 加固：确切 webhook 通过鉴权后，缺 installation.id 的空 payload 应得路由级 400。 */
    assert.equal(
      res.statusCode,
      400,
      `确切 webhook 路径应进入路由并因缺 installation.id 返 400，实际 ${res.statusCode}（body=${res.body.slice(0, 160)}）`,
    );
  });
});

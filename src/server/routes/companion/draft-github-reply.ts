/**
 * ChronoCompanion C 端路由 —「让 TA 对一个 GitHub issue/PR 起草回复」（GitHub 集成 Plan 3 起草段接入生产路径）。
 *
 * 这是把 Plan 3 起草段（ReadPort 读单个 issue/PR → 确定性检索已学记忆 → composeGithubReply 零-LLM 起草
 * → GithubDraftStore 存 drafted 草稿）串成一条端到端链路、接入运行 app 的生产入口：用户给一个 repo +
 * issue/PR 号 → 端点组装 ReadPort（App 凭据 → installation token）→ list+find 取该 issue/PR → 沿数字人
 * 已学的记忆（learn-github 沉淀）确定性检索相关知识 → 零-LLM 拼装一条回复草稿 → **停在 drafted**，等人工审批。
 *
 * 论点红线（本 plan 安全命题）：
 *   - **绝不写 GitHub**：本链路只经 GitHubReadPort（读侧，类型上无 comment/review/create 任何写方法）+
 *     composeGithubReply（纯确定性文本拼装）+ GithubDraftStore（本地草稿账本）。**没有** WritePort、
 *     **没有**对外 POST——回评/审阅的写侧是 Plan 4 的 GitHubWritePort，本 plan 结构上就发不出 GitHub 写请求。
 *   - **起草即停**：起草落库钉死 status='drafted'（GithubDraftStore.createDraft 执行器钉死）。approve/reject
 *     只推进本地草稿状态（drafted → approved/rejected），**不触发任何 GitHub 写**——审批只是人工闸门，发布是 Plan 4。
 *   - **零-LLM 运行时**：起草是 composeGithubReply（确定性拼装，复用 OfflineConversationResponder）；检索记忆
 *     也是纯图遍历（retrieveMemoriesDeterministic，零 embedding/零模型）。端点全程不调 LLM——相同输入 +
 *     相同人格状态 → 相同草稿（可复现）。LLM 只在 learn-github 的感官老师喂料阶段被调，不进起草。
 *
 * ReadPort 装配（逐字复用 learn-github.ts 的 assembleReadPort）：
 *   GithubAppCredentialStore.getApp() → 无凭据（undefined）返明确 4xx「GitHub 未连接」；否则从本租户
 *   installation 映射取 installationId → GitHubAuthManager（App 私钥 → App JWT → installation token）→
 *   GitHubReadPortImpl。
 *
 * 复用 companion/me.ts 的访问门（assertCompanionAccess）+ 租户隔离（getOS）+ 私有缓存头。
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { ChronoSynthOS } from '../../../chrono-synth-os.js';
import type { TenantOSFactory } from '../../../multi-tenant/tenant-os-factory.js';
import type { IDatabase } from '../../../storage/database.js';
import type { AppConfig } from '../../../config/schema.js';
import type { JwtPayload } from '../../../types/auth.js';
import { AuthorizationError, ValidationError, ErrorCode } from '../../../errors/index.js';
import { tryByokEncryption } from '../../../storage/llm-credential-store.js';
import { GithubAppCredentialStore } from '../../../storage/github-app-credential-store.js';
import { GithubDraftStore } from '../../../storage/github-draft-store.js';
import { GitHubAuthManager } from '../../../integrations/github/github-auth-manager.js';
import { GitHubReadPortImpl, type GitHubReadPort } from '../../../integrations/github/github-read-port.js';
import { composeGithubReply } from '../../../integrations/github/github-response-composer.js';
import { retrieveMemoriesDeterministic } from '../../../conversation/deterministic-memory-retrieval.js';
import { githubInstallListByTenant } from '@chrono/kernel';

/** companion 单 persona core-self 的 personaId（与 chat/perceive/learn-github 一致）。 */
const COMPANION_PERSONA_ID = 'default';

/**
 * 起草请求体：repo（owner/name）+ 目标类型（issue/pull）+ 目标编号（issue/PR number）。
 * targetType 用 GitHub 语义的 'issue' | 'pull'（与 composeGithubReply / GithubDraftStore 的取值一致）。
 */
const DraftGithubRequestSchema = z.object({
  repo: z.string().trim().min(1, 'repo 必填（owner/name）').max(200),
  targetType: z.enum(['issue', 'pull']),
  targetNumber: z.number().int().positive('targetNumber 必须是正整数'),
});

/** 列草稿的 query：status 可选过滤（drafted/approved/rejected）；省略则列该人格全部草稿。 */
const ListDraftsQuerySchema = z.object({
  status: z.enum(['drafted', 'approved', 'rejected']).optional(),
});

/** 审批路径参数：草稿 id。 */
const DraftIdParamSchema = z.object({
  id: z.string().trim().min(1),
});

/**
 * draft-github-reply 端点可注入依赖（测试用；生产不传，走真实装配）。
 *   - readPort：给定则跳过 App 凭据 / installation / auth 装配，直接用它（E2E 喂固定 issue/PR）。
 * 注意：起草段**无** LLM/provider 注入——起草零-LLM，本就没有 LLM 通道可注入。
 */
export interface DraftGithubInjected {
  readPort?: GitHubReadPort;
}

export function registerCompanionDraftGithubRoutes(
  app: FastifyInstance,
  os: ChronoSynthOS,
  tenantFactory: TenantOSFactory | undefined,
  /** 与其他 companion 路由注册签名对齐（app.ts 统一传 db+config）；本端点凭据装配只用 config，
   * 草稿读写走 tenantOS.getDatabase()（per-tenant 隔离），故 db 未直接使用（下划线前缀）。 */
  _db?: IDatabase,
  config?: AppConfig,
  injected?: DraftGithubInjected,
): void {
  /* GithubAppCredentialStore 强制启用的 FieldEncryption（私钥/webhook secret 拒绝明文落库）；
   * 加密未启用时无凭据 store 可用——凭据装配路径会明确报「未连接」。 */
  const credEncryption = config ? tryByokEncryption(config.encryption) : undefined;

  function getOS(request: FastifyRequest): ChronoSynthOS {
    const tid = request.tenantId;
    if (tenantFactory && tid && tid !== 'default') return tenantFactory.getTenantOS(tid);
    return os;
  }

  /* 与 companion/me.ts 同款访问门：仅个人用户会话，拒 API-key/service 主体 + enterprise plan。 */
  function assertCompanionAccess(request: FastifyRequest): void {
    const user = request.user as JwtPayload | undefined;
    if (user?.sub?.startsWith('apikey:') || user?.role === 'service') {
      throw new AuthorizationError(
        'companion 接口仅支持个人用户会话，不支持 API Key / service 主体访问',
        ErrorCode.AUTH_INSUFFICIENT_ROLE,
      );
    }
    if (user?.planId === 'enterprise') {
      throw new AuthorizationError(
        'companion 接口面向个人版账号；enterprise 账号请使用企业控制台',
        ErrorCode.AUTH_INSUFFICIENT_ROLE,
      );
    }
  }

  function setPrivateNoStore(reply: FastifyReply): void {
    reply.header('Cache-Control', 'private, no-store');
    reply.header('Vary', 'Authorization, X-Tenant-Id');
  }

  /**
   * 组装本租户的 GitHubReadPort（真实装配路径，逐字复用 learn-github.ts 的 assembleReadPort）。
   *   ① App 凭据（getApp）缺失 → 抛 ValidationError「GitHub 未连接」（明确 4xx，非 500）。
   *   ② 本租户无 installation 映射 → 抛「已配 App 但无 installation」（同 4xx，引导去装 App）。
   *   ③ 否则 GitHubAuthManager（App 私钥 → App JWT → installation token）→ GitHubReadPortImpl。
   * installationId 取本租户最近一个 installation（首版策略；listByTenant 按 created_at DESC）。
   * GHE 自托管（gheBaseUrl 非空）：把企业 API host 透传给 ReadPort 的 apiBase + hostAllowlist。
   */
  function assembleReadPort(tenantOS: ChronoSynthOS, tenantId: string, now: () => number): GitHubReadPort {
    if (!credEncryption) {
      throw new ValidationError('尚未连接 GitHub（本机未启用凭据加密，无法读取 GitHub App 凭据）——请先在设置里连接 GitHub');
    }
    const credStore = new GithubAppCredentialStore(tenantOS.getDatabase(), credEncryption, tenantId);
    const appCred = credStore.getApp();
    if (!appCred) {
      throw new ValidationError('尚未连接 GitHub——请先在设置里安装并连接 GitHub App，再让它起草回复');
    }
    /* 取本租户最近一个 installation（首版：一个租户第一个 installation；listByTenant 按 created_at DESC）。 */
    const installations = tenantOS.getDatabase().queryMany(githubInstallListByTenant(tenantId));
    const installation = installations[0];
    if (!installation) {
      throw new ValidationError('已配置 GitHub App 但尚无 installation——请在 GitHub 上把 App 安装到目标仓库后再试');
    }

    const auth = new GitHubAuthManager({
      getApp: () => ({ appId: appCred.appId, privateKeyPem: appCred.privateKeyPem, gheBaseUrl: appCred.gheBaseUrl }),
      installationId: installation.installation_id,
      now,
    });
    /* GHE 自托管：ReadPort 走企业 API base，并把企业 host 放进 SSRF allowlist；公有云走默认。 */
    if (appCred.gheBaseUrl) {
      const host = new URL(appCred.gheBaseUrl).hostname;
      return new GitHubReadPortImpl(auth, { apiBase: appCred.gheBaseUrl, hostAllowlist: [host] });
    }
    return new GitHubReadPortImpl(auth);
  }

  /**
   * 用 ReadPort list + find 取单个 issue/PR（ReadPort 无按单号取方法，用 list + `.find(n)`）。
   * 找不到（编号不在列表里 / App 无权访问该 repo）→ 抛明确 4xx，而非静默返回空草稿。
   * 返回 { title, body }——composeGithubReply 只需标题+正文（确定性起草的上下文）。
   */
  async function fetchTarget(
    readPort: GitHubReadPort, repo: string, targetType: 'issue' | 'pull', targetNumber: number,
  ): Promise<{ title: string; body: string }> {
    if (targetType === 'pull') {
      const pulls = await readPort.listPulls(repo);
      const pull = pulls.find((p) => p.number === targetNumber);
      if (!pull) {
        throw new ValidationError(`PR #${targetNumber} 不存在或 App 无权访问该仓库（${repo}）`);
      }
      return { title: pull.title, body: pull.body };
    }
    const issues = await readPort.listIssues(repo);
    const issue = issues.find((i) => i.number === targetNumber);
    if (!issue) {
      throw new ValidationError(`issue #${targetNumber} 不存在或 App 无权访问该仓库（${repo}）`);
    }
    return { title: issue.title, body: issue.body };
  }

  /**
   * 确定性检索与目标 issue/PR 相关的已学记忆（零-LLM，与 companion/chat 检索同款纯函数）。
   * query 用「标题 + 正文」——沿 learn-github 沉淀的记忆图关键词命中 + 图遍历联想拉相关知识。
   * 语义在蒸馏期沉淀为边，运行期纯图遍历——保住「相同输入→相同输出」+ 离线可用。
   */
  function retrieveRelevantMemories(tenantOS: ChronoSynthOS, title: string, body: string) {
    const query = `${title}\n${body}`.trim();
    return retrieveMemoriesDeterministic(
      query,
      tenantOS.core.memories.getAllMemories(),
      (id) => tenantOS.core.memories.getEdgesFor(id),
    );
  }

  /**
   * 构造本租户的 GithubDraftStore。IDatabase 满足 SyncWriteUnitOfWork（execute/queryOne/queryMany），
   * 与 github-draft-store 单测同款直接传 DB。绑本租户 tenantId——草稿读写租户 + 人格隔离。
   */
  function draftStore(tenantOS: ChronoSynthOS, tenantId: string): GithubDraftStore {
    return new GithubDraftStore(tenantOS.getDatabase(), tenantId);
  }

  /* POST /api/v1/companion/me/draft-github-reply —「对一个 issue/PR 起草回复，停在 drafted」 */
  app.post('/api/v1/companion/me/draft-github-reply', async (request, reply) => {
    assertCompanionAccess(request);
    setPrivateNoStore(reply);
    const body = DraftGithubRequestSchema.parse(request.body);
    const tenantOS = getOS(request);

    /* ReadPort：注入优先（测试）；否则从 App 凭据真实装配（无凭据 → 明确 4xx）。 */
    const readPort = injected?.readPort
      ?? assembleReadPort(tenantOS, request.tenantId, () => tenantOS.getClock().now());

    /* 只读取该 issue/PR（list+find）——找不到 → 4xx。绝不写 GitHub。 */
    const target = await fetchTarget(readPort, body.repo, body.targetType, body.targetNumber);

    /* 沿已学记忆确定性检索相关知识（零-LLM 图遍历）——喂给 composer 作 grounding。 */
    const relevantKnowledge = retrieveRelevantMemories(tenantOS, target.title, target.body);

    /* 零-LLM 确定性起草：narrative（我是谁）+ issue/PR 上下文 + 已学记忆 → 草稿正文。 */
    const narrative = tenantOS.core.narrative.get();
    const draft = composeGithubReply({
      narrative,
      targetTitle: target.title,
      targetBody: target.body,
      targetType: body.targetType,
      relevantKnowledge,
    });

    /* 存草稿：执行器钉死 status='drafted'（起草即停铁律）。绝不发布——发布是 Plan 4。 */
    const store = draftStore(tenantOS, request.tenantId);
    const draftId = store.createDraft(
      COMPANION_PERSONA_ID, body.repo, body.targetType, body.targetNumber, draft.body, tenantOS.getClock().now(),
    );

    return { data: {
      schemaVersion: 'companion-draft-github-reply-result.v1',
      draftId,
      body: draft.body,
      kind: draft.kind,
      groundedCount: draft.groundedCount,
    } };
  });

  /* GET /api/v1/companion/me/github-drafts?status=drafted —「列我的回复草稿」 */
  app.get('/api/v1/companion/me/github-drafts', async (request, reply) => {
    assertCompanionAccess(request);
    setPrivateNoStore(reply);
    const query = ListDraftsQuerySchema.parse(request.query);
    const tenantOS = getOS(request);
    const store = draftStore(tenantOS, request.tenantId);
    const drafts = store.listDrafts(COMPANION_PERSONA_ID, query.status);
    return { data: drafts };
  });

  /* POST /api/v1/companion/me/github-drafts/:id/approve —「人工批准草稿」（只改状态，绝不发布） */
  app.post('/api/v1/companion/me/github-drafts/:id/approve', async (request, reply) => {
    assertCompanionAccess(request);
    setPrivateNoStore(reply);
    const params = DraftIdParamSchema.parse(request.params);
    const tenantOS = getOS(request);
    const store = draftStore(tenantOS, request.tenantId);
    /* 状态机保护：仅 drafted 可推进 approved（终态不可逆）。非 drafted / 不存在 → false → 4xx。
     * **只改状态，不触发任何 GitHub 写**——本 plan 无 WritePort，发布是 Plan 4。 */
    const ok = store.setStatus(COMPANION_PERSONA_ID, params.id, 'approved', tenantOS.getClock().now());
    if (!ok) {
      throw new ValidationError('草稿不存在或不是待审（drafted）状态——无法批准');
    }
    return { data: { id: params.id, status: 'approved' } };
  });

  /* POST /api/v1/companion/me/github-drafts/:id/reject —「人工驳回草稿」（只改状态） */
  app.post('/api/v1/companion/me/github-drafts/:id/reject', async (request, reply) => {
    assertCompanionAccess(request);
    setPrivateNoStore(reply);
    const params = DraftIdParamSchema.parse(request.params);
    const tenantOS = getOS(request);
    const store = draftStore(tenantOS, request.tenantId);
    const ok = store.setStatus(COMPANION_PERSONA_ID, params.id, 'rejected', tenantOS.getClock().now());
    if (!ok) {
      throw new ValidationError('草稿不存在或不是待审（drafted）状态——无法驳回');
    }
    return { data: { id: params.id, status: 'rejected' } };
  });
}

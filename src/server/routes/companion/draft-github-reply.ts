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
import { AuthorizationError, ValidationError, StateError, ErrorCode } from '../../../errors/index.js';
import type { ToolInvocationPipeline } from '../../../agent/tool-invocation-pipeline.js';
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
 * 发布请求体：confirmationToken 可选。
 *   - 省略（首次）：探测——经 pipeline 触发 highRisk confirmation gate，返回 pending + tokenId，**不发**。
 *   - 携带（二次）：人工带 token 确认真发（不可降级人工审批门的「人在环」的那一步）。
 */
const PublishDraftBodySchema = z.object({
  confirmationToken: z.string().trim().min(1).optional(),
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
  /**
   * 发布段依赖：ToolInvocationPipeline（Plan 4 Task 5）。publish 端点经它调 github 写工具
   * （highRisk 恒真 → 强制 confirmation gate = 不可降级人工审批门）。app.ts 组合根传入共享 pipeline
   * （已注册 github.comment/github.review 写工具）。未传（老调用/仅起草段）时 publish 端点报「未启用」。
   */
  pipeline?: ToolInvocationPipeline,
): void {
  /* GithubAppCredentialStore 强制启用的 FieldEncryption（私钥/webhook secret 拒绝明文落库）；
   * 加密未启用时无凭据 store 可用——凭据装配路径会明确报「未连接」。 */
  const credEncryption = config ? tryByokEncryption(config.encryption) : undefined;

  function getOS(request: FastifyRequest): ChronoSynthOS {
    const tid = request.tenantId;
    if (tenantFactory && tid) return tenantFactory.getTenantOS(tid);
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

  /* POST /api/v1/companion/me/github-drafts/:id/publish
   * ——「把一条 approved 草稿真发到 GitHub」（Plan 4 发布段核心：不可降级人工审批门 + 原子防重复）。
   *
   * 三条铁律在此落地：
   *   ① **不可降级人工审批门**：真发**必须**经 ToolInvocationPipeline 调 github 写工具（highRisk 恒真）。
   *      首次（无 confirmationToken）只**探测**——不 claim、不发，pipeline 返 pending_confirmation +
   *      confirmationTokenId，端点原样返回；人工带 token 二次确认才真发。发布权不因任何参数降级。
   *   ② **原子防重复**：真发前 store.claimForPublish 原子 CAS approved→published（`WHERE status='approved'`）。
   *      同一草稿的真实 GitHub 写**至多发生一次**——重复发第二次 claim 返 undefined → 4xx。
   *   ③ **零-LLM**：发布是网络动作，草稿正文 Plan 3 起草时已确定；本端点不改草稿正文、不调 LLM。
   *
   * **claim 时机（本 plan 难点）**：先 pipeline 探测确认（无 token 返 pending，**不 claim**——避免 pending
   * 态误标 published）；带 token 二次调用时才 claimForPublish 原子占位（紧邻 invoke 之前）+ invoke 真发 +
   * markPublished。
   *
   * **补偿语义（带 token 且 pipeline 仍失败）**：claimForPublish 已把 status 占位 published、但
   * markPublished 未跑（github_ref 仍 NULL）——即 `status='published' 且 github_ref=NULL` = 「已原子占位
   * 但未确认真发」。此时 token 已被 pipeline 一次性消费（consume 先于真写），GitHub 侧是否已写**无法从本地
   * 确定**，故**不自动回滚也不重发**（宁可漏发人工补，不可重发）——记 warn 日志，返回错误，人工可据
   * `published + github_ref=NULL` 查证后手工处理。核心不变量「至多一次真发尝试」由原子 claim 保证。
   */
  app.post('/api/v1/companion/me/github-drafts/:id/publish', async (request, reply) => {
    assertCompanionAccess(request);
    setPrivateNoStore(reply);
    if (!pipeline) {
      /* 组合根未接入 pipeline（仅起草段）——发布能力未启用，明确报错而非静默不发。 */
      throw new StateError('发布能力未启用（未接入工具调用流水线）');
    }
    const params = DraftIdParamSchema.parse(request.params);
    const body = PublishDraftBodySchema.parse(request.body ?? {});
    const tenantOS = getOS(request);
    const store = draftStore(tenantOS, request.tenantId);

    /* 发布经内部动作调用 pipeline；invokerId 固定（externalUserId/sessionId 随之稳定）——探测与真发两次
     * 调用的 confirmation 上下文一致，token 才能验过（token 绑定 tenant/persona/session/externalUser +
     * arguments input-hash）。 */
    const invokerId = `companion-publish:${COMPANION_PERSONA_ID}`;

    if (!body.confirmationToken) {
      /* ── 首次（无 token）：只读探测，绝不 claim、绝不发 ──
       * 先确认草稿存在且是 approved（未批准/不存在 → 4xx；不因探测把它推进 published）。 */
      const draft = store.getDraft(COMPANION_PERSONA_ID, params.id);
      if (!draft) {
        throw new ValidationError('草稿不存在——无法发布');
      }
      if (draft.status !== 'approved') {
        throw new ValidationError(`草稿状态为「${draft.status}」，只有 approved 草稿可发布`);
      }
      const call = buildPublishInvocation(draft.target_type, draft.repo, draft.target_number, draft.draft_body);
      /* 经 pipeline 探测：highRisk 恒真 → 必走 confirmation gate → 返 pending_confirmation + tokenId。 */
      const decision = await pipeline.invoke({
        tenantId: request.tenantId, personaId: COMPANION_PERSONA_ID, toolId: call.toolId,
        invokerType: 'internal', invokerId, invokerUserId: null, arguments: call.arguments,
      });
      if (decision.ok) {
        /* 恒 highRisk 且无 token 理论不会直接执行；真到这一步（配置异常）说明审批门被绕过——拒。 */
        throw new StateError('审批门异常：高风险发布在无人工确认下被执行，已拒绝');
      }
      if (decision.status === 'pending_confirmation') {
        /* 不可降级门：草稿仍 approved、GitHub 未写。返回 tokenId 供人工二次确认。 */
        return { data: { status: 'pending_confirmation', confirmationTokenId: decision.confirmationTokenId } };
      }
      /* 授权/权限/配额/断路器等被拒 → 明确 4xx（未连接/未授权发布）。 */
      throw new ValidationError(`无法发布：${decision.reason}`);
    }

    /* ── 二次（带 token）：真发 ──
     * 原子占位（approved→published）紧邻 invoke 之前——undefined = 未批准/已发布/不存在/跨人格 → 4xx。
     * 这是**原子防重复**核心：重复发同一草稿，第二次 claim 恒 undefined，真实 GitHub 写至多一次。 */
    const now = tenantOS.getClock().now();
    const claimed = store.claimForPublish(COMPANION_PERSONA_ID, params.id, now);
    if (!claimed) {
      throw new ValidationError('草稿不存在、未批准或已发布——无法发布（原子防重复）');
    }

    const call = buildPublishInvocation(claimed.target_type, claimed.repo, claimed.target_number, claimed.draft_body);
    const decision = await pipeline.invoke({
      tenantId: request.tenantId, personaId: COMPANION_PERSONA_ID, toolId: call.toolId,
      invokerType: 'internal', invokerId, invokerUserId: null,
      arguments: call.arguments, confirmationToken: body.confirmationToken,
    });

    if (!decision.ok) {
      /* 补偿：claim 已占位 published、markPublished 未跑（github_ref 仍 NULL）。token 已被消费、
       * GitHub 侧是否已写无法从本地确定 → 不回滚不重发，记日志，人工据 published+github_ref=NULL 查证。 */
      tenantOS.getLogger().warn(
        'CompanionPublish',
        `发布占位后 pipeline 未确认真发（draft=${params.id} status=${decision.status} reason=${decision.reason}）——`
          + '草稿已占位 published 但 github_ref=NULL（未确认），需人工核对 GitHub 侧是否已写',
      );
      throw new StateError(`发布未确认：${decision.reason}（草稿已占位、github_ref 待人工核对）`);
    }

    /* 真发成功：从工具结果取 GitHub 侧 comment/review id 作 githubRef，回填 markPublished。 */
    const published = extractPublishResult(decision.result.content);
    store.markPublished(COMPANION_PERSONA_ID, params.id, published.githubRef, tenantOS.getClock().now());
    return { data: { status: 'published', githubRef: published.githubRef, htmlUrl: published.htmlUrl } };
  });
}

/**
 * 据草稿 target_type 决定 github 写工具与参数：
 *   - issue → 'github.comment'，arguments={ repo, issueNumber, body }
 *   - pull  → 'github.review'， arguments={ repo, prNumber,  body }
 * 其它取值（迁移 CHECK 钉死 issue/pull，理论不达）→ 抛 4xx 防御。
 * body 用草稿正文（Plan 3 已确定）——本段不改内容（零-LLM）。
 */
function buildPublishInvocation(
  targetType: string, repo: string, targetNumber: number, draftBody: string,
): { toolId: string; arguments: Record<string, unknown> } {
  if (targetType === 'issue') {
    return { toolId: 'github.comment', arguments: { repo, issueNumber: targetNumber, body: draftBody } };
  }
  if (targetType === 'pull') {
    return { toolId: 'github.review', arguments: { repo, prNumber: targetNumber, body: draftBody } };
  }
  throw new ValidationError(`不支持的草稿目标类型「${targetType}」——无法发布`);
}

/**
 * 从 pipeline 工具结果里取 GitHub 写返回（写工具 wrapJson 成 { id, htmlUrl } 的 json content）。
 * githubRef 用 GitHub 侧 comment/review id 的字符串形式（审计 + 去重佐证，回填 github_ref）。
 * 结果结构异常（无 json / 无 id）→ 抛 StateError（真发已发生，但本地拿不到引用——异常路径记为发布未确认）。
 */
function extractPublishResult(
  content: readonly import('../../../agent/tool-adapter.js').ToolContent[],
): { githubRef: string; htmlUrl: string } {
  const json = content.find((c): c is { type: 'json'; json: unknown } => c.type === 'json')?.json;
  const obj = (json ?? {}) as { id?: unknown; htmlUrl?: unknown };
  if (obj.id === undefined || obj.id === null) {
    throw new StateError('发布结果缺少 GitHub 引用 id——无法回填 github_ref');
  }
  return {
    githubRef: String(obj.id),
    htmlUrl: typeof obj.htmlUrl === 'string' ? obj.htmlUrl : '',
  };
}

/**
 * ChronoCompanion C 端路由 —「让 TA 学一个 GitHub repo」（GitHub 集成 Plan 2 学习段接入生产路径）。
 *
 * 这是把 Plan 2 学习段（ReadPort → Mapper → digest 幂等 → PerceptionDistiller 摄入蒸馏门）第一次
 * 串成一条端到端链路、接入运行 app 的生产入口：用户给一个 repo → 端点组装 ReadPort（App 凭据 →
 * installation token）→ GitHubLearningService 增量拉取该 repo 的 issues/pulls/commits/code → 逐条经
 * **既有感知蒸馏管线**（同 perceive/learn-topic）沉淀为记忆 → 之后对话零-LLM 据这些记忆答该 repo。
 *
 * 论点红线（本 plan 安全命题）：
 *   - **零-LLM 运行时**：端点运行时对话零 LLM；LLM 只在 perceive 的感官老师（BYOK provider）被调
 *     ——这与 learn-topic / perceive 完全同款（LLM 只在摄取阶段当老师，绝不进 runtime）。
 *   - **内核封顶**：GitHub 内容经 perceive 的 external 感知信任层——事实型观察 append 为记忆（低风险），
 *     身份层提案（value_shift / narrative_patch）一律走蒸馏门且必 pending 人工审批（value_shift 因
 *     patternAgrees=false 永不满足自动门）。故 **GitHub 学习绝不自动改内核价值观**——这是 Plan 2 的
 *     核心安全不变量，由 github-learn-e2e 变异测试守住。
 *   - **增量去重**：GithubLearningService 每条内容先 digest claim（INSERT ON CONFLICT DO NOTHING）；
 *     重复学同内容 claim=false → 跳过、不重灌记忆。游标只在全批成功后前移。
 *   - **只读**：本链路只经 GitHubReadPort（读侧），绝无写方法——回评/审阅是 Plan 4 的 WritePort。
 *
 * ReadPort 装配（端点内组装 Plan 1 已合入的组件）：
 *   GithubAppCredentialStore.getApp() → 无凭据（undefined）返明确 4xx「GitHub 未连接」；
 *   否则从本租户 installation 映射取 installationId → GitHubAuthManager（App 私钥 → App JWT →
 *   installation token）→ GitHubReadPortImpl。
 *
 * 复用 companion/me.ts 的访问门（assertCompanionAccess）+ 租户隔离（getOS）+ 私有缓存头 + 感知配额。
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { ChronoSynthOS } from '../../../chrono-synth-os.js';
import type { TenantOSFactory } from '../../../multi-tenant/tenant-os-factory.js';
import type { IDatabase } from '../../../storage/database.js';
import type { TenantDbResolver } from '../../../storage/tenant-db-resolver.js';
import type { AppConfig } from '../../../config/schema.js';
import type { JwtPayload } from '../../../types/auth.js';
import { AuthorizationError, QuotaExceededError, ValidationError, ErrorCode } from '../../../errors/index.js';
import { QuotaManager } from '../../../multi-tenant/quota-manager.js';
import { PerceptionDistiller } from '../../../perception/perception-distiller.js';
import type { PerceptionProvider } from '../../../perception/perception-provider.js';
import { tryByokEncryption } from '../../../storage/llm-credential-store.js';
import { selectPerceptionProvider } from './perception-provider-factory.js';
import { assembleGitHubReadPort } from '../../../integrations/github/github-readport-factory.js';
import { GithubLearnStore } from '../../../storage/github-learn-store.js';
import type { GitHubReadPort } from '../../../integrations/github/github-read-port.js';
import {
  GitHubLearningService, type GitHubResourceType, type LearnGithubResult,
} from '../../../integrations/github/github-learning-service.js';

/** companion 单 persona core-self 的 personaId（与 chat/perceive 一致）。 */
const COMPANION_PERSONA_ID = 'default';

/** 学习段支持的四类资源；resourceTypes 省略时默认全 4 类。 */
const ALL_RESOURCE_TYPES: readonly GitHubResourceType[] = ['code', 'issues', 'pulls', 'commits'];

/** 请求体：repo 必填（owner/name），resourceTypes 可选（默认全 4 类）。 */
const LearnGithubRequestSchema = z.object({
  repo: z.string().trim().min(1, 'repo 必填（owner/name）').max(200),
  resourceTypes: z.array(z.enum(['code', 'issues', 'pulls', 'commits'])).nonempty().optional(),
});

/**
 * learn-github 端点可注入依赖（测试用；生产不传，走真实装配）。
 *   - readPort：给定则跳过 App 凭据 / installation / auth 装配，直接用它（E2E 喂固定内容）。
 *   - provider：给定则忽略 BYOK 解析，所有租户用它当感官老师（E2E 驱动内核封顶分支）。
 */
export interface LearnGithubInjected {
  readPort?: GitHubReadPort;
  provider?: PerceptionProvider;
}

/** Companion GitHub 学习路由依赖（分片 Phase 0 · Plan 1：resolver 必填）。 */
export interface CompanionLearnGithubRoutesDeps {
  os: ChronoSynthOS;
  tenantFactory: TenantOSFactory | undefined;
  /** 共享 TenantDbResolver（组合根唯一实例；quotaManager 经它路由 shard）。 */
  resolver: TenantDbResolver;
  /** BYOK 选 provider + 装配 credential store 需要 db + config；直查用 host db（Plan 2）；缺省回退 os.getDatabase()。 */
  db?: IDatabase;
  config?: AppConfig;
  injected?: LearnGithubInjected;
}

export function registerCompanionLearnGithubRoutes(app: FastifyInstance, deps: CompanionLearnGithubRoutesDeps): void {
  const { os, tenantFactory, resolver, config, injected } = deps;
  const sharedDb = deps.db ?? os.getDatabase();
  /* BYOK：解析 per-tenant LLM key 用（缺失回退全局 config）——感官老师用。 */
  const llmEncryption = config ? tryByokEncryption(config.encryption) : undefined;
  /* GithubAppCredentialStore 强制启用的 FieldEncryption（私钥/webhook secret 拒绝明文落库）；
   * 加密未启用时无凭据 store 可用——凭据装配路径会明确报「未连接」。 */
  const credEncryption = config ? tryByokEncryption(config.encryption) : undefined;
  /* 学习配额（与 perception 同口径——每次经感官老师 perceive 有成本；未设限额默认无限）。 */
  const quotaManager = QuotaManager.fromResolver(resolver);

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
   * 组装本租户的 GitHubReadPort（真实装配路径）。
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
    /* 装配本身走共享工厂（与起草/发布/组织同步 worker 同一实现）；本端点只负责把
     * failure 翻译成面向用户的明确 4xx 文案。 */
    const result = assembleGitHubReadPort(tenantOS.getDatabase(), credEncryption, tenantId, now);
    if (result.failure === 'no-credential') {
      throw new ValidationError('尚未连接 GitHub——请先在设置里安装并连接 GitHub App，再让它学 repo');
    }
    if (result.failure === 'no-installation') {
      throw new ValidationError('已配置 GitHub App 但尚无 installation——请在 GitHub 上把 App 安装到目标仓库后再试');
    }
    return result.readPort!;
  }

  /* POST /api/v1/companion/me/learn-github —「让 TA 学一个 GitHub repo」 */
  app.post('/api/v1/companion/me/learn-github', async (request, reply) => {
    assertCompanionAccess(request);
    setPrivateNoStore(reply);
    const body = LearnGithubRequestSchema.parse(request.body);
    const tenantOS = getOS(request);
    const resourceTypes: GitHubResourceType[] = body.resourceTypes ?? [...ALL_RESOURCE_TYPES];

    /* 学习配额：在任何有成本（感官老师 perceive）/有副作用（拉取+摄入）步骤前扣减。未设限额默认无限。 */
    if (!quotaManager.consumeQuota(request.tenantId, 'perception')) {
      throw new QuotaExceededError('学习配额已用尽，请稍后再试');
    }

    /* ReadPort：注入优先（测试）；否则从 App 凭据真实装配（无凭据 → 明确 4xx）。 */
    const readPort = injected?.readPort
      ?? assembleReadPort(tenantOS, request.tenantId, () => tenantOS.getClock().now());

    /* 感官老师：按租户 BYOK 选（注入优先）。GitHub 内容经它抽事实——LLM 只在此摄取阶段被调，不进 runtime。 */
    const provider = selectPerceptionProvider(request.tenantId, sharedDb, config, llmEncryption, injected?.provider);
    const distiller = new PerceptionDistiller(provider, tenantOS.core.memories, tenantOS.distillation);

    /* GithubLearnStore：游标读写 + digest 原子 claim（增量去重）——绑本租户 DB + tenantId。 */
    const store = new GithubLearnStore(tenantOS.getDatabase(), request.tenantId);

    /* 编排：增量拉取 → digest 原子摄入 → 游标成功才推进。零新领域逻辑，只确定性编排。 */
    const service = new GitHubLearningService({
      readPort, store, distiller, tenantId: request.tenantId, personaId: COMPANION_PERSONA_ID,
      /* 演进式取代需删同讨论旧记忆——注入本租户 OS 的记忆图。 */
      memories: tenantOS.core.memories,
    });
    const result: LearnGithubResult = await service.learn(body.repo, resourceTypes);

    return { data: {
      schemaVersion: 'companion-learn-github-result.v1',
      repo: body.repo,
      resourceTypes,
      ingested: result.ingested,
      skipped: result.skipped,
      cursorAdvanced: result.cursorAdvanced,
    } };
  });
}

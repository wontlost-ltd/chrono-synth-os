/**
 * ChronoCompanion C 端路由 —「让 TA 听一段 / 看一段」感知（ADR-0051 感知层接入生产路径）。
 *
 * 这是把已就绪的 PerceptionDistiller 第一次接入运行 app 的生产入口：用户提交一段已转写的中间
 * 表征（transcript / 视频场景描述）→ 确定性感知蒸馏器把它沉淀为 episodic 记忆 + 经蒸馏门产成长
 * 候选 → 返回「人格记住了什么 + 是否有待审批的成长」。
 *
 * 论点红线（与 ADR-0051/0052 一致）：
 *   - 服务端**绝不接收原始媒体二进制**——只收已脱离媒体的中间表征（前端 ASR / 用户输入）。
 *   - 感知产物经蒸馏门：事实记忆 append，身份层提案默认 pending 人工审批，绝不自动改身份核。
 *   - provider 按租户 BYOK 选（providerFor）：配了 LLM key → LlmPerceptionProvider（真语义理解，
 *     ModelRouter 当感官老师）；无 key / provider=mock → 确定性 MockPerceptionProvider（本地可验证）。
 *
 * 复用 companion/me.ts 的访问门控（assertCompanionAccess）+ 租户隔离（getOS）+ 私有缓存头。
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { ChronoSynthOS } from '../../../chrono-synth-os.js';
import type { TenantOSFactory } from '../../../multi-tenant/tenant-os-factory.js';
import type { IDatabase } from '../../../storage/database.js';
import type { AppConfig } from '../../../config/schema.js';
import type { JwtPayload } from '../../../types/auth.js';
import type { LLMProviderName } from '@chrono/kernel';
import { AuthorizationError, ValidationError, QuotaExceededError, ErrorCode } from '../../../errors/index.js';
import { QuotaManager } from '../../../multi-tenant/quota-manager.js';
import {
  CompanionPerceiveRequestV1Schema,
  CompanionPerceiveResultV1Schema,
  type CompanionPerceiveResultV1,
} from '@chrono/contracts';
import { createHash } from 'node:crypto';
import { PerceptionDistiller } from '../../../perception/perception-distiller.js';
import { MockPerceptionProvider } from '../../../perception/sources/mock-perception-provider.js';
import { LlmPerceptionProvider } from '../../../perception/sources/llm-perception-provider.js';
import type { PerceptionProvider } from '../../../perception/perception-provider.js';
import { ModelRouter } from '../../../intelligence/model-router.js';
import { tryByokEncryption } from '../../../storage/llm-credential-store.js';
import { resolveTenantLlmConfig } from '../../../storage/tenant-llm-settings-store.js';

export function registerCompanionPerceiveRoutes(
  app: FastifyInstance,
  os: ChronoSynthOS,
  tenantFactory: TenantOSFactory | undefined,
  /** BYOK 选 provider 需要 db + config（缺省构造 LLM teacher）；测试可省略只用注入 provider。 */
  db?: IDatabase,
  config?: AppConfig,
  /** provider 显式注入（测试用）；给定则忽略 BYOK 解析，所有租户用它。 */
  injectedProvider?: PerceptionProvider,
): void {
  const sharedDb = db ?? os.getDatabase();
  /* BYOK：解析 per-tenant LLM key 用（缺失回退全局 config）。 */
  const llmEncryption = config ? tryByokEncryption(config.encryption) : undefined;
  /* 感知配额（防 BYOK LLM teacher 被刷爆——LlmPerceptionProvider 每次 perceive 调 LLM 有成本）。
   * 复用现有 QuotaManager：未设 perception 限额的租户默认无限（consumeQuota 返回 true）。 */
  const quotaManager = new QuotaManager(sharedDb);

  function getOS(request: FastifyRequest): ChronoSynthOS {
    const tid = request.tenantId;
    if (tenantFactory && tid && tid !== 'default') return tenantFactory.getTenantOS(tid);
    return os;
  }

  /**
   * 按租户 BYOK 选「感官老师」provider（论点：LLM 只在摄取阶段当老师）：
   *   - 显式注入 → 用它（测试）。
   *   - provider=mock（无真实 LLM）→ 确定性 MockPerceptionProvider。
   *   - ollama 无需 key / 云 provider 有 apiKey → LLM teacher（真语义，ModelRouter）。
   *   - 云 provider **无 key** → 退回确定性 mock（租户没配 LLM，仍能用确定性感知）。
   *   - 云 provider **坏 key**（BYOK 解密失败）→ resolveTenantLlmConfig **fail-closed 抛错**：转成清晰
   *     ValidationError（不静默降级 mock——租户配了 BYOK 坏 key 不该静默改用别的，与 #97-99 fail-closed
   *     安全语义一致；让租户知道是 LLM 配置问题，而非裸 500）。
   */
  function providerFor(tenantId: string): PerceptionProvider {
    if (injectedProvider) return injectedProvider;
    if (!config) return new MockPerceptionProvider();
    let effective;
    try {
      effective = resolveTenantLlmConfig(sharedDb, tenantId, config.intelligence, llmEncryption);
    } catch {
      /* BYOK fail-closed（坏 row 解密失败）：清晰 400 错误，不静默降级（安全语义保持）。 */
      throw new ValidationError('LLM 配置不可用，请检查 BYOK 设置');
    }
    if (effective.provider === 'mock') return new MockPerceptionProvider();
    if (effective.provider !== 'ollama' && !effective.apiKey) return new MockPerceptionProvider();
    const llm = new ModelRouter({
      provider: effective.provider as LLMProviderName,
      model: effective.model,
      embeddingModel: effective.embeddingModel,
      apiKey: effective.apiKey,
      baseUrl: effective.baseUrl,
      maxTokens: config.intelligence.maxTokens,
      temperature: config.intelligence.temperature,
      tenantId,
    });
    return new LlmPerceptionProvider(llm);
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

  /* POST /api/v1/companion/me/perceive —「让 TA 听/看一段」 */
  app.post('/api/v1/companion/me/perceive', async (request, reply) => {
    assertCompanionAccess(request);
    setPrivateNoStore(reply);
    const body = CompanionPerceiveRequestV1Schema.parse(request.body);
    const tenantOS = getOS(request);

    /* 感知配额：超额（已设 perception 限额且本窗用尽）→ 拒绝（防 BYOK LLM 刷爆）。
     * 未设限额的租户默认无限。在调 provider（可能调 LLM，有成本）前扣减。 */
    if (!quotaManager.consumeQuota(request.tenantId, 'perception')) {
      throw new QuotaExceededError('感知配额已用尽，请稍后再试');
    }

    /* 按租户 BYOK 选感官老师（有 LLM key → LLM teacher 真语义；否则确定性 mock）。 */
    const provider = providerFor(request.tenantId);
    const distiller = new PerceptionDistiller(provider, tenantOS.core.memories, tenantOS.distillation);
    const result = await distiller.perceive({
      personaId: 'default',
      tenantId: request.tenantId,
      media: {
        modality: body.modality,
        /* mediaSha256：表征内容哈希作 provenance（无原始媒体，用表征哈希）。 */
        mediaSha256: createHash('sha256').update(body.representation).digest('hex'),
        durationMs: 0,
        representation: body.representation,
      },
    });

    /* 映射沉淀的记忆 → 人格第一人称视图。 */
    const perceivedMemories = result.memoryIds.map((id) => {
      const node = tenantOS.core.memories.getMemory(id);
      return {
        id,
        content: node?.content ?? '',
        valence: node?.valence ?? 0,
        salience: node?.salience ?? 0,
      };
    });

    /* 成长候选统计：进蒸馏门的候选数 + 待审批（pending=身份层提案，绝不自动应用）。 */
    const candidates = result.candidates.filter((c) => c.status !== 'rejected');
    const pendingApprovalCount = result.candidates.filter((c) => c.status === 'pending').length;

    const payload: CompanionPerceiveResultV1 = {
      schemaVersion: 'companion-perceive-result.v1',
      perceivedMemories,
      growthCandidateCount: candidates.length,
      pendingApprovalCount,
    };
    return { data: CompanionPerceiveResultV1Schema.parse(payload) };
  });
}

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
 *   - provider 当前用确定性 MockPerceptionProvider（无 key 可跑、本地可验证全链路）；真实多模态
 *     teacher（BYOK LLM / ollama-llava）是紧跟增量（接入点：provider 注入），不在本切片。
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
import { AuthorizationError, ErrorCode } from '../../../errors/index.js';
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

  function getOS(request: FastifyRequest): ChronoSynthOS {
    const tid = request.tenantId;
    if (tenantFactory && tid && tid !== 'default') return tenantFactory.getTenantOS(tid);
    return os;
  }

  /**
   * 按租户 BYOK 选「感官老师」provider（论点：LLM 只在摄取阶段当老师）：
   *   - 显式注入 → 用它（测试）。
   *   - 配了有效 LLM 的租户（resolveTenantLlmConfig 有 apiKey，或 provider=ollama/mock）→ LLM teacher
   *     （真语义理解），用 ModelRouter。
   *   - 否则 → 确定性 MockPerceptionProvider（无 key 也能用、本地可验证）。
   */
  function providerFor(tenantId: string): PerceptionProvider {
    if (injectedProvider) return injectedProvider;
    if (!config) return new MockPerceptionProvider();
    const effective = resolveTenantLlmConfig(sharedDb, tenantId, config.intelligence, llmEncryption);
    /* provider='mock'（无真实 LLM）→ 确定性 MockPerceptionProvider（句切，非走 ModelRouter mock chat）。 */
    if (effective.provider === 'mock') return new MockPerceptionProvider();
    /* ollama 无需 key；其余 provider 需有 apiKey 才用 LLM teacher，否则退回确定性 mock。 */
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

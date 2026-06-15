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
import { AuthorizationError, QuotaExceededError, ErrorCode } from '../../../errors/index.js';
import { QuotaManager } from '../../../multi-tenant/quota-manager.js';
import {
  CompanionPerceiveRequestV1Schema,
  CompanionPerceiveResultV1Schema,
  type CompanionPerceiveResultV1,
} from '@chrono/contracts';
import { createHash, randomUUID } from 'node:crypto';
import { perceptionEventInsert } from '@chrono/kernel';
import { PerceptionDistiller } from '../../../perception/perception-distiller.js';
import type { PerceptionProvider } from '../../../perception/perception-provider.js';
import { tryByokEncryption } from '../../../storage/llm-credential-store.js';
import { selectPerceptionProvider } from './perception-provider-factory.js';

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

  /* 按租户 BYOK 选「感官老师」provider——共享工厂（与流式 perceive 同一逻辑，见 selectPerceptionProvider）。 */
  function providerFor(tenantId: string): PerceptionProvider {
    return selectPerceptionProvider(tenantId, sharedDb, config, llmEncryption, injectedProvider);
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
   * best-effort 写一条感知事件审计行（不存表征原文——只哈希+计数+元数据+status）。
   * 失败只 warn，绝不抛（记忆/配额此刻已提交，审计失败不能拖垮主流程或触发用户重试重复沉淀）。
   */
  function recordPerceptionEvent(
    fields: {
      modality: string; representationSha256: string; providerName: string;
      memoryCount: number; candidateCount: number; pendingCount: number; status: string;
    },
    request: FastifyRequest,
  ): void {
    try {
      sharedDb.execute(perceptionEventInsert({
        id: `pevt_${randomUUID()}`,
        tenantId: request.tenantId,
        personaId: 'default',
        modality: fields.modality,
        representationSha256: fields.representationSha256,
        providerName: fields.providerName,
        memoryCount: fields.memoryCount,
        candidateCount: fields.candidateCount,
        pendingCount: fields.pendingCount,
        status: fields.status,
        createdAt: Date.now(),
      }));
    } catch (err) {
      request.log.warn({ err, tenantId: request.tenantId }, 'perception event audit write failed');
    }
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

    /* 表征内容哈希（provenance；不存原文——可能含 PII）。 */
    const representationSha256 = createHash('sha256').update(body.representation).digest('hex');

    /* 按租户 BYOK 选感官老师（有 LLM key → LLM teacher 真语义；否则确定性 mock）。 */
    const provider = providerFor(request.tenantId);
    const distiller = new PerceptionDistiller(provider, tenantOS.core.memories, tenantOS.distillation);
    const result = await distiller.perceive({
      personaId: 'default',
      tenantId: request.tenantId,
      media: {
        modality: body.modality,
        mediaSha256: representationSha256,
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

    /* 记一条感知事件审计（行为审计，不存表征原文——只哈希+计数+元数据）。
     * status：老师调用失败（teacherFailed）记 'failed'，正常记 'done'——让审计能区分「试了但老师挂了」
     * 与「正常感知（哪怕没沉淀记忆）」。老师挂了是安全降级（不抛主流程），但审计要留痕。
     * best-effort：这是「人格何时感知了什么」的回看轨迹，不是强合规审计。记忆与配额此刻已落库提交，
     * 审计行写失败绝不能反过来把整个 perceive 打成 500——否则用户重试会重复沉淀记忆+重复扣配额。
     * 失败只 warn 记日志（与 analytics 事件写入同款非致命语义）。 */
    recordPerceptionEvent({
      modality: body.modality,
      representationSha256,
      providerName: provider.name,
      memoryCount: result.memoryIds.length,
      candidateCount: candidates.length,
      pendingCount: pendingApprovalCount,
      status: result.teacherFailed ? 'failed' : 'done',
    }, request);

    const payload: CompanionPerceiveResultV1 = {
      schemaVersion: 'companion-perceive-result.v1',
      perceivedMemories,
      /* 透明度：本次感知由真 LLM 老师还是确定性回退处理（避免把 mock 误当真老师）。 */
      perceivedBy: provider.kind,
      growthCandidateCount: candidates.length,
      pendingApprovalCount,
    };
    return { data: CompanionPerceiveResultV1Schema.parse(payload) };
  });
}

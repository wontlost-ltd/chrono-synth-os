/**
 * ChronoCompanion C 端路由 —「我的数字人」主页 + 成长视图（ADR-0046 / roadmap Phase 2.1）。
 *
 * 路由层只做：plan 门控 + 读取内核数据 + 映射成 C 端 DTO + 序列化。所有数据来自既有
 * 慢层（tenantOS.core.values / memories / narrative）与既有漂移分析器（PersonaDriftAnalyzer，
 * 企业版同款），**不新增业务逻辑**——companion 是同一内核的另一个外壳。
 *
 * 关键语义转换：企业版把 persona drift 渲染成「policy violation / alert」，companion 把
 * 同一份 DriftReport 重新组织成「你最近探索的方向」（见 driftReportToGrowth）。这是 ADR-0046
 * 双产品「同内核两外壳」的核心证明点（roadmap Phase 2 退出条件 5.2）。
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { ChronoSynthOS } from '../../../chrono-synth-os.js';
import type { TenantOSFactory } from '../../../multi-tenant/tenant-os-factory.js';
import type { IDatabase } from '../../../storage/database.js';
import { SingleDbResolver } from '../../../storage/tenant-db-resolver.js';
import type { AppConfig } from '../../../config/schema.js';
import type { JwtPayload } from '../../../types/auth.js';
import { AuthorizationError, NotFoundError, QuotaExceededError, ValidationError, ErrorCode } from '../../../errors/index.js';
import { QuotaManager } from '../../../multi-tenant/quota-manager.js';
import {
  PersonaDriftAnalyzer,
  resolveDriftThresholds,
} from '../../../safety/persona-drift-analyzer.js';
import {
  CompanionMeV1Schema,
  CompanionGrowthV1Schema,
  CompanionMemoryListV1Schema,
  CompanionNudgeListV1Schema,
  driftReportToGrowth,
  type CompanionMeV1,
  type CompanionValueV1,
  type CompanionMemoryV1,
  type CompanionMemoryListV1,
  type CompanionNudgeV1,
  type CompanionNudgeListV1,
} from '@chrono/contracts';
import { MemoryFacade } from '../../../core/memory-facade.js';
import { ProactiveMessageStore } from '../../../storage/proactive-message-store.js';
import { parsePagination } from '../../plugins/pagination.js';
import { ModelRouter } from '../../../intelligence/model-router.js';
import { LlmReflectionDistiller, type ReflectMemory, type ReflectValue } from '../../../intelligence/llm-reflection-distiller.js';
import { resolveTenantLlmConfig, TenantLlmSettingsStore } from '../../../storage/tenant-llm-settings-store.js';
import { tryByokEncryption, LlmCredentialStore } from '../../../storage/llm-credential-store.js';
import { CompanionLlmSettingsRequestV1Schema, CompanionLearnTopicRequestV1Schema } from '@chrono/contracts';
import { LlmPerceptionProvider } from '../../../perception/sources/llm-perception-provider.js';
import { PerceptionDistiller } from '../../../perception/perception-distiller.js';
import { WebSearchTool } from '../../../agent/tools/web-search-tool.js';
import { linkMemoryAssociatively } from '../../../conversation/deterministic-memory-association.js';
import { createHash } from 'node:crypto';
import { MemoryTranslationStore } from '../../../storage/memory-translation-store.js';
import { LlmTranslationService, TRANSLATION_BATCH_SIZE, MAX_TRANSLATE_PER_CALL, type TranslatableMemory } from '../../../intelligence/llm-translation-service.js';
import { isSupportedLocale, type SupportedLocale } from '../../../i18n/locale-resolver.js';
import type { LLMProviderName } from '@chrono/kernel';

/** companion 单 persona core-self 的 personaId（与 chat.ts 一致）。 */
const COMPANION_PERSONA_ID = 'default';
import type { CoreValue } from '@chrono/kernel';
import type { MemoryNode } from '@chrono/kernel';
import type { ProactiveMessageRow } from '@chrono/kernel';

/** 主页价值列表默认条数（按 weight 降序取 topN）。 */
const TOP_VALUES_LIMIT = 5;
/** 主页记忆列表默认条数（按 createdAt 降序取最近 N 条）。 */
const RECENT_MEMORIES_LIMIT = 10;

/* ── 纯映射函数（无副作用，便于单测） ─────────────────────────────── */

/** CoreValue → C 端价值视图（丢弃 timeDiscount/emotionAmplifier 等调参细节）。 */
export function toCompanionValue(v: CoreValue): CompanionValueV1 {
  return { id: v.id, label: v.label, weight: v.weight };
}

/** MemoryNode → C 端记忆摘要（只保留陪伴所需字段）。 */
export function toCompanionMemory(m: MemoryNode): CompanionMemoryV1 {
  return {
    id: m.id,
    kind: m.kind,
    content: m.content,
    valence: m.valence,
    salience: m.salience,
    createdAt: m.createdAt,
  };
}

/** 主动消息 row → C 端 nudge DTO（ADR-0054）。返回共享契约类型 CompanionNudgeV1。 */
export function toCompanionNudge(r: ProactiveMessageRow): CompanionNudgeV1 {
  return {
    id: r.id,
    kind: r.kind,
    body: r.body,
    status: r.status,
    createdAt: r.created_at,
    readAt: r.read_at,
  };
}

/** 合法 nudge status 过滤值（'all' → 不过滤）。未知值收敛为默认 'unread'（不返回空列表误导）。 */
const VALID_NUDGE_STATUSES: ReadonlySet<string> = new Set(['unread', 'read', 'dismissed', 'all']);

/** 解析 nudges 列表查询参数：status（默认 'unread'，'all' → 不过滤）+ limit（1..100，默认 50）。 */
function parseNudgeQuery(q: Record<string, unknown>): { status?: string; limit: number } {
  const rawStatus = typeof q.status === 'string' && VALID_NUDGE_STATUSES.has(q.status) ? q.status : 'unread';
  const status = rawStatus === 'all' ? undefined : rawStatus;
  const rawLimit = Number(q.limit);
  const limit = Number.isInteger(rawLimit) && rawLimit >= 1 && rawLimit <= 100 ? rawLimit : 50;
  return { status, limit };
}

/* drift→「你最近探索的方向」映射已抽到 @chrono/contracts（driftReportToGrowth），服务端与
 * desktop 本地共用同一份，杜绝分叉。服务端 DriftReport 结构化满足其 DriftLike 入参。 */

/** 统计租户快照数（与 PersonaDriftAnalyzer.analyze 的 WHERE 一致），用于判断是否有可对比基线。 */
export function countTenantSnapshots(db: IDatabase, tenantId: string): number {
  const row = db.prepare<{ n: number }>(
    `SELECT COUNT(*) AS n FROM snapshots
      WHERE tenant_id = ? OR (tenant_id IS NULL AND ? = 'default')`,
  ).get(tenantId, tenantId);
  return row?.n ?? 0;
}

/** 顶级职业经理人的价值内核（label, 初始权重）。反思会据已学记忆在此基础上微调强化。 */
const MANAGER_GENESIS_VALUES: ReadonlyArray<readonly [string, number]> = [
  ['长期主义', 0.7],
  ['结果导向', 0.7],
  ['培养他人', 0.65],
  ['正直诚信', 0.75],
  ['客户与价值创造', 0.7],
  ['果断决策', 0.6],
  ['团队信任', 0.65],
];

/** companion genesis 价值底盘 bootstrap（与 reflection 是不同关注点：这是「出生/初始化」，
 * reflection 是「内化」）。幂等 + pristine 守卫：仅当人格还没有任何价值时注入，对已有价值
 * （出生扰动 personalitySeed 或已学）的人格零副作用，绝不覆写。注入即审计留痕（成长 provenance）。
 *
 * 设计取舍：价值内核理应在人格出生（personalitySeed）时建立。companion 当前出生路径未播种
 * archetype 价值，故在首次自反思时一次性兜底——这是有意的懒 bootstrap，非 reflection 逻辑的一部分。 */
function ensureCompanionGenesisValues(core: ChronoSynthOS['core'], logger?: { info(layer: string, msg: string): void }): void {
  if (core.values.getAll().size > 0) return;
  for (const [label, weight] of MANAGER_GENESIS_VALUES) {
    core.values.create(label, weight);
  }
  logger?.info('CompanionGenesis', `首次反思 bootstrap 经理人价值内核（${MANAGER_GENESIS_VALUES.length} 个）`);
}

/** 学习材料上限（防单主题灌爆记忆）+ 单块记忆上限（存储层无硬限，此为软上限防超长块）。 */
const LEARN_MATERIAL_MAX_LEN = 8000;
const LEARN_CHUNK_MAX_LEN = 3000;
/** 参考料每主题最多存几条（防碎片刷屏；概念事实另由蒸馏管线存）。 */
const LEARN_MAX_REFERENCE_MEMORIES = 6;

/**
 * 纯确定性拆块：把学习材料切成参考记忆块——**代码块（```…```）整块保留**（保代码完整），普通文本按
 * 空行分段、太碎（≤20 字）的段跳过（概念事实已覆盖）。零 LLM，便于单测。上限 LEARN_MAX_REFERENCE_MEMORIES。
 */
export function chunkLearnedMaterial(material: string): string[] {
  const trimmed = material.slice(0, LEARN_MATERIAL_MAX_LEN).trim();
  if (!trimmed) return [];
  const parts = trimmed.split(/(```[\s\S]*?```)/g); // 奇数段=代码块，偶数段=普通文本
  const chunks: string[] = [];
  for (const part of parts) {
    if (!part.trim()) continue;
    if (part.startsWith('```')) {
      chunks.push(part.trim().slice(0, LEARN_CHUNK_MAX_LEN)); // 代码块整块
    } else {
      for (const para of part.split(/\n\s*\n/)) {
        const p = para.trim();
        if (p.length > 20) chunks.push(p.slice(0, LEARN_CHUNK_MAX_LEN)); // 跳过太碎的段
      }
    }
  }
  return chunks.slice(0, LEARN_MAX_REFERENCE_MEMORIES);
}

/**
 * 把学习材料按块存为**逐字参考记忆**（semantic）——供聊天检索时吐出完整例子（尤其代码块）。
 * 区别于蒸馏管线的「≤500 字概念事实」：这是原文参考料，answer「写个例子」用。返回新建记忆 id。
 */
function storeLearnedReference(os: ChronoSynthOS, topic: string, material: string): string[] {
  const ids: string[] = [];
  for (const chunk of chunkLearnedMaterial(material)) {
    /* 前缀主题让检索按主题词命中；salience 0.5（参考料<核心洞察），valence 0（中性知识）。 */
    const node = os.core.memories.addMemory('semantic', `关于「${topic}」：${chunk}`, 0, 0.5);
    /* 融会贯通：新学的知识块确定性联想连边到既有相关记忆——学的东西不再是孤岛，日后检索能联想串联。 */
    linkMemoryAssociatively(os.core.memories, node.id, node.content);
    ids.push(node.id);
  }
  return ids;
}

/* ── 路由注册 ──────────────────────────────────────────────────── */

export function registerCompanionRoutes(
  app: FastifyInstance,
  os: ChronoSynthOS,
  tenantFactory: TenantOSFactory | undefined,
  db: IDatabase,
  config: AppConfig,
): void {
  function getOS(request: FastifyRequest): ChronoSynthOS {
    const tid = request.tenantId;
    if (tenantFactory && tid && tid !== 'default') return tenantFactory.getTenantOS(tid);
    return os;
  }

  /**
   * Companion 访问门控（C 端专属）：
   *   1. 仅用户会话可用——拒绝 API-key 主体（apikey:* sub）。API-key 面向服务端集成/企业
   *      自动化，且静态 key 被强制 planId='free'（plugins/auth.ts），不应打开个人版 UI。
   *   2. enterprise plan 账号走企业控制台，不进 companion UI。
   * 与 roadmap Phase 2.1「/api/v1/companion/* 要求账号 plan ≠ enterprise」一致并收紧。
   *
   * 说明：plan 取自 JWT 的 planId，正常登录/刷新会嵌入当前订阅 plan。陈旧 token 的 plan
   * 时效性是平台级 token 策略问题（非本路由职责）；这里做显式的主体类型 + plan 双重拒绝。
   */
  function assertCompanionAccess(request: FastifyRequest): void {
    const user = request.user as JwtPayload | undefined;
    /* 主体类型门：API-key 主体（apikey:* sub）+ service 角色都不是个人用户会话。
     * 双重判定（sub 前缀 + role）避免未来某条 token 签发路径只满足其一时漏网。 */
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

  const driftThresholdFallback = {
    warning: config.safety.drift.warningThreshold,
    critical: config.safety.drift.criticalThreshold,
  };

  /* companion 响应是按用户/租户私有数据：标 Cache-Control: private, no-store + Vary，
   * 让任何 HTTP 缓存（含 SW/CDN/代理）不跨会话复用。配合前端 SW 在 login/logout 清缓存，
   * 双重防换账号回显（Codex Critical）。在各 handler 内对 reply 设置——不用全局 onSend hook
   * （那会作用于所有路由，且 reply 已 sent 时 reply.header 抛 ERR_HTTP_HEADERS_SENT）。 */
  function setPrivateNoStore(reply: FastifyReply): void {
    reply.header('Cache-Control', 'private, no-store');
    reply.header('Vary', 'Authorization, X-Tenant-Id');
  }

  /* 记忆分页读取复用企业版 MemoryFacade（含 confidence 富集 + 租户隔离），C 端只做映射。 */
  const memoryFacade = new MemoryFacade(os, tenantFactory, config);

  /* GET /api/v1/companion/me —「我的数字人」主页 */
  app.get('/api/v1/companion/me', async (request, reply) => {
    assertCompanionAccess(request);
    setPrivateNoStore(reply);
    const core = getOS(request).core;

    const allValues = [...core.values.getAll().values()];
    const topValues = [...allValues]
      .sort((a, b) => b.weight - a.weight)
      .slice(0, TOP_VALUES_LIMIT)
      .map(toCompanionValue);

    const allMemories = [...core.memories.getAllMemories().values()];
    const recentMemories = [...allMemories]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, RECENT_MEMORIES_LIMIT)
      .map(toCompanionMemory);

    const payload: CompanionMeV1 = {
      schemaVersion: 'companion-me.v1',
      narrative: core.narrative.get(),
      topValues,
      recentMemories,
      valueCount: allValues.length,
      memoryCount: allMemories.length,
    };
    /* 序列化前用契约 schema 校验，确保后端输出与前端类型同源（漂移即测试失败）。 */
    return { data: CompanionMeV1Schema.parse(payload) };
  });

  /* GET /api/v1/companion/me/growth —「你最近探索的方向」（drift 的 C 端渲染） */
  app.get('/api/v1/companion/me/growth', async (request, reply) => {
    assertCompanionAccess(request);
    setPrivateNoStore(reply);
    const thresholds = resolveDriftThresholds(db, driftThresholdFallback);
    const analyzer = new PersonaDriftAnalyzer(db, thresholds);
    const report = analyzer.getLatest(request.tenantId);
    /* ≥2 个快照才算有可对比的历史基线（单快照报告的 baselineSnapshotId 是「当前」快照）。 */
    const hasComparisonBaseline = countTenantSnapshots(db, request.tenantId) >= 2;
    return { data: CompanionGrowthV1Schema.parse(driftReportToGrowth(report, hasComparisonBaseline)) };
  });

  /* GET /api/v1/companion/me/memories —「我的记忆」分页浏览（复用 MemoryFacade.listMemories） */
  app.get('/api/v1/companion/me/memories', async (request, reply) => {
    assertCompanionAccess(request);
    setPrivateNoStore(reply);
    const { page, pageSize } = parsePagination(request.query as Record<string, unknown>);
    const result = memoryFacade.listMemories(request.tenantId, page, pageSize);
    /* MemoryNodeWithConfidence extends MemoryNode → toCompanionMemory 直接可用（多余字段丢弃）。 */
    const payload: CompanionMemoryListV1 = {
      schemaVersion: 'companion-memory-list.v1',
      items: result.data.map(toCompanionMemory),
      pagination: result.pagination,
    };
    return { data: CompanionMemoryListV1Schema.parse(payload) };
  });

  /* 构造主动消息 store（tenant-scoped DB + clock）。ADR-0054 Phase 2 管道。 */
  function proactiveStore(request: FastifyRequest): ProactiveMessageStore {
    const tenantOS = getOS(request);
    return new ProactiveMessageStore(tenantOS.getDatabase(), () => tenantOS.getClock().now(), request.tenantId);
  }

  /* GET /api/v1/companion/me/nudges —「TA 主动跟我说的」未读主动消息（ADR-0054 Phase 2） */
  app.get('/api/v1/companion/me/nudges', async (request, reply) => {
    assertCompanionAccess(request);
    setPrivateNoStore(reply);
    const { status, limit } = parseNudgeQuery(request.query as Record<string, unknown>);
    const rows = proactiveStore(request).list(COMPANION_PERSONA_ID, { status, limit });
    /* 契约校验：后端输出严格符合前端共享类型 CompanionNudgeListV1（防 DTO 漂移）。 */
    const payload: CompanionNudgeListV1 = {
      schemaVersion: 'companion-nudge-list.v1',
      items: rows.map(toCompanionNudge),
    };
    return { data: CompanionNudgeListV1Schema.parse(payload) };
  });

  /* POST /api/v1/companion/me/nudges/:id/read — 标记主动消息已读（归属校验，绝不跨租户） */
  app.post<{ Params: { id: string } }>('/api/v1/companion/me/nudges/:id/read', async (request, reply) => {
    assertCompanionAccess(request);
    setPrivateNoStore(reply);
    const outcome = proactiveStore(request).markRead(request.params.id, COMPANION_PERSONA_ID);
    /* 仅「不存在/非本租户」→ 404；「已读」幂等 → 200（客户端重试友好，Codex 建议）。 */
    if (outcome === 'not_found') {
      throw new NotFoundError('主动消息不存在', ErrorCode.NOT_FOUND_PROACTIVE_MESSAGE);
    }
    return { data: { id: request.params.id, status: 'read' } };
  });

  /* BYOK 解析 per-tenant LLM key（缺失回退全局 config）——reflect 的「反思老师」。 */
  const reflectLlmEncryption = tryByokEncryption(config.encryption);
  /* 反思配额：与 perceive 同套路（route 级 per-feature 配额，防 BYOK/平台 key 被刷爆）。 */
  const reflectQuota = QuotaManager.fromResolver(new SingleDbResolver(db));

  /* POST /api/v1/companion/me/reflect —「自主学习」：让数字人反思已学记忆，自己内化成长。
   * ADR-0047 growth 档：LLM 当老师反思最近高显著记忆 + 叙事 → 产成长候选（value_shift/memory_edge/
   * narrative_patch）过统一蒸馏门。这是**摄取/成长阶段**，运行时 chat 仍零-LLM。 */
  app.post('/api/v1/companion/me/reflect', async (request, reply) => {
    assertCompanionAccess(request);
    setPrivateNoStore(reply);
    const tenantOS = getOS(request);
    const core = tenantOS.core;

    /* 从已水合的核心存储读（与 /me 同路径），不用 getState() 快照——后者对 companion 可能未水合。 */
    const memories: ReflectMemory[] = [...core.memories.getAllMemories().values()]
      .sort((a, b) => b.salience - a.salience)
      .slice(0, 24)
      .map((m) => ({ id: m.id, content: m.content, salience: m.salience, valence: m.valence }));
    if (memories.length === 0) {
      return { data: { candidatesIngested: 0, reason: 'no_material' } };
    }

    /* 配额先于任何有成本/有副作用的步骤扣减：超额拒绝且**无 core 副作用**（不写 genesis、不调 LLM）。
     * no_material 短路不扣 quota（无意义的空请求）。未设限额的租户默认无限。 */
    if (!reflectQuota.consumeQuota(request.tenantId, 'reflection')) {
      throw new QuotaExceededError('反思配额已用尽，请稍后再试');
    }

    /* 反思必须有价值内核可强化。已学了记忆却无价值内核的人格（perceive 只写记忆/边、不建价值，
     * 且未经出生扰动播种价值）——在此一次性 bootstrap 经理人价值底盘（genesis）。幂等且 pristine：
     * 仅当 values 为空时建，对已有价值的人格零副作用（不覆写出生扰动/已学价值）。之后反思据记忆强化。 */
    ensureCompanionGenesisValues(core, tenantOS.getLogger());
    const values: ReflectValue[] = [...core.values.getAll().values()].map((v) => ({ id: v.id, label: v.label, weight: v.weight }));
    if (values.length === 0) {
      return { data: { candidatesIngested: 0, reason: 'no_values' } };
    }

    /* BYOK：解析本租户有效 LLM 配置（缺失回退全局 config 的 gpt-5.5 老师）。 */
    const effectiveLlm = resolveTenantLlmConfig(db, request.tenantId, config.intelligence, reflectLlmEncryption);
    const llm = new ModelRouter({
      provider: effectiveLlm.provider as LLMProviderName,
      model: effectiveLlm.model,
      embeddingModel: effectiveLlm.embeddingModel,
      apiKey: effectiveLlm.apiKey,
      baseUrl: effectiveLlm.baseUrl,
      fallbacks: config.intelligence.fallbacks,
      maxTokens: config.intelligence.maxTokens,
      temperature: config.intelligence.temperature,
      timeoutMs: config.intelligence.timeoutMs || undefined,
      tenantId: request.tenantId,
    });
    const distiller = new LlmReflectionDistiller(tenantOS.distillation, llm, tenantOS.getLogger());
    /* 独立反思触发（无并发认知周期）→ appliedDeltas 空。 */
    const result = await distiller.distill({
      personaId: COMPANION_PERSONA_ID, narrative: core.narrative.get(), values, memories, appliedDeltas: new Map(),
    });
    /* 区分自动编译 vs 待审批（实际门控由 DistillationService.canAutoCompile 决定）：
     * narrative_patch 恒入待审批（改「我是谁」更谨慎）；memory_edge 足证据自动编译；
     * value_shift 在 confidence≥阈值 ∧ |delta|≤MAX_REFLECTION_DELTA ∧ patternAgrees 时可自动编译，
     * 否则入待审批。两类都算「自反思产出的成长」。 */
    const compiled = result.results.filter((r) => r.status === 'compiled').length;
    const pending = result.results.filter((r) => r.status === 'pending').length;
    return { data: { candidatesIngested: result.candidatesIngested, compiled, pending } };
  });

  /* POST /api/v1/companion/me/grow —「确定性成长」：不需要任何 LLM/BYOK key，数字人也能从已沉淀
   * 记忆里**自主成长**——跑一次确定性认知周期（记忆固化 episodic→semantic、衰减遗忘、容量淘汰、
   * 强情绪事件→即时价值漂移、统计模式提取→价值漂移），全部零-LLM 确定性，经统一成长门控落地。
   *
   * 为什么要这个：/reflect 是「LLM 当老师」的语义内化，无 key 用户碰不到。但成长不该只属于配了
   * key 的人——MemoryPatternExtractor 的确定性反思（固化/衰减/模式→价值漂移）本就零-LLM，此前只在
   * avatar-autorun 内部周期跑，companion 单人格用户没有触发入口。此端点把它暴露给 C 端，让「无云
   * LLM 也能成长」这条产品承诺对无 key 用户也成立（对话零-LLM + 成长零-LLM，两条都不依赖外部老师）。
   *
   * 与 /reflect 的分工：/grow=确定性自省（从既有记忆里沉淀规律，无需外部知识）；/reflect=LLM 老师
   * 语义内化（需 key，能产更丰富的 value_shift/narrative 候选）。两者互补，/grow 是 /reflect 的零-LLM 底座。 */
  app.post('/api/v1/companion/me/grow', async (request, reply) => {
    assertCompanionAccess(request);
    setPrivateNoStore(reply);
    const tenantOS = getOS(request);
    const core = tenantOS.core;

    /* 无记忆 → 无可成长的材料，短路不扣配额（与 /reflect 的 no_material 同语义）。 */
    if (core.memories.getAllMemories().size === 0) {
      return { data: { grew: false, reason: 'no_material' } };
    }
    /* 配额（复用 reflection 口径）：确定性无 LLM 成本，但仍限流防滥用刷价值漂移。 */
    if (!reflectQuota.consumeQuota(request.tenantId, 'reflection')) {
      throw new QuotaExceededError('成长配额已用尽，请稍后再试');
    }
    /* 反思须有价值内核可强化——与 /reflect 一致：仅当 values 为空时一次性 bootstrap（幂等、pristine）。 */
    ensureCompanionGenesisValues(core, tenantOS.getLogger());
    /* 确定性认知周期（零-LLM）：固化/衰减/淘汰 + 情绪事件/模式提取 → 价值漂移（经 UpdateGate）。 */
    const cycle = tenantOS.runCognitionCycle();
    return {
      data: {
        grew: cycle.patternsFound > 0 || cycle.emotionalEvents > 0 || cycle.consolidatedCount > 0,
        consolidated: cycle.consolidatedCount,
        patternsFound: cycle.patternsFound,
        emotionalEvents: cycle.emotionalEvents,
        decayed: cycle.decayedCount,
        evicted: cycle.evictedCount,
      },
    };
  });

  /* POST /api/v1/companion/me/learn-topic —「给个主题让它自己学」（ADR-0047「LLM 当老师」）。
   * 你填一个主题（如「Java」）→ 配好的 LLM 老师**就该主题产出一段知识**（学习材料）→ 走**既有感知
   * 蒸馏管线**（同 perceive：LlmPerceptionProvider.analyze → PerceptionDistiller → 蒸馏门）→ 沉淀成
   * 记忆。之后 chat 就能**零-LLM**据这些记忆答该主题。LLM 只在此摄取阶段被调（两次：产知识 + 抽事实），
   * 绝不进 runtime。无 LLM 老师（provider 无 key/非 ollama）→ 明确报错引导去配（不静默确定性回退——
   * 「学主题」离开真老师无意义，不同于 perceive 有确定性 mock 兜底）。 */
  const learnTopicQuota = QuotaManager.fromResolver(new SingleDbResolver(db));
  app.post('/api/v1/companion/me/learn-topic', async (request, reply) => {
    assertCompanionAccess(request);
    setPrivateNoStore(reply);
    const body = CompanionLearnTopicRequestV1Schema.parse(request.body);
    const tenantOS = getOS(request);
    const userId = (request.user as JwtPayload | undefined)?.sub ?? null;

    /* 学习配额（与 perception 同套路——每次调 LLM 老师有成本）。 */
    if (!learnTopicQuota.consumeQuota(request.tenantId, 'perception')) {
      throw new QuotaExceededError('学习配额已用尽，请稍后再试');
    }

    /* BYOK 解析有效 LLM。必须真有老师可用（有 key 的云 provider 或 ollama）——否则「学主题」无意义。 */
    const effectiveLlm = resolveTenantLlmConfig(db, request.tenantId, config.intelligence, reflectLlmEncryption);
    const hasUsableTeacher = effectiveLlm.provider === 'ollama' || !!effectiveLlm.apiKey;
    if (!hasUsableTeacher) {
      throw new ValidationError('尚未接入可用的 LLM 老师——请先在「学习」页配置 provider + API key（或用本机 Ollama），再让它学主题');
    }
    const llm = new ModelRouter({
      provider: effectiveLlm.provider as LLMProviderName,
      model: effectiveLlm.model,
      embeddingModel: effectiveLlm.embeddingModel,
      apiKey: effectiveLlm.apiKey,
      baseUrl: effectiveLlm.baseUrl,
      fallbacks: config.intelligence.fallbacks,
      maxTokens: config.intelligence.maxTokens,
      temperature: config.intelligence.temperature,
      timeoutMs: config.intelligence.timeoutMs || undefined,
      tenantId: request.tenantId,
    });

    /* ① 取学习材料。**优先调 WebSearch 工具抓真实网页**（ADR-0060「调用工具学习」——学到的是当前、
     *    可溯源的真资料，而非 LLM 凭训练记忆凭空讲，避免过时/编造）。仅当配了真搜索 provider
     *    （非 mock + 有 key）时用；否则退回 LLM 老师就主题产知识。SSRF 安全：WebSearchTool 直连
     *    Exa/Serper HTTPS、不走用户 URL。 */
    let material = '';
    let groundedBy: 'web_search' | 'llm_teacher' = 'llm_teacher';
    const ws = config.agent.webSearch;
    const webSearchUsable = ws.provider !== 'mock' && !!ws.apiKey;
    if (webSearchUsable) {
      /* 搜索失败（坏 key/超时/provider 5xx）**不 500**——记日志后优雅回退 LLM 老师（下面），保证「学」这个
       * 动作不因搜索抖动而崩。成功则用真网页片段当学习材料。 */
      try {
        const tool = new WebSearchTool({
          provider: ws.provider, apiKey: ws.apiKey,
          maxResults: ws.maxResults, maxContentLength: ws.maxContentLength, costCentsPerCall: ws.costCentsPerCall,
        }, tenantOS.getLogger());
        const res = await tool.invoke({
          tenantId: request.tenantId, personaId: COMPANION_PERSONA_ID,
          invokerType: 'internal', invokerId: userId ?? 'local', invokerUserId: userId,
          arguments: { query: body.topic, topK: 5 },
          deadline: Date.now() + 20_000,
        });
        const searchJson = res.content.find((c) => c.type === 'json') as { json?: { results?: Array<{ title?: string; snippet?: string; url?: string }> } } | undefined;
        const snippets = (searchJson?.json?.results ?? [])
          .map((r) => `- ${r.title ?? ''}：${r.snippet ?? ''}（来源 ${r.url ?? ''}）`)
          .join('\n')
          .trim();
        if (snippets) {
          material = snippets;
          groundedBy = 'web_search';
        } else {
          tenantOS.getLogger().warn('learn-topic', `web_search 就「${body.topic}」无结果，回退 LLM 老师`);
        }
      } catch (err) {
        tenantOS.getLogger().warn('learn-topic', `web_search 失败，回退 LLM 老师: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (!material) {
      /* 无搜索 key / 搜索无结果或失败 → LLM 老师就主题产知识（次选）。
       * LLM 调用失败（坏 key/错 model/网关 4xx-5xx）→ 转**明确 4xx**（不裸抛 500 让用户看「internal server
       * error」摸不着头脑）——把底层原因（如「HTTP 401: 无效的API Key」）带给用户，好排查网关配置。 */
      let gen;
      try {
        gen = await llm.chat([
          { role: 'system', content: [
            '你是数字人格的「学习老师」。学习者要学一个主题——写一段该主题的核心知识供其内化为记忆。',
            '先给要点式核心知识（每条独立一句、事实性）；**若该主题适合用例子说明（如编程/算法/操作步骤），',
            '再附一个具体、完整、可直接用的例子**（编程主题给可运行代码，用 ``` 代码块包裹并注明语言）。',
            '只输出知识与例子本身，不要寒暄。',
          ].join('\n') },
          { role: 'user', content: `我要学习的主题：${body.topic}` },
        ], { temperature: 0.4 });
      } catch (err) {
        throw new ValidationError(`LLM 老师调用失败——请检查「学习」页的 provider/baseURL/model/API key：${err instanceof Error ? err.message : String(err)}`);
      }
      material = gen.content.trim();
      groundedBy = 'llm_teacher';
      if (!material) {
        throw new ValidationError('未能就该主题产出可学内容，请换个说法或稍后再试');
      }
    }

    /* ② 走既有感知蒸馏管线把材料沉淀成记忆（LlmPerceptionProvider 抽事实 → 蒸馏门 → memories）。
     *    web_search 抓的真资料同样交给 LLM 抽事实——LLM 只做「读资料→抽事实」，知识来源是真网页。
     *    此步也调 LLM（抽事实）——同样 try/catch 转明确 4xx，不裸抛 500。 */
    const provider = new LlmPerceptionProvider(llm);
    const distiller = new PerceptionDistiller(provider, tenantOS.core.memories, tenantOS.distillation);
    const representation = `关于「${body.topic}」，我学到：\n${material}`;
    let result;
    try {
      result = await distiller.perceive({
        personaId: COMPANION_PERSONA_ID,
        tenantId: request.tenantId,
        media: {
          modality: 'audio',
          mediaSha256: createHash('sha256').update(representation).digest('hex'),
          durationMs: 0,
          representation,
        },
      });
    } catch (err) {
      throw new ValidationError(`学习材料消化失败（LLM 老师抽取事实时出错）——请检查 LLM 配置：${err instanceof Error ? err.message : String(err)}`);
    }

    /* ③ 除了蒸馏出的「概念事实」（≤500 字摘要，答概念用），**再把原始学习材料按块存为逐字参考记忆**
     *    ——尤其代码例子（易 >500 字，会被 fact 抽取丢弃）。这样问「写个例子」时零-LLM 检索能吐出完整
     *    代码块，而非只有概念碎片（用户实测缺口）。直接 core.addMemory 存 semantic 记忆（绕过 fact
     *    抽取的 500 字上限；存储层无长度限）；代码块整块不拆（保代码完整），其余段落各成一条。
     *    salience 略低于蒸馏事实（参考料，非核心洞察），不喧宾夺主。 */
    const referenceMemoryIds = storeLearnedReference(tenantOS, body.topic, material);
    const learnedMemories = [...result.memoryIds, ...referenceMemoryIds].map((id) => {
      const node = tenantOS.core.memories.getMemory(id);
      return { id, content: node?.content ?? '' };
    });
    return { data: {
      schemaVersion: 'companion-learn-topic-result.v1',
      topic: body.topic,
      learnedMemoryCount: learnedMemories.length,
      learnedMemories,
      teacherFailed: result.teacherFailed ?? false,
      /* 透明度：知识来自真网页搜索（web_search）还是 LLM 老师凭知识讲（llm_teacher）。 */
      groundedBy,
    } };
  });

  /* ── LLM 老师接入配置（ADR-0047「LLM 当老师」C 端补全）─────────────────────────────
   * 让单机/个人用户给自己的数字人**接一个 LLM 老师**（用于 reflect/perceive 成长期；运行时 chat 仍
   * 零-LLM）。三种合规接入：
   *   - openai/anthropic + API key（BYOK；官方开发者 API 额度）
   *   - 任意 provider + 自定义 baseUrl（+可选 key）→ 接 OpenAI 兼容网关/订阅代理（subscription 用户
   *     的合规接入方式；官方不开放订阅登录态跑 API，故经用户自备的兼容端点）
   *   - ollama（本机开源模型，零 key 零订阅，纯本地）
   * key 经 FieldEncryption 加密落库，**明文绝不持久化、GET 绝不回传**（只回 hasApiKey 布尔）。 */
  const llmSettingsEncryption = tryByokEncryption(config.encryption);

  /* GET：当前 LLM 老师配置（provider/model/baseUrl + 是否已配 key + 全局默认 provider）。绝不回 key 明文。 */
  app.get('/api/v1/companion/me/llm-settings', async (request, reply) => {
    assertCompanionAccess(request);
    setPrivateNoStore(reply);
    const settings = new TenantLlmSettingsStore(db, request.tenantId).get();
    const activeProvider = settings?.active_provider ?? config.intelligence.provider;
    /* 是否已配该 provider 的 BYOK key（加密不可用则恒 false——无法安全存 key）。绝不回 key 本身。 */
    let hasApiKey = false;
    if (llmSettingsEncryption) {
      hasApiKey = new LlmCredentialStore(db, llmSettingsEncryption, request.tenantId).get(activeProvider) !== undefined;
    }
    return { data: {
      schemaVersion: 'companion-llm-settings.v1',
      activeProvider,
      model: settings?.model ?? null,
      baseUrl: settings?.base_url ?? null,
      hasApiKey,
      /* 加密未启用时无法存 BYOK key（只能用 ollama/自定义端点无鉴权，或全局配置）——告知前端。 */
      canStoreApiKey: llmSettingsEncryption !== undefined,
      /* 全局默认（用户未设偏好时的回退），供 UI 展示「当前用全局/gpt-5.5 老师」。 */
      globalProvider: config.intelligence.provider,
    } };
  });

  /* PUT：设置 LLM 老师。body: { provider, model?, baseUrl?, apiKey? }。
   *   - provider 必填且合法（openai/anthropic/ollama）。
   *   - apiKey 提供且加密可用 → 加密落库该 provider 的 key；apiKey='' → 删除该 provider 的 key。
   *   - model/baseUrl 空串 → 清除覆盖（回退全局/该 provider 默认）。
   *
   * ⚠️ SSRF 部署边界（Codex 复审）：自定义 baseUrl 让服务端向用户给定 URL 发请求。本端点为**桌面单机
   *    loopback sidecar 信任模型**设计——用户指向 127.0.0.1（本机 ollama）是正当用途，故这里**不**阻断
   *    私网 IP（阻断会废掉本地 ollama 主用例）。契约仅收窄到 http(s) scheme。若此路由在 **hosted/多租户**
   *    部署开放，必须在部署层追加私网 IP 阻断 / host allowlist（src/security/ssrf-guard.ts 可用），或
   *    仅桌面构建启用本端点——否则是 SSRF 面。resolveTenantLlmConfig 既有安全门仍在：租户覆盖 base_url
   *    时绝不外送平台 key（只用租户 BYOK key），故即便被滥用也不泄露平台凭据。 */
  app.put('/api/v1/companion/me/llm-settings', async (request, reply) => {
    assertCompanionAccess(request);
    setPrivateNoStore(reply);
    const body = CompanionLlmSettingsRequestV1Schema.parse(request.body);
    const now = getOS(request).getClock().now();
    const userId = (request.user as JwtPayload | undefined)?.sub ?? null;

    /* **前置校验所有先决条件，再落任何库**（Codex 复审：原子性）——避免「偏好写了但 key 因加密不可用
     * 报错」的部分写入，让用户误以为 key 存了。非空 apiKey 但加密不可用 → 直接拒，此时 upsert 尚未执行。 */
    const wantsStoreKey = body.apiKey !== undefined && body.apiKey !== '';
    if (wantsStoreKey && !llmSettingsEncryption) {
      throw new ValidationError('本机未启用凭据加密，无法安全保存 API key；可改用 Ollama 或自定义端点（无需 key）');
    }

    /* 存偏好（provider/model/baseUrl）。非法 provider 由 store.upsert 前的枚举校验挡。 */
    new TenantLlmSettingsStore(db, request.tenantId).upsert({
      activeProvider: body.provider,
      model: body.model ?? null,
      baseUrl: body.baseUrl ?? null,
      updatedBy: userId,
      now,
    });

    /* 处理该 provider 的 API key：
     *   - apiKey==='' → 撤销（**加密可用与否都执行**——删无需解密，走 static deleteCredential，
     *     修 Codex 复审「无加密撤销 no-op」缺陷：否则关加密后撤销不生效、旧密文残留可能复活）。
     *   - apiKey 非空 → 存（加密已在前置校验确认可用）。
     *   - apiKey===undefined → 不动既有 key。 */
    let keyStored = false;
    if (body.apiKey === '') {
      LlmCredentialStore.deleteCredential(db, request.tenantId, body.provider);
    } else if (body.apiKey !== undefined && llmSettingsEncryption) {
      keyStored = new LlmCredentialStore(db, llmSettingsEncryption, request.tenantId)
        .store(body.provider, body.apiKey, userId, now);
    }
    return { data: { schemaVersion: 'companion-llm-settings.v1', activeProvider: body.provider, keyStored } };
  });

  /* DELETE：清除本租户 LLM 偏好（恢复全局默认老师）。不删已存 key（key 撤销走 PUT apiKey=''）。 */
  app.delete('/api/v1/companion/me/llm-settings', async (request, reply) => {
    assertCompanionAccess(request);
    setPrivateNoStore(reply);
    new TenantLlmSettingsStore(db, request.tenantId).delete();
    return { data: { schemaVersion: 'companion-llm-settings.v1', reset: true } };
  });

  /* POST /api/v1/companion/me/translate —「内容多语」：成长期 LLM 老师把记忆内容翻译成目标语言，
   * 存 memory_translations。ADR-0055 内容多语成长档——运行时 chat 只读取已存变体（零-LLM）。
   * 增量：只翻译尚无该语言变体的记忆（幂等、省 token）。 */
  app.post('/api/v1/companion/me/translate', async (request, reply) => {
    assertCompanionAccess(request);
    setPrivateNoStore(reply);
    const tenantOS = getOS(request);

    /* 目标语言：body.language，必须是受支持 locale。 */
    const rawLang = (request.body as { language?: unknown } | undefined)?.language;
    if (typeof rawLang !== 'string' || !isSupportedLocale(rawLang)) {
      throw new ValidationError('language 必须是受支持的语言（en / zh-CN）');
    }
    const targetLanguage: SupportedLocale = rawLang;

    const translationStore = new MemoryTranslationStore(db, request.tenantId);
    const already = translationStore.translatedIds(targetLanguage);
    /* 只翻译尚无该语言变体的记忆（增量）。稳定排序（createdAt+id）让多次调用顺序确定、可续翻。 */
    const allPending: TranslatableMemory[] = [...tenantOS.core.memories.getAllMemories().values()]
      .filter((m) => !already.has(m.id) && m.content.trim().length > 0)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      .map((m): TranslatableMemory => ({ id: m.id, content: m.content }));
    if (allPending.length === 0) {
      return { data: { translated: 0, remaining: 0, hasMore: false, reason: 'up_to_date' } };
    }
    /* **有界同步**（Codex 复审 High）：单次最多翻译 MAX_TRANSLATE_PER_CALL 条，避免长任务超时
     * （HTTP 报失败但库已部分写）。增量幂等（translatedIds 跳过已翻），客户端据 hasMore 多次调用续翻。 */
    const pending = allPending.slice(0, MAX_TRANSLATE_PER_CALL);

    /* 配额：在调 LLM（有成本）前扣减；超额拒绝、无副作用。 */
    if (!reflectQuota.consumeQuota(request.tenantId, 'translation')) {
      throw new QuotaExceededError('翻译配额已用尽，请稍后再试');
    }

    /* BYOK：解析本租户有效 LLM 配置（缺失回退全局 config 老师）。 */
    const effectiveLlm = resolveTenantLlmConfig(db, request.tenantId, config.intelligence, reflectLlmEncryption);
    const llm = new ModelRouter({
      provider: effectiveLlm.provider as LLMProviderName,
      model: effectiveLlm.model,
      embeddingModel: effectiveLlm.embeddingModel,
      apiKey: effectiveLlm.apiKey,
      baseUrl: effectiveLlm.baseUrl,
      fallbacks: config.intelligence.fallbacks,
      maxTokens: config.intelligence.maxTokens,
      temperature: config.intelligence.temperature,
      timeoutMs: config.intelligence.timeoutMs || undefined,
      tenantId: request.tenantId,
    });
    const translator = new LlmTranslationService(llm, tenantOS.getLogger());

    /* 分批翻译并落库（每批失败安全降级返回空，不阻断其余批）。 */
    let translated = 0;
    const now = tenantOS.getClock().now();
    for (let i = 0; i < pending.length; i += TRANSLATION_BATCH_SIZE) {
      const batch = pending.slice(i, i + TRANSLATION_BATCH_SIZE);
      const result = await translator.translate(batch, targetLanguage);
      for (const [memoryId, text] of result) {
        translationStore.upsert(memoryId, targetLanguage, text, now);
        translated += 1;
      }
    }
    /* remaining 按**实际写入数**算（不是 pending 切片数）——本批内 LLM/JSON 失败未写入的条目仍算未翻，
     * 下次会重试（translatedIds 不含它们）。避免部分失败时 hasMore 误报 false（Codex 复审）。 */
    const remainingAfter = allPending.length - translated;
    return { data: { translated, remaining: remainingAfter, hasMore: remainingAfter > 0, language: targetLanguage } };
  });
}

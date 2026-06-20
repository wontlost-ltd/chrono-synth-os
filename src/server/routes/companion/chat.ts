/**
 * ChronoCompanion C 端路由 — 跟数字人对话（ADR-0047「跑为你拥有的人格」C 端落地）。
 *
 * **运行时零 LLM**：回应由确定性 OfflineConversationResponder 据人格叙事 + 自己沉淀的记忆（关键词
 * 检索）生成。离线/无云仍能聊——这是 ADR-0047 核心论点的 C 端体现：数字人是你拥有的、可离线运行的
 * 人格，LLM 只在成长阶段当老师，不在运行时。
 *
 * ADR-0055「对话即经历」：回应**完全确定后**，把这轮对话确定性沉淀为低显著 episodic 记忆——
 * read-then-append，让数字人「记得跟你聊过」（如被起名张三）。沉淀是确定性 append 而非语义理解，
 * 论点不破；身份核（价值/叙事）仍只读。语义内化仍走 reflect（联网），对话记忆成其原料。
 *
 * 论点红线：
 *   - 绝不调 LLM（回应生成是纯确定性）。可复现性 = 「相同输入 + 相同人格状态 + 相同配置 → 相同回应
 *     与相同状态变更」；chat 现在是确定性状态转移（read-then-append），非无副作用只读。
 *   - 只改记忆层（追加经历），绝不改身份核（价值/叙事/认知模型）。
 *   - never_discuss 输入/输出自检：喂 companion 基线安全边界（凭证类敏感主题），离线同样强制；
 *     敏感输入（boundary_block）绝不沉淀为记忆；per-persona 自定义边界是后续。
 *
 * 复用 companion/me.ts 的访问门 + 租户隔离 + 私有缓存头 + perception 同款配额口径。
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { ChronoSynthOS } from '../../../chrono-synth-os.js';
import type { TenantOSFactory } from '../../../multi-tenant/tenant-os-factory.js';
import type { IDatabase } from '../../../storage/database.js';
import type { JwtPayload } from '../../../types/auth.js';
import { AuthorizationError, QuotaExceededError, ErrorCode } from '../../../errors/index.js';
import { QuotaManager } from '../../../multi-tenant/quota-manager.js';
import {
  CompanionChatRequestV1Schema,
  CompanionChatResultV1Schema,
  type CompanionChatResultV1,
} from '@chrono/contracts';
import { OfflineConversationResponder } from '../../../conversation/offline-conversation-responder.js';
import { tokenize, scoreTextByKeyword } from '../../../conversation/conversation-knowledge-retriever.js';
import { retrieveMemoriesDeterministic } from '../../../conversation/deterministic-memory-retrieval.js';
import type { ContentFor } from '../../../conversation/deterministic-memory-retrieval.js';
import { MemoryTranslationStore } from '../../../storage/memory-translation-store.js';
import type { RelevantKnowledge } from '../../../conversation/conversation-types.js';
import { COMPANION_BASELINE_BOUNDARIES } from '../../../conversation/companion-boundaries.js';
import { buildRecentGrowthPhrase } from './recent-growth.js';
import { buildConversationCallback } from './conversation-callback.js';
import { ResponseTemplateStore } from '../../../storage/response-template-store.js';
import {
  decideConversationCapture,
  CONVERSATION_MEMORY_SALIENCE,
  CONVERSATION_MEMORY_VALENCE,
} from '../../../conversation/conversation-memory-capture.js';
import { detectIdentityIntent, detectUserName } from '../../../conversation/identity-intent.js';
import { CompanionIdentityStore } from '../../../storage/companion-identity-store.js';
import { detectLanguage } from '../../../conversation/language-detect.js';
import { companionLocale } from '../../../conversation/companion-locale.js';
import { CompanionMoodStore } from '../../../storage/companion-mood-store.js';
import { updateMood, extractEmotionSignal, moodLabel, type MoodLabel } from '../../../conversation/mood.js';
import { CompanionRelationshipStore } from '../../../storage/companion-relationship-store.js';
import { timeGap, daysSinceFirstMet } from '../../../conversation/temporal.js';
import { detectSummaryIntent, buildSummary } from '../../../conversation/summary-builder.js';
import type { SupportedLocale } from '../../../i18n/locale-resolver.js';
import type { AppConfig } from '../../../config/schema.js';

/** companion 默认人格 id（与 perceive/environment 一致）。 */
const COMPANION_PERSONA_ID = 'default';
/** 命中 response_template 的最小 intent 关键词分门槛——高于记忆 grounding 门槛，避免泛匹配抢答整段模板。 */
const MIN_TEMPLATE_INTENT_SCORE = 2;
/** 自我介绍综述取多少条高 salience 记忆。 */
const SELF_INTRO_MEMORY_LIMIT = 4;
/** 自我介绍综述取多少个高权重价值观。 */
const SELF_INTRO_VALUE_LIMIT = 3;
/* 自我介绍元意图关键词（「介绍你自己/你是谁/introduce yourself」）已移到 companion-locale 按 locale 取，
 * 见 detectSelfIntroIntent。 */
/* companion 基线安全边界（never_discuss）已抽到 ../../../conversation/companion-boundaries.js
 * （chat / 主动 nudge 共用同一份，避免漂移）。 */

export function registerCompanionChatRoutes(
  app: FastifyInstance,
  os: ChronoSynthOS,
  tenantFactory: TenantOSFactory | undefined,
  db?: IDatabase,
  config?: AppConfig,
): void {
  const sharedDb = db ?? os.getDatabase();
  const quotaManager = new QuotaManager(sharedDb);
  /* 离线回应器：无 matcher（回退保守子串匹配——已足够匹配基线敏感主题的 never_discuss 自检）。 */
  const responder = new OfflineConversationResponder();
  /* 对话记忆开关（ADR-0055）：缺省（无 config）默认开，与 schema 默认一致。 */
  const conversationMemoryEnabled = config?.companion.conversationMemoryEnabled ?? true;
  /* 情绪/心情开关（ADR-0056）：缺省默认开。 */
  const moodEnabled = config?.companion.moodEnabled ?? true;
  /* 我-你关系记忆开关（ADR-0056）：缺省默认开。 */
  const relationshipEnabled = config?.companion.relationshipEnabled ?? true;
  /* 时间感知开关（ADR-0056）：缺省默认开。依赖 relationship 已存的时间戳。 */
  const temporalEnabled = config?.companion.temporalEnabled ?? true;
  /* 观点/不确定立场开关（ADR-0056）：缺省默认开。 */
  const opinionEnabled = config?.companion.opinionEnabled ?? true;
  /* 回应变化性开关（ADR-0056）：缺省默认开。 */
  const variabilityEnabled = config?.companion.variabilityEnabled ?? true;
  /* 内在驱动·主动性开关（ADR-0056 block 6）：缺省默认开。 */
  const proactiveEnabled = config?.companion.proactiveEnabled ?? true;

  /** 取某记忆的 valence（用于心情漂移的次要信号）。 */
  function memoryValenceOf(tenantOS: ChronoSynthOS, memoryId: string): number | undefined {
    return tenantOS.core.memories.getMemory(memoryId)?.valence;
  }
  /** clamp 到 [-1,1]。 */
  function clampUnit(x: number): number {
    return Number.isFinite(x) ? Math.max(-1, Math.min(1, x)) : 0;
  }

  function getOS(request: FastifyRequest): ChronoSynthOS {
    const tid = request.tenantId;
    if (tenantFactory && tid && tid !== 'default') return tenantFactory.getTenantOS(tid);
    return os;
  }

  /* 与 companion/me.ts 同款访问门：仅个人用户会话，拒 API-key/service + enterprise plan。 */
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
   * 确定性检索：委托给 deterministic-memory-retrieval 的纯函数（与检索质量基准跑同一份逻辑，
   * 不再各测一份替身）。零 LLM、零 embedding——语义在蒸馏期沉淀为边，运行期纯图遍历，
   * 保住「相同输入→相同输出」+ 离线可用。
   */
  function retrieveRelevantMemories(tenantOS: ChronoSynthOS, message: string, contentFor?: ContentFor): RelevantKnowledge[] {
    return retrieveMemoriesDeterministic(
      message,
      tenantOS.core.memories.getAllMemories(),
      (id) => tenantOS.core.memories.getEdgesFor(id),
      undefined,
      contentFor,
    );
  }

  /**
   * 确定性匹配 response_template（ADR-0047 蒸馏闭环消费端）：把用户消息分词，对每个模板的 intent
   * 按关键词打分，取最高分（≥门槛）的模板。流程型问答（如「怎么做 flat white」）由蒸馏好的整段模板
   * 流畅有序回答，而非记忆碎片拼装。零 LLM——纯关键词匹配 + 取库里预编排的整段。
   * 返回最佳模板文本与分数；无达标返回 undefined（回退记忆 grounding）。
   */
  function matchResponseTemplate(tenantId: string, message: string): string | undefined {
    const tokens = tokenize(message);
    if (tokens.length === 0) return undefined;
    const store = new ResponseTemplateStore(sharedDb, tenantId);
    let best: { template: string; score: number } | undefined;
    /* listByPersona 每 intent 每版本一行（最新在前）；同 intent 只取首见（最高版本）。 */
    const seenIntent = new Set<string>();
    for (const t of store.listByPersona(COMPANION_PERSONA_ID)) {
      if (seenIntent.has(t.intent)) continue;
      seenIntent.add(t.intent);
      const score = scoreTextByKeyword(t.intent, tokens);
      if (score >= MIN_TEMPLATE_INTENT_SCORE && (!best || score > best.score)) {
        best = { template: t.template, score };
      }
    }
    return best?.template;
  }

  /** 确定性检测自我介绍元意图（子串匹配，零模型；按 locale 取短语集）。 */
  function detectSelfIntroIntent(message: string, locale: SupportedLocale): boolean {
    const m = message.toLowerCase();
    return companionLocale(locale).selfIntroPhrases.some((p) => m.includes(p));
  }

  /**
   * 综述自我介绍（确定性，零模型）：叙事 + 最看重的价值观 + 最有印象的记忆（按 salience）。
   * 解决「介绍一下你自己」泛词查不到具体记忆 → honest_offline 的问题。无任何内容时返回 undefined
   * （回退诚实离线）。
   */
  function buildSelfIntro(tenantOS: ChronoSynthOS, locale: SupportedLocale, myName?: string, contentFor?: ContentFor, relationshipLine?: string): string | undefined {
    const t = companionLocale(locale).reply;
    const narrative = tenantOS.core.narrative.get().trim();
    /* 排序加稳定 tie-breaker（id 字典序）——底层 SELECT 无 ORDER BY，同 weight/salience 时 Map 迭代
     * 顺序跨 DB/重载会漂移，不应作为契约。加 id 二级键确保「相同人格状态相同输入→相同输出」（Codex 复审）。 */
    const topValues = [...tenantOS.core.values.getAll().values()]
      .sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id))
      .slice(0, SELF_INTRO_VALUE_LIMIT)
      .map((v) => v.label.trim())
      .filter((l) => l.length > 0);
    /* 记忆内容按 locale 取翻译变体（多语：英文 self_intro 呈现英文变体，无则原文）。 */
    const topMemories = [...tenantOS.core.memories.getAllMemories().values()]
      .sort((a, b) => b.salience - a.salience || a.id.localeCompare(b.id))
      .slice(0, SELF_INTRO_MEMORY_LIMIT)
      .map((node) => (contentFor?.(node) ?? node.content).trim())
      .filter((c) => c.length > 0);

    /* 有名字时即便其余皆空也能自我介绍（「我叫X」本身就是有效自述）。 */
    const name = myName?.trim();
    if (narrative.length === 0 && topValues.length === 0 && topMemories.length === 0 && !name) return undefined;

    const parts: string[] = [];
    if (name) parts.push(t.selfIntroName(name));
    if (narrative.length > 0) parts.push(narrative);
    if (topValues.length > 0) parts.push(t.selfIntroValues(topValues.join(locale === 'zh-CN' ? '、' : ', ')));
    if (topMemories.length > 0) {
      parts.push(t.selfIntroMemories);
      for (const c of topMemories) parts.push(`· ${c}`);
    }
    /* 关系层（ADR-0056）：自我介绍带「我们的关系」（你是X / 我们聊过N次）。 */
    if (relationshipLine && relationshipLine.length > 0) parts.push(relationshipLine);
    parts.push(t.selfIntroFooter);
    return parts.join('\n');
  }

  /* POST /api/v1/companion/me/chat —「跟数字人聊天」（零 LLM 确定性回应） */
  app.post('/api/v1/companion/me/chat', async (request, reply) => {
    assertCompanionAccess(request);
    setPrivateNoStore(reply);
    const body = CompanionChatRequestV1Schema.parse(request.body);
    const tenantOS = getOS(request);

    /* 配额（与 perception 同口径——对话也算一次 companion 交互，防滥用）。未设限额默认无限。 */
    if (!quotaManager.consumeQuota(request.tenantId, 'companion_chat')) {
      throw new QuotaExceededError('对话配额已用尽，请稍后再试');
    }

    /* ADR-0055 多语种：按用户这句话确定性检测语言（zh-CN/en），固定回复/身份识别用对应语言。
     * 零-LLM——「what's your name」自动英文回，「你叫什么」自动中文回。 */
    const locale = detectLanguage(body.message);
    const t = companionLocale(locale).reply;

    /* 命中 never_discuss 的输入：不影响人格状态（不记关系/不更新心情/不沉淀）——禁忌输入隔离。
     * 在所有早返回**之前**算，统一守卫。 */
    const inputBlocked = responder.violatesNeverDiscuss(body.message, COMPANION_BASELINE_BOUNDARIES);

    /* ADR-0056 类人化·关系层 + 时间感知：**每轮非禁忌输入**都记一次互动（++次数、更新 last_seen，
     * 首次设 first_met）。置于所有早返回之前——「你叫什么」等也算真实互动（Codex 复审）。
     * 时间感知：在 record **之前**读旧 last_seen/first_met → 算久别档 → 生成确定性问候前缀
     * （好久不见/又见面了），sameSession 不打招呼。零-LLM、基于 now 时刻可复现。 */
    let greetingPrefix = '';
    /* 回应变化性的轮次索引（ADR-0056）：用 record **后**的互动次数作确定性 seed——同状态同变体、
     * 随关系推进自然轮换。关系关/禁忌输入 → 0 → 取原文（零回归）。 */
    let variantSeed = 0;
    if (relationshipEnabled && !inputBlocked) {
      const relStore = new CompanionRelationshipStore(sharedDb, request.tenantId, COMPANION_PERSONA_ID);
      const now = tenantOS.getClock().now();
      if (temporalEnabled) {
        const rel = relStore.get();   // 旧状态（record 前）
        const gap = timeGap(rel.lastSeenAt, now);
        const days = daysSinceFirstMet(rel.firstMetAt, now);
        greetingPrefix = t.greetingPrefix(gap, rel.userName, days);
      }
      relStore.recordInteraction(now);
      variantSeed = relStore.get().interactionCount;   // record 后的次数
    }

    /* 在回应**开头**拼久别问候前缀（好久不见/又见面了）。sameSession/first/关闭 → 前缀空 → 原文不变（零回归）。
     * 用于自然对话回应 + 身份问名/关系确认这类「久别后第一句」也算重逢（Codex 复审：避免久别后问名字却冷脸）。
     * **不**用于：边界拒答（拒绝不寒暄）、起名拒绝/清洗失败（纠错非重逢）——这些是修正不是问候，保持冷静。 */
    const withGreeting = (reply: string): string =>
      greetingPrefix.length > 0 ? `${greetingPrefix}\n\n${reply}` : reply;

    /* ADR-0055「自我意识」：先处理身份意图（起名 / 问名字），第一人称落地，优先于普通检索。
     * 视角转换：用户对「你」的称呼 = 数字人自己，内化为第一人称身份「我叫X」，绝不当第二人称记忆复述。 */
    const identity = new CompanionIdentityStore(sharedDb, request.tenantId, COMPANION_PERSONA_ID);
    const identityIntent = detectIdentityIntent(body.message, locale);
    /* 安全（Codex 复审 High）：输入命中 never_discuss **但敏感主题不在名字本身**（如「我的密码是X，
     * 你叫小黑」——名字「小黑」干净但句子泄密）→ **跳过身份处理**，落到 responder 走 boundary_block，
     * 不让起名绕过边界拒答。若敏感主题就是名字本身（「你叫密码」）→ 不跳过，由下方 name 自检给温和拒绝。 */
    const blockedButNameClean = inputBlocked && identityIntent.kind === 'define'
      && !!identityIntent.name && !responder.violatesNeverDiscuss(identityIntent.name, COMPANION_BASELINE_BOUNDARIES);
    if (!blockedButNameClean && identityIntent.kind === 'define' && identityIntent.name) {
      /* 名字过 never_discuss 自检（防把敏感主题设成名字后被第一人称复述出去）。命中 → 拒绝设置。
       * kind=honest_offline（与原行为一致，中文零回归）。 */
      if (responder.violatesNeverDiscuss(identityIntent.name, COMPANION_BASELINE_BOUNDARIES)) {
        return { data: CompanionChatResultV1Schema.parse({
          schemaVersion: 'companion-chat-result.v1',
          reply: t.nameRejectedSensitive, kind: 'honest_offline', confidence: 0.4, groundedMemoryCount: 0,
        } satisfies CompanionChatResultV1) };
      }
      /* store 清洗后为空（如名字全是被剥的尖括号/控制字符）会抛错——温和拒绝而非 500（防御纵深）。 */
      let saved: string;
      try {
        saved = identity.setName(identityIntent.name, Date.now());
      } catch {
        return { data: CompanionChatResultV1Schema.parse({
          schemaVersion: 'companion-chat-result.v1',
          reply: t.nameRejectedUnclear, kind: 'self_identity', confidence: 0.4, groundedMemoryCount: 0,
        } satisfies CompanionChatResultV1) };
      }
      /* 第一人称确认——「好的，我记住了，我叫X」。这句不沉淀为对话记忆（身份已结构化存储，避免回声）。 */
      return { data: CompanionChatResultV1Schema.parse({
        schemaVersion: 'companion-chat-result.v1',
        reply: t.nameConfirmed(saved), kind: 'self_identity', confidence: 0.9, groundedMemoryCount: 0,
      } satisfies CompanionChatResultV1) };
    }
    if (identityIntent.kind === 'ask' && !inputBlocked) {
      const myName = identity.getName();
      if (myName) {
        return { data: CompanionChatResultV1Schema.parse({
          schemaVersion: 'companion-chat-result.v1',
          reply: withGreeting(t.myNameIs(myName)), kind: 'self_identity', confidence: 0.9, groundedMemoryCount: 0,
        } satisfies CompanionChatResultV1) };
      }
      /* 还没起名 → 第一人称邀请用户起名（而非 honest_offline 的「无法学习」冷回应）。 */
      return { data: CompanionChatResultV1Schema.parse({
        schemaVersion: 'companion-chat-result.v1',
        reply: withGreeting(t.noNameYet), kind: 'self_identity', confidence: 0.6, groundedMemoryCount: 0,
      } satisfies CompanionChatResultV1) };
    }

    /* ADR-0056 关系层：识别用户自报名字（「我叫X / call me X」）→ 存 + 第一人称问候带名字。
     * 在身份意图之后（「我叫你Max」是给数字人起名，已被 identity 处理，不会到这）。 */
    if (relationshipEnabled && !inputBlocked) {
      const userName = detectUserName(body.message, locale);
      if (userName && !responder.violatesNeverDiscuss(userName, COMPANION_BASELINE_BOUNDARIES)) {
        try {
          const saved = new CompanionRelationshipStore(sharedDb, request.tenantId, COMPANION_PERSONA_ID).setUserName(userName, tenantOS.getClock().now());
          return { data: CompanionChatResultV1Schema.parse({
            schemaVersion: 'companion-chat-result.v1',
            reply: withGreeting(t.userNameNoted(saved)), kind: 'relationship', confidence: 0.9, groundedMemoryCount: 0,
          } satisfies CompanionChatResultV1) };
        } catch { /* 清洗后空名 → 忽略，继续正常对话 */ }
      }
    }

    /* ADR-0055 内容多语：非默认语言（zh-CN）时，加载本租户该语言的记忆翻译变体，
     * 让检索匹配变体（英文 query 命中已翻译的中文记忆）并以变体呈现。zh-CN 不取变体 = 零回归。
     * 变体由成长期 /translate 预翻，运行时只读（零-LLM）。 */
    let contentFor: ContentFor | undefined;
    if (locale !== 'zh-CN') {
      const variants = new MemoryTranslationStore(sharedDb, request.tenantId).listByLanguage(locale);
      if (variants.size > 0) contentFor = (node) => variants.get(node.id) ?? node.content;
    }

    const narrative = tenantOS.core.narrative.get();
    const relevantKnowledge = retrieveRelevantMemories(tenantOS, body.message, contentFor);

    /* ADR-0056 类人化·情绪：读当前心情 → 据本轮情感信号（用户输入情感词 + 检索记忆均值 valence）
     * 确定性漂移 + 时间回归 → 存回。本轮回应用**更新后**的心情语气（聊到开心事这轮就更开心）。
     * 默认开；关 → 心情恒中性（无前缀，零回归）。可复现：相同输入+相同心情+相同时刻→相同输出。
     * 安全（Codex 复审 High）：命中 never_discuss 的输入**不更新心情**（inputBlocked 上方已算）——
     * 禁忌输入不应影响人格状态。 */
    let moodLabelNow: MoodLabel = 'neutral';
    if (moodEnabled && !inputBlocked) {
      const moodStore = new CompanionMoodStore(sharedDb, request.tenantId, COMPANION_PERSONA_ID);
      const { mood, updatedAt } = moodStore.get();
      const now = tenantOS.getClock().now();
      const elapsedMs = updatedAt !== null ? Math.max(0, now - updatedAt) : 0;
      /* 情感信号：用户输入情感词（主）+ 检索到的相关记忆均值 valence（次，权重小）。 */
      const inputSignal = extractEmotionSignal(body.message, locale);
      const memSignal = relevantKnowledge.length > 0
        ? relevantKnowledge.reduce((s, k) => s + (memoryValenceOf(tenantOS, k.id) ?? 0), 0) / relevantKnowledge.length
        : 0;
      const valenceSignal = clampUnit(inputSignal * 0.75 + memSignal * 0.25);
      const next = updateMood(mood, { valenceSignal }, elapsedMs);
      moodStore.set(next, now);
      moodLabelNow = moodLabel(next);
    }

    /* 确定性离线回应（零 LLM）。喂基线安全边界——never_discuss 输入/输出自检对凭证类敏感主题真生效
     * （不因 companion 默认人格无 enterprise 配置就让安全自检 no-op）。 */
    /* ADR-0054 Phase 5：近期成长片段（drift→成长，确定性）——让知识回应的主动 follow-up 真带
     * 「我最近也在变化：<成长>」。getLatest 读已存报告(cheap)，无基线/无方向 → undefined(仅泛泛邀请)。 */
    const recentGrowth = buildRecentGrowthPhrase(sharedDb, request.tenantId);
    /* ADR-0056 block 6 内在驱动·对话回想：取一条与当前话题相关的**过往对话记忆**（你之前说过的），
     * 让回应主动「我突然想到你之前提到过 X」。开关关/禁忌输入 → 不回想。安全：回想片段须过
     * never_discuss 输出自检——命中则丢弃该回想（不让敏感过往对话被主动翻出，也避免整段被自检拒答
     * 而丢掉本可正常回答的内容）。最终拼装结果仍会再过一次输出自检兜底。 */
    let conversationCallback: string | undefined;
    if (proactiveEnabled && !inputBlocked) {
      const candidate = buildConversationCallback(tenantOS, body.message, locale);
      if (candidate !== undefined && !responder.violatesNeverDiscuss(candidate, COMPANION_BASELINE_BOUNDARIES)) {
        conversationCallback = candidate;
      }
    }
    const offline = responder.respond({
      narrative,
      boundaries: COMPANION_BASELINE_BOUNDARIES,
      userInput: body.message,
      relevantKnowledge,
      locale,
      moodLabel: moodLabelNow,
      /* ADR-0056 立场：关 → 恒 confident（无前缀，零回归）。 */
      stanceEnabled: opinionEnabled,
      /* ADR-0056 变化性：轮次 seed = 互动次数；关 → 取原文（零回归）。 */
      variantSeed,
      variabilityEnabled,
      /* 仅作用于 knowledge_grounded 回应（block/escalate/honest_offline 不追）。 */
      proactiveReply: { ...(recentGrowth !== undefined ? { recentGrowth } : {}), ...(conversationCallback !== undefined ? { conversationCallback } : {}) },
    });

    /* response_template 优先（ADR-0047 蒸馏闭环消费端）：命中 intent 匹配的整段模板 → 直接用它，流程型
     * 问答更流畅有序。**但安全边界优先级最高**：
     *   ① 用户输入命中 never_discuss（offline.kind===boundary_block）→ 不用模板覆盖拒答；
     *   ② 模板**正文**经 never_discuss 输出自检（Codex 复审 High：蒸馏审批不能替代运行时最后一道边界；
     *      模板是直接发给用户的整段，须和 memory/narrative 拼装结果一样过输出自检——挡「输入没命中但
     *      模板正文自带敏感主题」的绕过）→ 命中则丢弃模板，回退记忆 grounding（由其拒答/诚实离线）。
     * 决策结果先存入 payload 变量（不提前 return），以便统一在末尾沉淀对话记忆——避免沉淀写入影响
     * **本轮**的 self_intro/检索（曾出现：沉淀的记忆让空人格 self_intro 误判为非空）。 */
    let payload: CompanionChatResultV1 | undefined;
    if (offline.kind !== 'boundary_block') {
      /* response_template 最优先（蒸馏好的高质流程模板，如「flat white 做法」步骤）——避免「总结一下
       * flat white 做法」被 summary 抢答成零散记忆（Codex 复审）。 */
      const template = matchResponseTemplate(request.tenantId, body.message);
      const summaryIntent = template ? { matched: false } : detectSummaryIntent(body.message, locale);
      if (template && !responder.violatesNeverDiscuss(template, COMPANION_BASELINE_BOUNDARIES)) {
        payload = {
          schemaVersion: 'companion-chat-result.v1',
          reply: template, kind: 'response_template', confidence: 0.8, groundedMemoryCount: 0,
        };
      } else if (summaryIntent.matched) {
        /* ADR-0055 归纳总结意图（「总结你学过的X / 你最近学了什么」）：确定性沿主题归纳相关记忆。
         * 在模板之后、自我介绍之前。总述过 never_discuss 输出自检（防泄露敏感记忆）。 */
        const summary = buildSummary({
          memories: tenantOS.core.memories.getAllMemories(),
          edgesFor: (id) => tenantOS.core.memories.getEdgesFor(id),
          topic: summaryIntent.topic,
          locale,
          contentFor,
        });
        if (summary && !responder.violatesNeverDiscuss(summary, COMPANION_BASELINE_BOUNDARIES)) {
          payload = {
            schemaVersion: 'companion-chat-result.v1',
            reply: summary, kind: 'summary', confidence: 0.6, groundedMemoryCount: 0,
          };
        }
      } else if (detectSelfIntroIntent(body.message, locale)) {
        /* 自我介绍元意图（「介绍你自己/你会什么」）：泛词查不到具体记忆，走综述（叙事+价值观+高 salience
         * 记忆），而非 honest_offline。综述同样过 never_discuss 输出自检（防记忆里混入敏感主题被综述出去）。 */
        /* 自我介绍带关系（ADR-0056）：你是X / 我们聊过N次。关闭时 relLine 为空，行为不变。 */
        const relLine = relationshipEnabled
          ? (() => { const r = new CompanionRelationshipStore(sharedDb, request.tenantId, COMPANION_PERSONA_ID).get(); return t.relationshipLine(r.userName, r.interactionCount); })()
          : '';
        const intro = buildSelfIntro(tenantOS, locale, identity.getName(), contentFor, relLine);
        if (intro && !responder.violatesNeverDiscuss(intro, COMPANION_BASELINE_BOUNDARIES)) {
          payload = {
            schemaVersion: 'companion-chat-result.v1',
            reply: intro, kind: 'self_intro', confidence: 0.6, groundedMemoryCount: 0,
          };
        }
      }
    }

    payload ??= {
      schemaVersion: 'companion-chat-result.v1',
      reply: offline.content,
      kind: offline.kind,
      confidence: offline.confidence,
      /* 仅 knowledge_grounded 才报引用数：边界拒答（boundary_block）时报 0——否则
       * groundedMemoryCount>0 会从侧信道泄露「确有相关敏感记忆存在」（Codex 复审），
       * 也与「引用了几条记忆」语义不符（拒答没引用）。 */
      groundedMemoryCount: offline.kind === 'knowledge_grounded' ? relevantKnowledge.length : 0,
    };

    /* ADR-0056 时间感知：久别重逢/隔天再见 → 在回应**开头**加确定性问候前缀（好久不见/又见面了）。
     * 只加在自然对话回应（knowledge_grounded / honest_offline / self_intro）上——不加在边界拒答
     * （boundary_block 是拒绝，加问候很怪）、结构化模板/总结（response_template/summary 自带结构）上。
     * 身份问名/关系确认的早返回路径已在上方各自 withGreeting。sameSession/first/关闭 → 前缀空 → 零回归。 */
    if (payload.kind === 'knowledge_grounded' || payload.kind === 'honest_offline' || payload.kind === 'self_intro') {
      payload = { ...payload, reply: withGreeting(payload.reply) };
    }

    /* ADR-0055「对话即经历」：本轮回应已完全确定后，把这轮对话确定性沉淀为低显著 episodic 记忆，
     * 让数字人「记得跟你聊过」。零-LLM（沉淀=确定性 append 非语义理解；语义内化仍走 reflect）。
     * **置于末尾**：沉淀写入绝不影响本轮回应（检索/self_intro 已在前面跑完）。安全门：
     *   ① 开关关 → 不沉淀；② 输入命中 never_discuss（boundary_block）→ 不沉淀（不持久化敏感内容）；
     *   ③ 不够格（空/过短/纯寒暄/纯疑问）→ 不沉淀；④ 沉淀正文再过 never_discuss 输出自检 → 命中不写；
     *   ⑤ 元意图请求（summary/self_intro/self_identity/response_template）是查询/指令非用户陈述 → 不沉淀。 */
    const isMetaIntent = payload.kind === 'summary' || payload.kind === 'self_intro'
      || payload.kind === 'self_identity' || payload.kind === 'response_template';
    if (conversationMemoryEnabled && offline.kind !== 'boundary_block' && !isMetaIntent) {
      const decision = decideConversationCapture(body.message, locale);
      if (decision.capture && !responder.violatesNeverDiscuss(decision.content, COMPANION_BASELINE_BOUNDARIES)) {
        /* 去重：已存在完全相同正文的记忆则不重复写——防「反复说同一句」无限追加噪声（Codex 复审）。 */
        const already = [...tenantOS.core.memories.getAllMemories().values()].some((m) => m.content === decision.content);
        if (!already) {
          tenantOS.core.memories.addMemory(
            'episodic', decision.content, CONVERSATION_MEMORY_VALENCE, CONVERSATION_MEMORY_SALIENCE,
          );
        }
      }
    }

    return { data: CompanionChatResultV1Schema.parse(payload) };
  });
}

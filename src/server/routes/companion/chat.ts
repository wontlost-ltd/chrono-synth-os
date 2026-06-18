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
import type { RelevantKnowledge } from '../../../conversation/conversation-types.js';
import { COMPANION_BASELINE_BOUNDARIES } from '../../../conversation/companion-boundaries.js';
import { buildRecentGrowthPhrase } from './recent-growth.js';
import { ResponseTemplateStore } from '../../../storage/response-template-store.js';
import {
  decideConversationCapture,
  CONVERSATION_MEMORY_SALIENCE,
  CONVERSATION_MEMORY_VALENCE,
} from '../../../conversation/conversation-memory-capture.js';
import type { AppConfig } from '../../../config/schema.js';

/** companion 默认人格 id（与 perceive/environment 一致）。 */
const COMPANION_PERSONA_ID = 'default';
/** 命中 response_template 的最小 intent 关键词分门槛——高于记忆 grounding 门槛，避免泛匹配抢答整段模板。 */
const MIN_TEMPLATE_INTENT_SCORE = 2;
/** 自我介绍综述取多少条高 salience 记忆。 */
const SELF_INTRO_MEMORY_LIMIT = 4;
/** 自我介绍综述取多少个高权重价值观。 */
const SELF_INTRO_VALUE_LIMIT = 3;
/**
 * 自我介绍元意图关键词（确定性子串匹配）：问「介绍你自己/你是谁/你会什么/你都会些什么/讲讲你自己」
 * 这类，泛词查不到具体记忆 → 走专门综述，而非 honest_offline。
 */
const SELF_INTRO_PHRASES: readonly string[] = [
  '介绍一下你自己', '介绍下你自己', '自我介绍', '介绍你自己', '介绍一下自己',
  '你是谁', '你会什么', '你都会什么', '你都会些什么', '你会些什么', '你能做什么', '你擅长什么',
  '讲讲你自己', '说说你自己', '聊聊你自己', '你是什么样',
];
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
  function retrieveRelevantMemories(tenantOS: ChronoSynthOS, message: string): RelevantKnowledge[] {
    return retrieveMemoriesDeterministic(
      message,
      tenantOS.core.memories.getAllMemories(),
      (id) => tenantOS.core.memories.getEdgesFor(id),
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

  /** 确定性检测自我介绍元意图（子串匹配，零模型）。 */
  function detectSelfIntroIntent(message: string): boolean {
    const m = message.toLowerCase();
    return SELF_INTRO_PHRASES.some((p) => m.includes(p));
  }

  /**
   * 综述自我介绍（确定性，零模型）：叙事 + 最看重的价值观 + 最有印象的记忆（按 salience）。
   * 解决「介绍一下你自己」泛词查不到具体记忆 → honest_offline 的问题。无任何内容时返回 undefined
   * （回退诚实离线）。
   */
  function buildSelfIntro(tenantOS: ChronoSynthOS): string | undefined {
    const narrative = tenantOS.core.narrative.get().trim();
    /* 排序加稳定 tie-breaker（id 字典序）——底层 SELECT 无 ORDER BY，同 weight/salience 时 Map 迭代
     * 顺序跨 DB/重载会漂移，不应作为契约。加 id 二级键确保「相同人格状态相同输入→相同输出」（Codex 复审）。 */
    const topValues = [...tenantOS.core.values.getAll().values()]
      .sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id))
      .slice(0, SELF_INTRO_VALUE_LIMIT)
      .map((v) => v.label.trim())
      .filter((l) => l.length > 0);
    const topMemories = [...tenantOS.core.memories.getAllMemories().values()]
      .sort((a, b) => b.salience - a.salience || a.id.localeCompare(b.id))
      .slice(0, SELF_INTRO_MEMORY_LIMIT)
      .map((node) => node.content.trim())
      .filter((c) => c.length > 0);

    if (narrative.length === 0 && topValues.length === 0 && topMemories.length === 0) return undefined;

    const parts: string[] = [];
    if (narrative.length > 0) parts.push(narrative);
    if (topValues.length > 0) parts.push(`我最看重的是${topValues.join('、')}。`);
    if (topMemories.length > 0) {
      parts.push('我印象比较深的是：');
      for (const c of topMemories) parts.push(`· ${c}`);
    }
    parts.push('（这些都来自我学过、记住的，离线也能告诉你。）');
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

    const narrative = tenantOS.core.narrative.get();
    const relevantKnowledge = retrieveRelevantMemories(tenantOS, body.message);

    /* 确定性离线回应（零 LLM）。喂基线安全边界——never_discuss 输入/输出自检对凭证类敏感主题真生效
     * （不因 companion 默认人格无 enterprise 配置就让安全自检 no-op）。 */
    /* ADR-0054 Phase 5：近期成长片段（drift→成长，确定性）——让知识回应的主动 follow-up 真带
     * 「我最近也在变化：<成长>」。getLatest 读已存报告(cheap)，无基线/无方向 → undefined(仅泛泛邀请)。 */
    const recentGrowth = buildRecentGrowthPhrase(sharedDb, request.tenantId);
    const offline = responder.respond({
      narrative,
      boundaries: COMPANION_BASELINE_BOUNDARIES,
      userInput: body.message,
      relevantKnowledge,
      /* 仅作用于 knowledge_grounded 回应（block/escalate/honest_offline 不追）。 */
      proactiveReply: recentGrowth !== undefined ? { recentGrowth } : {},
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
      const template = matchResponseTemplate(request.tenantId, body.message);
      if (template && !responder.violatesNeverDiscuss(template, COMPANION_BASELINE_BOUNDARIES)) {
        payload = {
          schemaVersion: 'companion-chat-result.v1',
          reply: template, kind: 'response_template', confidence: 0.8, groundedMemoryCount: 0,
        };
      } else if (detectSelfIntroIntent(body.message)) {
        /* 自我介绍元意图（「介绍你自己/你会什么」）：泛词查不到具体记忆，走综述（叙事+价值观+高 salience
         * 记忆），而非 honest_offline。综述同样过 never_discuss 输出自检（防记忆里混入敏感主题被综述出去）。 */
        const intro = buildSelfIntro(tenantOS);
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

    /* ADR-0055「对话即经历」：本轮回应已完全确定后，把这轮对话确定性沉淀为低显著 episodic 记忆，
     * 让数字人「记得跟你聊过」。零-LLM（沉淀=确定性 append 非语义理解；语义内化仍走 reflect）。
     * **置于末尾**：沉淀写入绝不影响本轮回应（检索/self_intro 已在前面跑完）。安全门：
     *   ① 开关关 → 不沉淀；② 输入命中 never_discuss（boundary_block）→ 不沉淀（不持久化敏感内容）；
     *   ③ 不够格（空/过短/纯寒暄/纯疑问）→ 不沉淀；④ 沉淀正文再过 never_discuss 输出自检 → 命中不写。 */
    if (conversationMemoryEnabled && offline.kind !== 'boundary_block') {
      const decision = decideConversationCapture(body.message);
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

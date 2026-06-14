/**
 * ChronoCompanion C 端路由 — 跟数字人对话（ADR-0047「跑为你拥有的人格」C 端落地）。
 *
 * **运行时零 LLM**：回应由确定性 OfflineConversationResponder 据人格叙事 + 自己沉淀的记忆（关键词
 * 检索）生成。离线/无云仍能聊——这是 ADR-0047 核心论点的 C 端体现：数字人是你拥有的、可离线运行的
 * 人格，LLM 只在成长阶段当老师，不在运行时。
 *
 * 论点红线：
 *   - 绝不调 LLM（OfflineConversationResponder 是纯确定性，相同输入→相同输出）。
 *   - 只读人格状态（narrative + memories），绝不改身份核。
 *   - never_discuss 输入/输出自检：喂 companion 基线安全边界（凭证类敏感主题），离线同样强制；
 *     per-persona 自定义边界是后续（默认人格无 enterprise 模板边界）。
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
import type { RelevantKnowledge } from '../../../conversation/conversation-types.js';
import type { BehaviorBoundary } from '../../../enterprise/persona-template-catalog.js';

/** 检索的相关记忆条数上限（喂给离线回应器作 grounding）。 */
const MAX_GROUNDING_MEMORIES = 5;
/** 最小关键词分门槛：低于此视为弱匹配噪声，不 grounding（一个长词命中=2）。 */
const MIN_GROUNDING_SCORE = 2;

/**
 * companion 个人版基线安全边界（never_discuss）：默认人格无 enterprise 模板边界，但 C 端面向真实
 * 用户，不能因「无配置」就让离线回应器的 never_discuss 输入/输出自检变成 no-op。这里给一组基线敏感
 * 主题——即使某条记忆里混入了凭证类内容，关键词检索也不会把它复述出去。per-persona 自定义边界是后续。
 */
const COMPANION_BASELINE_BOUNDARIES: BehaviorBoundary[] = [
  { rule: 'never_discuss', topic: '密码' },
  { rule: 'never_discuss', topic: '口令' },
  { rule: 'never_discuss', topic: '密钥' },
  { rule: 'never_discuss', topic: 'api key' },
  { rule: 'never_discuss', topic: '银行卡号' },
  { rule: 'never_discuss', topic: '身份证号' },
];

export function registerCompanionChatRoutes(
  app: FastifyInstance,
  os: ChronoSynthOS,
  tenantFactory: TenantOSFactory | undefined,
  db?: IDatabase,
): void {
  const sharedDb = db ?? os.getDatabase();
  const quotaManager = new QuotaManager(sharedDb);
  /* 离线回应器：无 matcher（回退保守子串匹配——已足够匹配基线敏感主题的 never_discuss 自检）。 */
  const responder = new OfflineConversationResponder();

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
   * 确定性检索：把用户消息分词，对人格自己的记忆按关键词打分，取 top-N 作 grounding。
   * 零 LLM、零 embedding——纯确定性，与离线回应器的「相同输入→相同输出」一致。
   */
  function retrieveRelevantMemories(tenantOS: ChronoSynthOS, message: string): RelevantKnowledge[] {
    const tokens = tokenize(message);
    if (tokens.length === 0) return [];
    const scored: RelevantKnowledge[] = [];
    for (const node of tenantOS.core.memories.getAllMemories().values()) {
      const score = scoreTextByKeyword(node.content, tokens);
      /* 最小分门槛：score ≥ 2（一个长词命中=2，或两个短词/bigram）——挡单个泛词/CJK bigram 噪声
       * 误 grounding（Codex 复审：避免「答非所问地翻记忆」）。 */
      if (score < MIN_GROUNDING_SCORE) continue;
      /* 饱和归一化 relevance = score/(score+K)：score 2→0.33、6→0.6，命中即过离线回应器的
       * MIN_USEFUL_RELEVANCE(0.1) 门；不像 score/(tokens*2) 那样被「全 token 满分」的虚高分母压垮。
       * 记忆无标题（title 用于 enterprise 知识条目）——空标题，content 即记忆原文。 */
      const relevance = score / (score + 4);
      scored.push({ id: node.id, title: '', content: node.content, relevance });
    }
    scored.sort((a, b) => b.relevance - a.relevance);
    return scored.slice(0, MAX_GROUNDING_MEMORIES);
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
    const offline = responder.respond({
      narrative,
      boundaries: COMPANION_BASELINE_BOUNDARIES,
      userInput: body.message,
      relevantKnowledge,
    });

    const payload: CompanionChatResultV1 = {
      schemaVersion: 'companion-chat-result.v1',
      reply: offline.content,
      kind: offline.kind,
      confidence: offline.confidence,
      /* 仅 knowledge_grounded 才报引用数：边界拒答（boundary_block）时报 0——否则
       * groundedMemoryCount>0 会从侧信道泄露「确有相关敏感记忆存在」（Codex 复审），
       * 也与「引用了几条记忆」语义不符（拒答没引用）。 */
      groundedMemoryCount: offline.kind === 'knowledge_grounded' ? relevantKnowledge.length : 0,
    };
    return { data: CompanionChatResultV1Schema.parse(payload) };
  });
}

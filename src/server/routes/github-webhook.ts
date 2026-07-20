/**
 * GitHub webhook 接收器（GitHub 集成 Plan 3 Task 6——**可选入站入口**）。
 *
 * 这是「GitHub 主动把新 issue/PR 推给数字人、让 TA 起草回复」的**系统入站**入口（区别于 Task 5 的
 * 用户主动动作 `companion/me/draft-github-reply`）。因是系统入站而非用户会话，故挂在
 * `integrations/github` 前缀下、公网无 JWT/API-Key 鉴权——由 **HMAC-SHA256 签名**保护（照 Stripe
 * webhook 纪律：preParsing 拿原始字节，对原始字节验签）。
 *
 * 处理链（严格顺序，任一前置门 fail-closed 即拒、不进后续）：
 *   ① **preParsing 拿 raw body**：签名必须对**原始字节**校验，不能对 parsed body 再序列化（字节可能
 *      不一致）。照 billing.ts 的 preParsing 钩子拼 rawBody Buffer 挂 request。
 *   ② **反查租户 fail-closed**：解析 payload 的 `installation.id` → resolveTenantByInstallation（**不带
 *      tenant_id 过滤**，靠 UNIQUE(host, installation) 全局唯一约束返确定 0/1 行）。缺 installation.id
 *      → 400；反查不到（0 行）→ **401**（不猜租户、不进流程）。
 *   ③ **验签 fail-closed**：取该租户 webhook secret（getApp().webhookSecret）→ 自建
 *      verifyGithubSignature：`expected='sha256='+HMAC-SHA256(rawBody, secret)`，**先比长度**再
 *      timingSafeEqual（长度不等直接拒，避免 timingSafeEqual 抛）。失败 → **401 不进流程**。
 *   ④ **幂等**：X-GitHub-Delivery 作 deliveryId → claimWebhookEvent（原子 INSERT ON CONFLICT DO
 *      NOTHING）。false（重投）→ **200 直接返**，不重复起草。
 *   ⑤ **仅 issue/PR opened 触发起草**：X-GitHub-Event=issues+action=opened / pull_request+action=opened
 *      → 用 **payload 自带的** issue/PR 标题+正文（opened 事件即携带内容，无需回调 GitHub 拉取）→ 确定性
 *      检索已学记忆 → composeGithubReply 零-LLM 起草 → GithubDraftStore.createDraft 存 **drafted**。
 *      其它事件类型/action → 200 忽略。
 *
 * 论点红线（本 plan 安全命题，webhook 侧同样成立）：
 *   - **绝不发布（结构性保证）**：本接收器只消费 GithubDraftStore（本地草稿账本）+ composeGithubReply
 *     （纯确定性文本拼装）+ retrieveMemoriesDeterministic（纯图遍历）。**没有** WritePort、**没有**任何
 *     对外写通道——即便被公网触发，也在类型/结构上发不出 GitHub 写请求。发布是 Plan 4。
 *   - **起草即停**：createDraft 执行器钉死 status='drafted'（起草即停铁律）。webhook 绝不推进/审批/发布。
 *   - **零-LLM 运行时**：起草是 composeGithubReply（复用 OfflineConversationResponder 确定性拼装），检索
 *     记忆是纯图遍历。webhook 全程不调 LLM——相同 payload + 相同人格状态 → 相同草稿（可复现）。
 *
 * 起草段与 Task 5 端点是**同一条确定性链**（检索记忆 → composeGithubReply → createDraft drafted），但
 * 数据来源不同（Task 5 经 ReadPort list+find 取单个 issue/PR；webhook 直接用 opened 事件 payload 自带的
 * 标题+正文），且入口语义不同（用户动作 vs 系统入站）。故此处**内联同款链**而非强抽公共函数——ReadPort
 * 装配/访问门等 Task 5 特有的部分在 webhook 侧并不适用，抽取反而要塞进大量条件分支。
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ChronoSynthOS } from '../../chrono-synth-os.js';
import type { TenantOSFactory } from '../../multi-tenant/tenant-os-factory.js';
import type { IDatabase } from '../../storage/database.js';
import type { AppConfig } from '../../config/schema.js';
import { AuthenticationError, ValidationError, ErrorCode } from '../../errors/index.js';
import { tryByokEncryption } from '../../storage/llm-credential-store.js';
import { GithubAppCredentialStore } from '../../storage/github-app-credential-store.js';
import { GithubDraftStore } from '../../storage/github-draft-store.js';
import { composeGithubReply } from '../../integrations/github/github-response-composer.js';
import { retrieveMemoriesDeterministic } from '../../conversation/deterministic-memory-retrieval.js';

/** companion 单 persona core-self 的 personaId（与 draft-github-reply 一致——草稿按 (tenant, persona) 隔离）。 */
const COMPANION_PERSONA_ID = 'default';
/** 公有云 GitHub host（首版只处理 github.com；GHE 自托管 host 反查是后续扩展）。 */
const GITHUB_HOST = 'github.com';

/** webhook 接收器可注入依赖（保留位；起草段零-LLM，本就无 LLM/provider 通道可注入）。 */
export interface GithubWebhookInjected {
  /* 预留（目前无注入点——反查/验签/起草全走真实 store + 确定性起草）。 */
  readonly _reserved?: never;
}

/**
 * webhook payload 的**最小**关心形状（GitHub issues / pull_request 事件的公共子集）。
 * 只取起草与路由必需字段——installation.id（反查）、action（是否 opened）、issue/pull_request 的
 * number/title/body（起草上下文）。其余字段忽略（不做全量 schema 校验——签名已保证来源可信）。
 */
interface GithubWebhookPayload {
  action?: string;
  installation?: { id?: number | string };
  repository?: { full_name?: string };
  issue?: { number?: number; title?: string; body?: string | null };
  pull_request?: { number?: number; title?: string; body?: string | null };
}

/**
 * 校验 X-Hub-Signature-256（GitHub 官方格式 `sha256=<hex>`）。**先比长度**再 timingSafeEqual——
 * 长度不等直接返 false（Buffer.from 出的两个 Buffer 长度不等时 timingSafeEqual 会抛，须先挡）。
 * expected 与 sigHeader 都是等长十六进制串（`sha256=`+64 hex），常量时间比较防时序侧信道。
 */
function verifyGithubSignature(rawBody: Buffer, sigHeader: string | undefined, secret: string): boolean {
  if (typeof sigHeader !== 'string' || sigHeader.length === 0) return false;
  const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
  const expectedBuf = Buffer.from(expected);
  const sigBuf = Buffer.from(sigHeader);
  /* 长度不等直接拒（否则 timingSafeEqual 抛 RangeError）；长度相同才常量时间比较。 */
  if (expectedBuf.length !== sigBuf.length) return false;
  return timingSafeEqual(expectedBuf, sigBuf);
}

export function registerGithubWebhookRoutes(
  app: FastifyInstance,
  os: ChronoSynthOS,
  tenantFactory: TenantOSFactory | undefined,
  /* 与其它路由注册签名对齐（app.ts 统一传 db+config）；反查/凭据/草稿读写均走 tenantOS.getDatabase()
   * （per-tenant 隔离），故 db 未直接使用（下划线前缀）。 */
  _db?: IDatabase,
  config?: AppConfig,
  _injected?: GithubWebhookInjected,
): void {
  /* GithubAppCredentialStore 强制启用的 FieldEncryption（私钥/webhook secret 拒绝明文落库）；
   * 加密未启用时无凭据 store 可用——反查/验签路径会 fail-closed 拒。 */
  const credEncryption = config ? tryByokEncryption(config.encryption) : undefined;

  /** 取指定租户的 OS（非-default 走 tenantFactory；无 factory / default → 基座 os）。 */
  function tenantOSFor(tenantId: string): ChronoSynthOS {
    if (tenantFactory && tenantId && tenantId !== 'default') return tenantFactory.getTenantOS(tenantId);
    return os;
  }

  /* POST /api/v1/integrations/github/webhook —— GitHub issue/PR opened → 起草停 drafted（不发布）。 */
  app.post('/api/v1/integrations/github/webhook', {
    /* preParsing：拼 rawBody Buffer 挂 request（照 billing.ts）——签名对**原始字节**校验。 */
    preParsing: async (request, _reply, payload) => {
      const { Readable } = await import('node:stream');
      const chunks: Buffer[] = [];
      for await (const chunk of payload) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      }
      const rawBody = Buffer.concat(chunks);
      (request as { rawBody?: Buffer }).rawBody = rawBody;
      return Readable.from(rawBody);
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const rawBody = (request as { rawBody?: Buffer }).rawBody;
    if (!rawBody || rawBody.length === 0) {
      throw new ValidationError('webhook 请求体为空', ErrorCode.VALIDATION_REQUIRED);
    }

    /* 加密未启用 → 无从取 webhook secret 验签 → fail-closed 拒。 */
    if (!credEncryption) {
      throw new AuthenticationError('GitHub webhook 未就绪（本机未启用凭据加密，无法校验签名）', ErrorCode.AUTH_INVALID_TOKEN);
    }

    /* 解析 payload（签名尚未校验——此处只为取 installation.id 反查租户；真正信任在验签后）。 */
    let payload: GithubWebhookPayload;
    try {
      payload = JSON.parse(rawBody.toString('utf8')) as GithubWebhookPayload;
    } catch {
      throw new ValidationError('webhook 请求体不是合法 JSON', ErrorCode.VALIDATION_FORMAT);
    }

    /* ② 反查租户 fail-closed：缺 installation.id → 400；反查不到 → 401（不猜租户）。 */
    const installationIdRaw = payload.installation?.id;
    if (installationIdRaw === undefined || installationIdRaw === null || String(installationIdRaw).length === 0) {
      throw new ValidationError('webhook payload 缺少 installation.id，无法反查租户', ErrorCode.VALIDATION_REQUIRED);
    }
    const installationId = String(installationIdRaw);
    /* 反查用基座 DB（installations 表在单库部署里承载所有租户的映射；resolveTenantByInstallation
     * 不带 tenant_id 过滤，靠 UNIQUE(host, installation) 返确定 0/1 行）。 */
    const resolver = new GithubAppCredentialStore(os.getDatabase(), credEncryption, 'default');
    const resolved = resolver.resolveTenantByInstallation(GITHUB_HOST, installationId);
    if (!resolved) {
      throw new AuthenticationError('无法把该 installation 反查到已知租户——拒绝处理该 webhook', ErrorCode.AUTH_INVALID_TOKEN);
    }
    const tenantId = resolved.tenantId;
    const tenantOS = tenantOSFor(tenantId);

    /* ③ 验签 fail-closed：取该租户 webhook secret → 对 rawBody 校验 X-Hub-Signature-256。失败 → 401。 */
    const credStore = new GithubAppCredentialStore(tenantOS.getDatabase(), credEncryption, tenantId);
    const appCred = credStore.getApp();
    if (!appCred) {
      throw new AuthenticationError('该租户尚无 GitHub App 凭据，无法校验 webhook 签名——拒绝处理', ErrorCode.AUTH_INVALID_TOKEN);
    }
    const sigHeader = request.headers['x-hub-signature-256'];
    const sig = typeof sigHeader === 'string' ? sigHeader : undefined;
    if (!verifyGithubSignature(rawBody, sig, appCred.webhookSecret)) {
      throw new AuthenticationError('X-Hub-Signature-256 校验失败——拒绝处理该 webhook', ErrorCode.AUTH_INVALID_TOKEN);
    }

    /* ④ 幂等：X-GitHub-Delivery 作 deliveryId → 原子 claim。重投（false）→ 200 直接返、不重复起草。 */
    const deliveryHeader = request.headers['x-github-delivery'];
    const deliveryId = typeof deliveryHeader === 'string' ? deliveryHeader : undefined;
    if (!deliveryId || deliveryId.length === 0) {
      throw new ValidationError('webhook 缺少 X-GitHub-Delivery（幂等键）', ErrorCode.VALIDATION_REQUIRED);
    }
    const eventHeader = request.headers['x-github-event'];
    const eventType = typeof eventHeader === 'string' ? eventHeader : 'unknown';

    const store = new GithubDraftStore(tenantOS.getDatabase(), tenantId);
    const isNew = store.claimWebhookEvent(deliveryId, eventType, tenantOS.getClock().now());
    if (!isNew) {
      /* 重投：已处理过——200 直接返，不重复起草（幂等）。 */
      return reply.status(200).send({ data: { received: true, deduplicated: true } });
    }

    /* ⑤ 仅 issue/PR opened 触发起草；其它事件/action → 200 忽略。 */
    const target = extractOpenedTarget(payload, eventType);
    if (!target) {
      return reply.status(200).send({ data: { received: true, drafted: false } });
    }

    /* 确定性检索已学记忆（零-LLM 图遍历）+ composeGithubReply 零-LLM 起草 → 存 drafted。绝不发布。 */
    const query = `${target.title}\n${target.body}`.trim();
    const relevantKnowledge = retrieveMemoriesDeterministic(
      query,
      tenantOS.core.memories.getAllMemories(),
      (id) => tenantOS.core.memories.getEdgesFor(id),
    );
    const draft = composeGithubReply({
      narrative: tenantOS.core.narrative.get(),
      targetTitle: target.title,
      targetBody: target.body,
      targetType: target.targetType,
      relevantKnowledge,
    });
    /* repo：payload 的 repository.full_name（owner/name）；缺省用空串（起草只需标题+正文，repo 仅作元数据）。 */
    const repo = payload.repository?.full_name ?? '';
    /* createDraft 执行器钉死 status='drafted'（起草即停铁律）。绝不发布——发布是 Plan 4。 */
    const draftId = store.createDraft(
      COMPANION_PERSONA_ID,
      repo,
      target.targetType,
      target.number,
      draft.body,
      tenantOS.getClock().now(),
    );

    return reply.status(200).send({ data: { received: true, drafted: true, draftId, kind: draft.kind } });
  });
}

/**
 * 从 payload 抽出「opened 的 issue/PR」目标（issue/PR 号 + 标题 + 正文 + 类型）；非 opened / 非 issue&PR
 * 事件返 undefined（调用方 → 200 忽略）。opened 事件 payload 即携带完整标题/正文，故无需回调 GitHub 拉取。
 */
function extractOpenedTarget(
  payload: GithubWebhookPayload,
  eventType: string,
): { targetType: 'issue' | 'pull'; number: number; title: string; body: string } | undefined {
  if (payload.action !== 'opened') return undefined;
  if (eventType === 'issues' && payload.issue) {
    const issue = payload.issue;
    if (typeof issue.number !== 'number') return undefined;
    return { targetType: 'issue', number: issue.number, title: issue.title ?? '', body: issue.body ?? '' };
  }
  if (eventType === 'pull_request' && payload.pull_request) {
    const pr = payload.pull_request;
    if (typeof pr.number !== 'number') return undefined;
    return { targetType: 'pull', number: pr.number, title: pr.title ?? '', body: pr.body ?? '' };
  }
  return undefined;
}

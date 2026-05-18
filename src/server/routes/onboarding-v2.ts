/**
 * 引导流程 v2 路由 — agent governance onboarding
 *
 * 路由前缀 /api/v1/onboarding/v2/* —— 与老路由 /api/v1/onboarding/* 并存，
 * 后者服务于已弃用的 persona-simulator 流程，等老用户清空后再下线。
 *
 * PRD: .claude/gtm/03-onboarding-prd.md
 */

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { IDatabase } from '../../storage/database.js';
import type { AppConfig } from '../../config/schema.js';
import type { OrganizationService } from '../../enterprise/organization-service.js';
import { OnboardingV2Service } from '../../onboarding/onboarding-v2-service.js';
import { ToolPermissionService } from '../../agent/tool-permission-service.js';
import { ValidationError, ErrorCode } from '../../errors/index.js';

const StartSchema = z.object({}).passthrough();

const OrganizationSchema = z.object({
  sessionId: z.string().min(1),
  organizationName: z.string().min(1).max(120),
});

const AgentSchema = z.object({
  sessionId: z.string().min(1),
  agentName: z.string().min(1).max(120),
  llmProvider: z.enum(['openai', 'anthropic']).nullable().optional(),
  llmApiKey: z.string().max(512).nullable().optional(),
});

const PolicySchema = z.object({
  sessionId: z.string().min(1),
  agentId: z.string().min(1),
  policies: z.array(z.object({
    toolId: z.string().min(1),
    /* scope 与 ToolScope kernel 类型对齐：read/write/execute */
    scope: z.enum(['read', 'write', 'execute']),
    decision: z.enum(['allow', 'deny', 'confirm']),
  })).min(1).max(20),
});

const SyntheticSchema = z.object({
  sessionId: z.string().min(1),
  agentId: z.string().min(1),
});

const CompleteSchema = z.object({
  sessionId: z.string().min(1),
});

const SkipSchema = z.object({
  sessionId: z.string().min(1),
  currentStep: z.number().int().min(1).max(5),
});

export function registerOnboardingV2Routes(
  app: FastifyInstance,
  config: AppConfig,
  db: IDatabase,
  organization: OrganizationService,
): void {
  const service = new OnboardingV2Service(db);
  const permissions = new ToolPermissionService(db);

  /** 取调用方 userId。JWT 模式下从 request.user.sub 取；否则用 tenant fallback。 */
  function requireUserId(request: { user?: { sub?: string }; tenantId: string }): string {
    const sub = request.user?.sub;
    if (sub && sub.length > 0) return sub;
    if (!config.jwt.enabled) return `dev-${request.tenantId}`;
    throw new ValidationError('JWT 缺失 sub 声明', ErrorCode.AUTH_INVALID_TOKEN);
  }

  /* POST /api/v1/onboarding/v2/start */
  app.post('/api/v1/onboarding/v2/start', async (request, reply) => {
    StartSchema.parse(request.body ?? {});
    const userId = requireUserId(request);
    const session = service.start(request.tenantId, userId);
    return reply.status(session.resumed ? 200 : 201).send({ data: session });
  });

  /* POST /api/v1/onboarding/v2/organization */
  app.post('/api/v1/onboarding/v2/organization', async (request, reply) => {
    const body = OrganizationSchema.parse(request.body);
    const userId = requireUserId(request);

    /* 幂等：如果 session 已绑定 org，直接复用，不再创建新 org */
    const current = service.getActiveByUser(request.tenantId, userId);
    if (current?.organizationId) {
      const session = service.recordOrganizationStep(body.sessionId, request.tenantId, current.organizationId);
      return reply.send({ data: { session, organizationId: current.organizationId } });
    }

    const created = organization.create(request.tenantId, userId, {
      name: body.organizationName,
      defaultWorkspaceName: 'Default workspace',
    });
    const session = service.recordOrganizationStep(
      body.sessionId, request.tenantId, created.organization.organizationId,
    );
    return reply.send({
      data: { session, organizationId: created.organization.organizationId },
    });
  });

  /* POST /api/v1/onboarding/v2/agent
   * Step 2: 创建 agent（= persona）。LLM key 的加密存储留待后续 PR
   * 接入 KMS envelope path —— 当前 W2.1 阶段把 key 丢弃，下个 sprint 接好
   * 再串起来，避免阻塞引导流程的可演示性。
   */
  app.post('/api/v1/onboarding/v2/agent', async (request, reply) => {
    const body = AgentSchema.parse(request.body);
    const userId = requireUserId(request);

    /* 检查 session 状态：当前 step 必须 ≥ 2 */
    const current = service.getActiveByUser(request.tenantId, userId);
    if (!current) {
      throw new ValidationError('会话不存在或已过期，请重新开始', ErrorCode.NOT_FOUND_ONBOARDING);
    }
    /* 幂等：已存在 agent_id 时直接复用 */
    if (current.agentId) {
      const session = service.recordAgentStep(body.sessionId, request.tenantId, current.agentId);
      return reply.send({ data: { session, agentId: current.agentId } });
    }

    const agentId = `agent_${randomUUID()}`;
    const now = Date.now();
    /* persona_versions 是 agent 主体表：写入最小可用的 v1 版本。
     * agent 名字进 description；详细字段在 dashboard 完善。 */
    db.prepare(
      `INSERT INTO persona_versions
         (id, tenant_id, persona_id, version, parent_version, name, description,
          decision_style_json, cognitive_model_json, knowledge_base_json,
          author, created_at, snapshot_uri, is_current)
       VALUES (?, ?, ?, 1, NULL, ?, ?, '{}', '{}', '{}', ?, ?, NULL, 1)`,
    ).run(
      `pv_${randomUUID()}`,
      request.tenantId,
      agentId,
      body.agentName,
      `Agent registered during onboarding by ${userId}`,
      userId,
      now,
    );

    /* TODO(W2.1 Step 2 follow-up): 接 tenant-KMS envelope 流程
     * 加密存储 llmApiKey 到 user_oauth_tokens 或 agent_credentials 表。
     * 当前 PR 范围内仅承认 provider 选择，不持久化 key —— 用户
     * 在 Settings → Secrets 中重新填一次即可。 */
    void body.llmProvider;
    void body.llmApiKey;

    const session = service.recordAgentStep(body.sessionId, request.tenantId, agentId);
    return reply.send({ data: { session, agentId } });
  });

  /* POST /api/v1/onboarding/v2/policy */
  app.post('/api/v1/onboarding/v2/policy', async (request, reply) => {
    const body = PolicySchema.parse(request.body);
    const userId = requireUserId(request);
    let granted = 0;
    for (const policy of body.policies) {
      /* deny 不需要写行：tool_permissions 缺失 = 默认拒绝 */
      if (policy.decision === 'deny') continue;
      permissions.grant({
        tenantId: request.tenantId,
        personaId: body.agentId,
        toolId: policy.toolId,
        scope: policy.scope,
        constraints: policy.decision === 'confirm'
          ? { requireConfirmation: true }
          : {},
        grantedBy: userId,
      });
      granted++;
    }
    const session = service.recordPolicyStep(body.sessionId, request.tenantId);
    return reply.send({ data: { session, policyCount: granted } });
  });

  /* POST /api/v1/onboarding/v2/synthetic-invocation
   * Step 4: 服务端写 3 行假 invocation，让用户立刻看到审计日志样子。
   */
  app.post('/api/v1/onboarding/v2/synthetic-invocation', async (request, reply) => {
    const body = SyntheticSchema.parse(request.body);
    const userId = requireUserId(request);

    const drafts = service.buildSyntheticInvocations(body.agentId, userId);
    const invocationIds: string[] = [];
    for (const draft of drafts) {
      const id = permissions.recordInvocation({
        tenantId: request.tenantId,
        personaId: body.agentId,
        toolId: draft.toolId,
        invokerType: 'internal',
        invokerId: userId,
        invokerUserId: userId,
        status: draft.status,
        inputHash: draft.inputHash,
        outputSizeBytes: draft.outputSizeBytes,
        errorMessage: draft.errorMessage,
        costCents: 0,
        durationMs: draft.durationMs,
        confirmationTokenId: null,
      });
      invocationIds.push(id);
    }
    const session = service.recordSyntheticStep(
      body.sessionId, request.tenantId, invocationIds,
    );
    return reply.send({ data: { session, invocationIds } });
  });

  /* POST /api/v1/onboarding/v2/complete */
  app.post('/api/v1/onboarding/v2/complete', async (request, reply) => {
    const body = CompleteSchema.parse(request.body);
    const userId = requireUserId(request);
    const session = service.complete(body.sessionId, request.tenantId, userId);
    return reply.send({ data: { session, completedAt: session.completedAt } });
  });

  /* POST /api/v1/onboarding/v2/skip
   * 用户跳过引导：写 users.onboarded_at 让 app shell 不再展示，
   * 但保留 session 未 complete 标记以便分析跳过 vs 完成的转化漏斗。
   */
  app.post('/api/v1/onboarding/v2/skip', async (request, reply) => {
    const body = SkipSchema.parse(request.body);
    const userId = requireUserId(request);
    const session = service.skip(body.sessionId, request.tenantId, userId);
    return reply.send({ data: { session, skippedAtStep: body.currentStep } });
  });

  /* GET /api/v1/onboarding/v2/status
   * 前端在 mount 时调用，决定跳到哪一步（或跳过引导直接进 dashboard）。
   */
  app.get('/api/v1/onboarding/v2/status', async (request) => {
    const userId = requireUserId(request);
    if (service.hasOnboarded(userId)) {
      return { data: { onboarded: true, session: null } };
    }
    const session = service.getActiveByUser(request.tenantId, userId);
    return { data: { onboarded: false, session } };
  });
}

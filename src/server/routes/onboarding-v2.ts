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
import type { IDatabase } from '../../storage/database.js';
import type { TenantDbResolver } from '../../storage/tenant-db-resolver.js';
import type { AppConfig } from '../../config/schema.js';
import type { OrganizationService } from '../../enterprise/organization-service.js';
import { OnboardingV2Service } from '../../onboarding/onboarding-v2-service.js';
import { ToolPermissionService } from '../../agent/tool-permission-service.js';
import { ValidationError, ErrorCode } from '../../errors/index.js';
import { LlmCredentialStore, tryByokEncryption } from '../../storage/llm-credential-store.js';
import {
  OnboardingV2StartSchema,
  OnboardingV2OrganizationSchema,
  OnboardingV2AgentSchema,
  OnboardingV2PolicySchema,
  OnboardingV2SyntheticSchema,
  OnboardingV2CompleteSchema,
  OnboardingV2SkipSchema,
} from '../schemas/api-schemas.js';

export function registerOnboardingV2Routes(
  app: FastifyInstance,
  config: AppConfig,
  db: IDatabase,
  organization: OrganizationService,
  /* 分片 Phase 0 · Plan 2 · Task 6：注入共享 TenantDbResolver——agent 步的 persona_versions 直查
   * （tenant-scoped）经 resolver.dbForTenant(tenantId) 路由到租户所在 shard。session 状态机
   * （OnboardingV2Service）+ 工具权限 + LLM 凭据 store 仍走 host db（各自独立子域，非本 task 范围）。 */
  /* 保留参数：删掉那条坏 INSERT 后本路由不再直查 shard，但签名是装配契约的一部分
   * （app.ts 传 `captureResolver('onboarding-v2')`，该名字参与 db-access 门的归类）。
   * 故保留形参并显式标注未使用，而不是改签名。 */
  _resolver: TenantDbResolver,
): void {
  const service = new OnboardingV2Service(db);
  const permissions = new ToolPermissionService(db);
  /* BYOK：加密落 llmApiKey（明文绝不持久化）。加密不可用（未启用/key 非法）则不落库，
   * 用户改在 Settings 重填——绝不明文落库，绝不因 key 解析阻塞 onboarding。 */
  const encryption = tryByokEncryption(config.encryption);

  /** 取调用方 userId。JWT 模式下从 request.user.sub 取；否则用 tenant fallback。 */
  function requireUserId(request: { user?: { sub?: string }; tenantId: string }): string {
    const sub = request.user?.sub;
    if (sub && sub.length > 0) return sub;
    if (!config.jwt.enabled) return `dev-${request.tenantId}`;
    throw new ValidationError('JWT 缺失 sub 声明', ErrorCode.AUTH_INVALID_TOKEN);
  }

  /* POST /api/v1/onboarding/v2/start */
  app.post('/api/v1/onboarding/v2/start', async (request, reply) => {
    OnboardingV2StartSchema.parse(request.body ?? {});
    const userId = requireUserId(request);
    const session = service.start(request.tenantId, userId);
    return reply.status(session.resumed ? 200 : 201).send({ data: session });
  });

  /* POST /api/v1/onboarding/v2/organization */
  app.post('/api/v1/onboarding/v2/organization', async (request, reply) => {
    const body = OnboardingV2OrganizationSchema.parse(request.body);
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
    const body = OnboardingV2AgentSchema.parse(request.body);
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

    /* ⚠️ 审计 P2：这里原本有一条写 `persona_versions` 的 INSERT，**列名与真实表
     * 完全对不上** —— 它写 14 列（persona_id/version/name/decision_style_json…），
     * 而该表只有 9 列（id/label/values_json/status/results_json/resource_quota/
     * created_at/updated_at + tenant_id），且 5 个 NOT NULL 无默认值的列一个没给。
     * 实测：`table persona_versions has no column named persona_id` —— 
     * **本端点每次调用必 500**，onboarding 第 2 步完全不可用，且零测试覆盖。
     *
     * 直接删除而非修列：`agentId` 只被写进 onboarding 会话自身
     * （`recordAgentStep`）并用作 `buildSyntheticInvocations` 的哈希种子，
     * **没有任何代码从 persona_versions 读回它**。那是一行写了没人看的数据，
     * 修好列名也只是让一条无用写入不再报错。 */

    /* BYOK：加密落库 llmApiKey（明文绝不持久化）。同租户同 provider 覆盖更新。
     * ModelRouter 构造时优先取本租户 key，缺失回退全局 config。
     * ⚠️ 当前限制（Codex BYOK 复审）：运行时 provider 仍取全局 config.intelligence.provider；
     *   故仅当用户所选 provider == 全局 active provider 时这把 key 才会被用上。用户选了别的
     *   provider 时 key 落库但暂不生效（需后续 per-tenant provider preference）。这里只在
     *   provider 匹配全局时落库，避免存「永不生效的死 key」。
     * 加密不可用（encryption=undefined）则跳过——绝不明文落库。 */
    if (encryption && body.llmProvider === config.intelligence.provider && body.llmApiKey) {
      new LlmCredentialStore(db, encryption, request.tenantId)
        .store(body.llmProvider, body.llmApiKey, userId, now);
    }

    const session = service.recordAgentStep(body.sessionId, request.tenantId, agentId);
    return reply.send({ data: { session, agentId } });
  });

  /* POST /api/v1/onboarding/v2/policy */
  app.post('/api/v1/onboarding/v2/policy', async (request, reply) => {
    const body = OnboardingV2PolicySchema.parse(request.body);
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
    const body = OnboardingV2SyntheticSchema.parse(request.body);
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
    const body = OnboardingV2CompleteSchema.parse(request.body);
    const userId = requireUserId(request);
    const session = service.complete(body.sessionId, request.tenantId, userId);
    return reply.send({ data: { session, completedAt: session.completedAt } });
  });

  /* POST /api/v1/onboarding/v2/skip
   * 用户跳过引导：写 users.onboarded_at 让 app shell 不再展示，
   * 但保留 session 未 complete 标记以便分析跳过 vs 完成的转化漏斗。
   */
  app.post('/api/v1/onboarding/v2/skip', async (request, reply) => {
    const body = OnboardingV2SkipSchema.parse(request.body);
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

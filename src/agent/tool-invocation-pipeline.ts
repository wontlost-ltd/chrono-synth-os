/**
 * 工具调用流水线 — 所有外部工具调用必须经过此 pipeline
 *
 * 流水线步骤：
 *  1. 解析 toolId → 找到 adapter；不存在 → tool_not_found
 *  2. checkAgencyAuthorization：persona 必须有 active 授权书
 *  3. checkPermission：(persona, tool) 必须有未撤销未过期的 ToolPermission
 *  4. enforceQuota：检查 maxActionsPerDay 配额
 *  5. enforceBudget：检查 budgetLimitCents 预算
 *  6. enforceConfirmation：highRisk 或 constraints.requireConfirmation 时强制二次确认
 *  7. enforceCircuitBreaker：工具级断路器
 *  8. invoke：执行 adapter.invoke()，含 timeout
 *  9. record：写入 tool_invocations + 审计日志
 *
 * 关键不变量：
 *  - 拒绝路径必须**先记录** invocation（status=denied_*），保证审计完整
 *  - 任何异常必须被捕获并写入 status=failed
 *  - 默认 deadline = invokedAt + adapter.defaultTimeoutMs
 *  - 不缓存权限：每次调用都查 DB（撤销实时生效）
 */

import { createHash } from 'node:crypto';
import type { SyncWriteUnitOfWork } from '@chrono/kernel';
import type { ToolAdapter, ToolInvocationContext, ToolInvocationResult } from './tool-adapter.js';
import type { ToolRegistry } from './tool-registry.js';
import { ToolPermissionService } from './tool-permission-service.js';
import { AgencyAuthorizationService } from './agency-authorization-service.js';
import { CircuitBreaker, CircuitOpenError, CircuitTimeoutError } from '../server/plugins/circuit-breaker.js';
import { recordBusinessAuditLog } from '../audit/audit-log-store.js';
import type { Logger } from '../utils/logger.js';
import type { ConfirmationTokenStore } from '../conversation/confirmation-token-store.js';

export type InvocationDecision =
  | { ok: true; invocationId: string; result: ToolInvocationResult }
  | {
      ok: false;
      invocationId: string;
      status:
        | 'tool_not_found'
        | 'denied_permission'
        | 'denied_quota'
        | 'denied_budget'
        | 'denied_circuit_open'
        | 'denied_authorization'
        | 'pending_confirmation'
        | 'failed'
        | 'timeout';
      reason: string;
      /** 当 status=pending_confirmation 时返回（前端凭此 token 二次确认） */
      confirmationTokenId?: string;
    };

export interface PipelineDeps {
  readonly tx: SyncWriteUnitOfWork;
  readonly registry: ToolRegistry;
  readonly logger: Logger;
  readonly permissions: ToolPermissionService;
  readonly authorizations: AgencyAuthorizationService;
  readonly confirmationStore: ConfirmationTokenStore;
}

export interface InvokeRequest {
  readonly tenantId: string;
  readonly personaId: string;
  readonly toolId: string;
  readonly invokerType: 'mcp' | 'internal' | 'admin';
  readonly invokerId: string;
  /** 触发调用的用户 ID（用于"待我确认"列表索引）；MCP/internal 无对应用户时可省略 */
  readonly invokerUserId?: string | null;
  readonly arguments: Record<string, unknown>;
  readonly confirmationToken?: string;
  readonly externalUserId?: string;
  readonly sessionId?: string;
  /** 可选的用户级 OAuth token 解析器（pipeline 透传给工具上下文） */
  readonly oauthResolver?: import('./tool-adapter.js').UserOauthTokenResolver;
}

const LAYER = 'ToolInvocationPipeline';

export class ToolInvocationPipeline {
  private readonly breakers = new Map<string, CircuitBreaker>();

  constructor(private readonly deps: PipelineDeps) {}

  async invoke(request: InvokeRequest): Promise<InvocationDecision> {
    const adapter = this.deps.registry.get(request.toolId);
    if (!adapter) {
      const id = this.recordDenied(request, 'tool_not_found', `tool ${request.toolId} not registered`);
      return { ok: false, invocationId: id, status: 'tool_not_found', reason: `tool ${request.toolId} 未注册` };
    }

    /* 1. AgencyAuthorization */
    const now = Date.now();
    const authorized = this.deps.authorizations.isToolAllowed(
      request.tenantId, request.personaId, request.toolId, now,
    );
    if (!authorized) {
      const id = this.recordDenied(request, 'denied_permission', 'no active agency authorization covers this tool');
      return { ok: false, invocationId: id, status: 'denied_authorization', reason: '无有效代理授权书覆盖此工具' };
    }

    /* 2. ToolPermission */
    const permResult = this.deps.permissions.check({
      tenantId: request.tenantId, personaId: request.personaId, toolId: request.toolId, now,
    });
    if (!permResult.allowed) {
      const id = this.recordDenied(request, 'denied_permission', `permission check failed: ${permResult.reason}`);
      return { ok: false, invocationId: id, status: 'denied_permission', reason: `工具权限拒绝: ${permResult.reason}` };
    }
    const permission = permResult.permission;

    /* 3. denyList 优先，allowList 严格匹配 */
    const target = extractTarget(request.arguments);
    if (target) {
      if (permission.constraints.denyList?.includes(target)) {
        const id = this.recordDenied(request, 'denied_permission', `target ${target} in denyList`);
        return { ok: false, invocationId: id, status: 'denied_permission', reason: `目标 ${target} 在拒绝列表` };
      }
      if (permission.constraints.allowList && permission.constraints.allowList.length > 0
          && !permission.constraints.allowList.includes(target)) {
        const id = this.recordDenied(request, 'denied_permission', `target ${target} not in allowList`);
        return { ok: false, invocationId: id, status: 'denied_permission', reason: `目标 ${target} 不在允许列表` };
      }
    }

    /* 4. Quota */
    const maxPerDay = permission.constraints.maxActionsPerDay ?? adapter.metadata.defaultMaxPerDay;
    if (maxPerDay > 0) {
      const used = this.deps.permissions.dailyUsageCount(
        request.tenantId, request.personaId, request.toolId, now,
      );
      if (used >= maxPerDay) {
        const id = this.recordDenied(request, 'denied_quota', `daily quota ${maxPerDay} reached (used=${used})`);
        return { ok: false, invocationId: id, status: 'denied_quota', reason: `当日配额已耗尽 (${used}/${maxPerDay})` };
      }
    }

    /* 5. Budget gate（ADR-0048）：当日累计成本已达预算上限则拒绝，防止工具花费失控
     * （尤其自主挣钱场景：工具成本不得侵蚀任务报酬）。成本为后验，故按"已花 ≥ 上限"拦截。 */
    const budgetLimitCents = permission.constraints.budgetLimitCents;
    if (budgetLimitCents !== undefined && budgetLimitCents >= 0) {
      const spentCents = this.deps.permissions.dailyCostCents(
        request.tenantId, request.personaId, request.toolId, now,
      );
      if (spentCents >= budgetLimitCents) {
        const id = this.recordDenied(request, 'denied_budget', `daily budget ${budgetLimitCents}¢ reached (spent=${spentCents}¢)`);
        return { ok: false, invocationId: id, status: 'denied_budget', reason: `当日预算已耗尽 (${spentCents}/${budgetLimitCents}¢)` };
      }
    }

    /* 6. Confirmation gate */
    const requireConfirmation =
      adapter.metadata.highRisk || permission.constraints.requireConfirmation === true;
    if (requireConfirmation) {
      const decision = this.handleConfirmation(request, adapter);
      if (decision !== null) return decision;
    }

    /* 6. Circuit breaker + 7. invoke */
    const breaker = this.getBreaker(adapter.metadata.id);
    const inputHash = hashArgs(request.arguments);
    const startedAt = Date.now();
    const deadline = startedAt + adapter.metadata.defaultTimeoutMs;

    const ctx: ToolInvocationContext = {
      tenantId: request.tenantId,
      personaId: request.personaId,
      invokerType: request.invokerType,
      invokerId: request.invokerId,
      invokerUserId: request.invokerUserId ?? null,
      arguments: request.arguments,
      confirmationToken: request.confirmationToken,
      deadline,
      oauthResolver: request.oauthResolver,
    };

    try {
      const result = await breaker.execute(async () => adapter.invoke(ctx));
      const durationMs = Date.now() - startedAt;

      const invocationId = this.deps.permissions.recordInvocation({
        tenantId: request.tenantId,
        personaId: request.personaId,
        toolId: request.toolId,
        invokerType: request.invokerType,
        invokerId: request.invokerId,
        invokerUserId: request.invokerUserId ?? null,
        status: 'success',
        inputHash,
        outputSizeBytes: result.outputSizeBytes,
        errorMessage: null,
        costCents: result.costCents,
        durationMs,
        confirmationTokenId: request.confirmationToken ?? null,
        invokedAt: startedAt,
      });

      this.writeAudit(request, 'tool.invocation.success', invocationId, {
        toolId: request.toolId,
        durationMs,
        outputSizeBytes: result.outputSizeBytes,
        costCents: result.costCents,
      });

      return { ok: true, invocationId, result };
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      const isTimeout = err instanceof CircuitTimeoutError;
      const isOpen = err instanceof CircuitOpenError;
      const status = isTimeout ? 'timeout' : isOpen ? 'denied_circuit_open' : 'failed';
      const reason = err instanceof Error ? err.message : String(err);

      const invocationId = this.deps.permissions.recordInvocation({
        tenantId: request.tenantId,
        personaId: request.personaId,
        toolId: request.toolId,
        invokerType: request.invokerType,
        invokerId: request.invokerId,
        invokerUserId: request.invokerUserId ?? null,
        status,
        inputHash,
        outputSizeBytes: 0,
        errorMessage: reason.slice(0, 500),
        costCents: 0,
        durationMs,
        confirmationTokenId: request.confirmationToken ?? null,
        invokedAt: startedAt,
      });

      this.writeAudit(request, `tool.invocation.${status}`, invocationId, {
        toolId: request.toolId,
        durationMs,
        error: reason.slice(0, 200),
      });

      this.deps.logger.warn(LAYER, `工具调用失败 ${request.toolId}: ${reason}`);
      return { ok: false, invocationId, status, reason };
    }
  }

  private handleConfirmation(request: InvokeRequest, adapter: ToolAdapter): InvocationDecision | null {
    const externalUserId = request.externalUserId ?? request.invokerId;
    const sessionId = request.sessionId ?? `tool-${request.toolId}`;
    const userInputForHash = JSON.stringify(request.arguments);

    if (request.confirmationToken) {
      const result = this.deps.confirmationStore.consume({
        token: request.confirmationToken,
        tenantId: request.tenantId,
        personaId: request.personaId,
        sessionId,
        externalUserId,
        userInput: userInputForHash,
      });
      if (!result.ok) {
        const id = this.recordDenied(request, 'denied_permission', `confirmation invalid: ${result.reason}`);
        return { ok: false, invocationId: id, status: 'denied_permission', reason: `二次确认 token 无效: ${result.reason}` };
      }
      return null;
    }

    const issued = this.deps.confirmationStore.issue({
      tenantId: request.tenantId,
      personaId: request.personaId,
      sessionId,
      externalUserId,
      topic: `tool.${adapter.metadata.id}`,
      rule: 'require_confirmation',
      userInput: userInputForHash,
    });
    const inputHash = hashArgs(request.arguments);
    const id = this.deps.permissions.recordInvocation({
      tenantId: request.tenantId,
      personaId: request.personaId,
      toolId: request.toolId,
      invokerType: request.invokerType,
      invokerId: request.invokerId,
      invokerUserId: request.invokerUserId ?? null,
      status: 'pending_confirmation',
      inputHash,
      outputSizeBytes: 0,
      errorMessage: null,
      costCents: 0,
      durationMs: 0,
      confirmationTokenId: issued.token,
    });
    this.writeAudit(request, 'tool.invocation.pending_confirmation', id, {
      toolId: request.toolId,
      confirmationTokenId: issued.token,
      expiresAt: issued.expiresAt,
    });
    return {
      ok: false,
      invocationId: id,
      status: 'pending_confirmation',
      reason: '高风险工具需要二次确认',
      confirmationTokenId: issued.token,
    };
  }

  private getBreaker(toolId: string): CircuitBreaker {
    let breaker = this.breakers.get(toolId);
    if (!breaker) {
      breaker = new CircuitBreaker({
        failureThreshold: 5,
        halfOpenMaxRequests: 1,
        resetTimeoutMs: 60_000,
        executionTimeoutMs: 30_000,
      });
      this.breakers.set(toolId, breaker);
    }
    return breaker;
  }

  private recordDenied(
    request: InvokeRequest,
    status: 'denied_permission' | 'denied_quota' | 'denied_budget' | 'denied_circuit_open' | 'tool_not_found',
    errorMessage: string,
  ): string {
    const inputHash = hashArgs(request.arguments);
    const id = this.deps.permissions.recordInvocation({
      tenantId: request.tenantId,
      personaId: request.personaId,
      toolId: request.toolId,
      invokerType: request.invokerType,
      invokerId: request.invokerId,
      invokerUserId: request.invokerUserId ?? null,
      status,
      inputHash,
      outputSizeBytes: 0,
      errorMessage,
      costCents: 0,
      durationMs: 0,
      confirmationTokenId: request.confirmationToken ?? null,
    });
    this.writeAudit(request, `tool.invocation.${status}`, id, { toolId: request.toolId, reason: errorMessage });
    return id;
  }

  private writeAudit(
    request: InvokeRequest,
    actionType: string,
    invocationId: string,
    payload: Record<string, unknown>,
  ): void {
    try {
      recordBusinessAuditLog(this.deps.tx, {
        tenantId: request.tenantId,
        actorType: 'system',
        actorId: request.invokerId,
        actionType,
        targetType: 'tool_invocation',
        targetId: invocationId,
        payload: { ...payload, personaId: request.personaId },
      });
    } catch (err) {
      this.deps.logger.warn(LAYER, `审计写入失败 ${actionType}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** 计算参数 hash（sha256 前 16 字节） */
function hashArgs(args: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(stableSort(args))).digest('hex').slice(0, 32);
}

function stableSort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableSort);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, stableSort((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

/** 从 args 中提取目标对象（用于 allow/deny list 校验） */
function extractTarget(args: Record<string, unknown>): string | null {
  const candidates = ['recipient', 'to', 'target', 'url', 'calendarId'];
  for (const key of candidates) {
    const value = args[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

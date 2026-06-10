/**
 * 引导流程 v2 — agent-governance 5 步向导
 *
 * 流程：organization → agent → policy → synthetic-invocation → audit-log
 *
 * 与 OnboardingService（v1，persona-simulator 流程）并存：v1 进入弃用期
 * 但仍服务老用户；v2 是新签用户进入的默认路径。PRD: .claude/gtm/03-onboarding-prd.md
 *
 * 设计要点：
 *  - 幂等：同一 user_id 调用 start() 多次返回同一 session
 *  - 持久化：所有 5 步均落库 onboarding_sessions（不仅是内存状态）
 *  - 合成调用：step 4 写 3 行 tool_invocations（synthetic flag），让用户在 step 5
 *    立刻看到审计日志样子。flag 写入 onboarding_synthetic_invocations 副表，
 *    便于将来 admin 视图过滤。
 *  - 不调 LLM：整个流程在 5 分钟预算内必须确定性完成（LLM 在 dashboard 真实
 *    流程里触发，不在引导关键路径）
 */

import { randomUUID, createHash } from 'node:crypto';
import { trace } from '@opentelemetry/api';
import type { IDatabase } from '../storage/database.js';
import { ValidationError, NotFoundError, ErrorCode } from '../errors/index.js';
import {
  onboardingStarted, onboardingStepCompleted, onboardingCompleted,
  onboardingSkipped, onboardingStepDurationMs,
} from '../observability/metrics.js';
import { recordEvidence } from '../compliance/evidence-store.js';

/** OTel tracer for the onboarding flow; spans wrap each step transition. */
const tracer = trace.getTracer('chrono-synth-os.onboarding');

/**
 * Emit step-completion telemetry. Encapsulated so callers only need the
 * (tenantId, sessionId, step, prevUpdatedAt) tuple; the rest is plumbing.
 * - Metrics: counter + duration histogram (vs prev updated_at).
 * - OTel: short span attributing the transition.
 * - SOC2 evidence: row on CC1.5 (control environment / onboarding) so
 *   auditors can attest "every new tenant went through the agent-governance
 *   wizard". recordEvidence runs in the same tx as the schema update.
 */
function emitStepTelemetry(
  tx: IDatabase,
  tenantId: string,
  sessionId: string,
  step: number,
  prevUpdatedAt: number,
  extra: Record<string, string | number | null> = {},
): void {
  const now = Date.now();
  onboardingStepCompleted.add(1, { step: String(step), cohort: 'v2' });
  onboardingStepDurationMs.record(now - prevUpdatedAt, { step: String(step) });
  const span = tracer.startSpan('onboarding.v2.step', {
    attributes: {
      'onboarding.step': step,
      'onboarding.cohort': 'v2',
      'onboarding.session_id': sessionId,
      'tenant.id': tenantId,
      'onboarding.step_duration_ms': now - prevUpdatedAt,
    },
  });
  try {
    recordEvidence(tx, {
      tenantId,
      controlId: 'CC1.5',
      evidenceType: 'onboarding_step_completed',
      payload: { sessionId, step, durationMs: now - prevUpdatedAt, ...extra },
    });
  } catch (err) {
    /* Evidence write must not break the user flow; the metric counter
     * already captured the event so we can reconcile later. */
    span.recordException(err as Error);
  } finally {
    span.end();
  }
}

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type OnboardingV2Step = 1 | 2 | 3 | 4 | 5;

export interface OnboardingV2Session {
  readonly id: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly currentStep: OnboardingV2Step;
  readonly organizationId: string | null;
  readonly agentId: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly completedAt: number | null;
  readonly expiresAt: number;
  readonly resumed: boolean;
}

export interface OnboardingPolicyInput {
  readonly toolId: string;
  readonly scope: 'read' | 'write' | 'any';
  readonly decision: 'allow' | 'deny' | 'confirm';
}

interface SessionRow {
  id: string;
  tenant_id: string;
  user_id: string | null;
  current_step: number;
  organization_id: string | null;
  agent_id: string | null;
  completed_at: number | null;
  created_at: number;
  updated_at: number;
}

export class OnboardingV2Service {
  constructor(private readonly db: IDatabase) {}

  /** 启动或恢复会话。同 user_id 的未完成会话会被返回（idempotent）。 */
  start(tenantId: string, userId: string): OnboardingV2Session {
    const existing = this.db.prepare<SessionRow>(
      `SELECT * FROM onboarding_sessions
        WHERE tenant_id = ? AND user_id = ? AND completed_at IS NULL
        ORDER BY created_at DESC LIMIT 1`,
    ).get(tenantId, userId);

    const now = Date.now();
    if (existing && now - existing.created_at < SESSION_TTL_MS) {
      return this.rowToSession(existing, true, now);
    }

    const id = `onb_${randomUUID()}`;
    this.db.prepare(
      `INSERT INTO onboarding_sessions
         (id, tenant_id, user_id, current_step, completed_steps_json, created_at, updated_at)
       VALUES (?, ?, ?, 1, '[]', ?, ?)`,
    ).run(id, tenantId, userId, now, now);
    onboardingStarted.add(1, { cohort: 'v2' });
    try {
      recordEvidence(this.db, {
        tenantId,
        controlId: 'CC1.5',
        evidenceType: 'onboarding_started',
        payload: { sessionId: id, userId },
      });
    } catch { /* never fail user flow on evidence failure */ }

    /* 读回带 tenant_id（②b 隔离收敛）：与其它 v2 读/改路径一致，消除唯一的 id-only 读。 */
    const row = this.db.prepare<SessionRow>(
      'SELECT * FROM onboarding_sessions WHERE id = ? AND tenant_id = ?',
    ).get(id, tenantId);
    if (!row) throw new Error(`onboarding session ${id} 创建后无法读回`);
    return this.rowToSession(row, false, now);
  }

  /** 标记 step 1 完成：组织已创建（org 创建由调用方 OrganizationService 执行） */
  recordOrganizationStep(
    sessionId: string,
    tenantId: string,
    organizationId: string,
  ): OnboardingV2Session {
    const session = this.requireActiveSession(sessionId, tenantId);
    if (session.currentStep > 1 && session.organizationId === organizationId) {
      /* 幂等：同一 org 重复绑定不更新 */
      return session;
    }
    const now = Date.now();
    const prevUpdatedAt = session.updatedAt;
    this.db.prepare(
      `UPDATE onboarding_sessions
         SET organization_id = ?, current_step = 2, updated_at = ?
       WHERE id = ? AND tenant_id = ?`,
    ).run(organizationId, now, sessionId, tenantId);
    emitStepTelemetry(this.db, tenantId, sessionId, 1, prevUpdatedAt, { organizationId });
    return this.requireActiveSession(sessionId, tenantId);
  }

  /** 标记 step 2 完成：agent 已创建并（可选）绑定 LLM key */
  recordAgentStep(
    sessionId: string,
    tenantId: string,
    agentId: string,
  ): OnboardingV2Session {
    const session = this.requireActiveSession(sessionId, tenantId);
    if (session.currentStep < 2) {
      throw new ValidationError(
        `必须先完成 step 1（organization），当前 step=${session.currentStep}`,
        ErrorCode.STATE_INVALID_TRANSITION,
      );
    }
    const now = Date.now();
    const prevUpdatedAt = session.updatedAt;
    this.db.prepare(
      `UPDATE onboarding_sessions
         SET agent_id = ?, current_step = 3, updated_at = ?
       WHERE id = ? AND tenant_id = ?`,
    ).run(agentId, now, sessionId, tenantId);
    emitStepTelemetry(this.db, tenantId, sessionId, 2, prevUpdatedAt, { agentId });
    return this.requireActiveSession(sessionId, tenantId);
  }

  /** 标记 step 3 完成：策略已写入 */
  recordPolicyStep(sessionId: string, tenantId: string): OnboardingV2Session {
    const session = this.requireActiveSession(sessionId, tenantId);
    if (session.currentStep < 3) {
      throw new ValidationError(
        `必须先完成 step 2（agent），当前 step=${session.currentStep}`,
        ErrorCode.STATE_INVALID_TRANSITION,
      );
    }
    const now = Date.now();
    const prevUpdatedAt = session.updatedAt;
    this.db.prepare(
      `UPDATE onboarding_sessions
         SET current_step = 4, updated_at = ?
       WHERE id = ? AND tenant_id = ?`,
    ).run(now, sessionId, tenantId);
    emitStepTelemetry(this.db, tenantId, sessionId, 3, prevUpdatedAt);
    return this.requireActiveSession(sessionId, tenantId);
  }

  /** 标记 step 4 完成：合成 invocation 已写入 */
  recordSyntheticStep(
    sessionId: string,
    tenantId: string,
    invocationIds: readonly string[],
  ): OnboardingV2Session {
    const session = this.requireActiveSession(sessionId, tenantId);
    if (session.currentStep < 4) {
      throw new ValidationError(
        `必须先完成 step 3（policy），当前 step=${session.currentStep}`,
        ErrorCode.STATE_INVALID_TRANSITION,
      );
    }
    const now = Date.now();
    const prevUpdatedAt = session.updatedAt;
    this.db.transaction(() => {
      for (const invocationId of invocationIds) {
        this.db.prepare(
          `INSERT INTO onboarding_synthetic_invocations
             (invocation_id, session_id, created_at)
           VALUES (?, ?, ?)
           ON CONFLICT (invocation_id) DO NOTHING`,
        ).run(invocationId, sessionId, now);
      }
      this.db.prepare(
        `UPDATE onboarding_sessions
           SET current_step = 5, updated_at = ?
         WHERE id = ? AND tenant_id = ?`,
      ).run(now, sessionId, tenantId);
    });
    emitStepTelemetry(this.db, tenantId, sessionId, 4, prevUpdatedAt, { invocationCount: invocationIds.length });
    return this.requireActiveSession(sessionId, tenantId);
  }

  /** 标记 step 5 完成 / 整个引导结束 */
  complete(sessionId: string, tenantId: string, userId: string): OnboardingV2Session {
    /* requireActiveSession 校验：completion 不存在的会话应当 404 */
    const before = this.requireActiveSession(sessionId, tenantId);
    const now = Date.now();
    this.db.transaction(() => {
      this.db.prepare(
        `UPDATE onboarding_sessions
           SET current_step = 5, completed_at = ?, updated_at = ?
         WHERE id = ? AND tenant_id = ?`,
      ).run(now, now, sessionId, tenantId);
      /* 写到 users 的 onboarded_at —— 让 app shell 知道不要再展示引导。
       * 注意：skip 也写到这里（参见 skip()），二者语义一致：用户已表态。 */
      this.db.prepare(
        'UPDATE users SET onboarded_at = ?, updated_at = ? WHERE id = ?',
      ).run(now, now, userId);
    });
    emitStepTelemetry(this.db, tenantId, sessionId, 5, before.updatedAt);
    onboardingCompleted.add(1, { cohort: 'v2' });
    try {
      recordEvidence(this.db, {
        tenantId,
        controlId: 'CC1.5',
        evidenceType: 'onboarding_completed',
        payload: { sessionId, userId, totalDurationMs: now - before.createdAt },
      });
    } catch { /* swallow */ }
    return this.requireActiveSession(sessionId, tenantId);
  }

  /** 用户主动跳过：和 complete 同样写 onboarded_at，但 session 保留未 complete 标记，
   *  便于 PM 区分跳过 vs 完成（events_user_journey 那张表里再细分） */
  skip(sessionId: string, tenantId: string, userId: string): OnboardingV2Session {
    /* requireActiveSession 校验：跳过不存在的会话应当 404 */
    const before = this.requireActiveSession(sessionId, tenantId);
    const now = Date.now();
    this.db.prepare(
      'UPDATE users SET onboarded_at = ?, updated_at = ? WHERE id = ?',
    ).run(now, now, userId);
    onboardingSkipped.add(1, { cohort: 'v2', last_step: String(before.currentStep) });
    try {
      recordEvidence(this.db, {
        tenantId,
        controlId: 'CC1.5',
        evidenceType: 'onboarding_skipped',
        payload: { sessionId, userId, lastStep: before.currentStep },
      });
    } catch { /* swallow */ }
    return this.requireActiveSession(sessionId, tenantId);
  }

  /** 取 user 的当前活跃会话（用于前端 mount 时决定跳到哪一步） */
  getActiveByUser(tenantId: string, userId: string): OnboardingV2Session | null {
    const row = this.db.prepare<SessionRow>(
      `SELECT * FROM onboarding_sessions
        WHERE tenant_id = ? AND user_id = ? AND completed_at IS NULL
        ORDER BY created_at DESC LIMIT 1`,
    ).get(tenantId, userId);
    if (!row) return null;
    const now = Date.now();
    if (now - row.created_at >= SESSION_TTL_MS) return null;
    return this.rowToSession(row, true, now);
  }

  /** 用户已完成引导？(read users.onboarded_at) */
  hasOnboarded(userId: string): boolean {
    const row = this.db.prepare<{ onboarded_at: number | null }>(
      'SELECT onboarded_at FROM users WHERE id = ?',
    ).get(userId);
    return row?.onboarded_at != null;
  }

  /** 生成 step 4 用的 3 行合成 invocation 数据 */
  buildSyntheticInvocations(agentId: string, userId: string): SyntheticInvocationDraft[] {
    const now = Date.now();
    return [
      {
        toolId: 'github.read_issues',
        status: 'success',
        inputHash: sha256(`synthetic-1-${agentId}-${now}`),
        outputSizeBytes: 312,
        durationMs: 87,
        invokerUserId: userId,
        errorMessage: null,
      },
      {
        toolId: 'email.send',
        status: 'pending_confirmation',
        inputHash: sha256(`synthetic-2-${agentId}-${now}`),
        outputSizeBytes: 0,
        durationMs: 12,
        invokerUserId: userId,
        errorMessage: null,
      },
      {
        toolId: 'github.write_pr',
        status: 'denied_permission',
        inputHash: sha256(`synthetic-3-${agentId}-${now}`),
        outputSizeBytes: 0,
        durationMs: 4,
        invokerUserId: userId,
        errorMessage: 'policy_denied: tool not in allowed_tools_json',
      },
    ];
  }

  private requireActiveSession(sessionId: string, tenantId: string): OnboardingV2Session {
    const row = this.db.prepare<SessionRow>(
      'SELECT * FROM onboarding_sessions WHERE id = ? AND tenant_id = ?',
    ).get(sessionId, tenantId);
    if (!row) {
      throw new NotFoundError(
        `引导会话 ${sessionId} 不存在`,
        ErrorCode.NOT_FOUND_ONBOARDING,
      );
    }
    return this.rowToSession(row, false, Date.now());
  }

  private rowToSession(row: SessionRow, resumed: boolean, _now: number): OnboardingV2Session {
    return {
      id: row.id,
      tenantId: row.tenant_id,
      userId: row.user_id ?? '',
      currentStep: Math.min(Math.max(row.current_step, 1), 5) as OnboardingV2Step,
      organizationId: row.organization_id,
      agentId: row.agent_id,
      completedAt: row.completed_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      expiresAt: row.created_at + SESSION_TTL_MS,
      resumed,
    };
  }
}

export interface SyntheticInvocationDraft {
  readonly toolId: string;
  readonly status: 'success' | 'pending_confirmation' | 'denied_permission';
  readonly inputHash: string;
  readonly outputSizeBytes: number;
  readonly durationMs: number;
  readonly invokerUserId: string;
  readonly errorMessage: string | null;
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

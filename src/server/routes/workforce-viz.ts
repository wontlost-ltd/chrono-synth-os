/**
 * 数字员工组织可视化聚合 API（只读，企业控制台用）。
 *
 * 把分散在多个只读源（组织图 / 目标任务 / worker 信号 / ADR-0057 学习闭环）的数据，一次聚合成一个
 * **面向渲染**的 viz 载荷，前端 apps/web 直接画图（组织树 + 目标任务流 + 信号仪表 + 学习闭环），免去前端
 * 多次拉取 + 客户端 join。零-LLM、确定性（全部源都是确定性只读查询 + 纯函数信号派生）。
 *
 * 与 workforce.ts 同款门：仅用户 JWT（拒 apikey 主体）+ 租户隔离（request.tenantId）+ org_id 路径参数。
 * 复用既有 store/service，不新增写入、不碰执行。
 *
 * 路由：GET /api/v1/workforce/orgs/:orgId/visualization
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { IDatabase } from '../../storage/database.js';
import type { Clock } from '../../utils/clock.js';
import type { JwtPayload } from '../../types/auth.js';
import { AuthorizationError, ErrorCode } from '../../errors/index.js';
import { OrgWorkforceStore } from '../../storage/org-workforce-store.js';
import { LearningRequestStore } from '../../storage/learning-request-store.js';
import { CapabilityIndexStore } from '../../storage/capability-index-store.js';
import { WorkerSignalsService } from '../../workforce/worker-signals-service.js';
import { WorkerPersonaSignalsService } from '../../workforce/worker-persona-signals-service.js';
import { WorkerCollaborationMemoryStore } from '../../storage/worker-collaboration-memory-store.js';
import type { OrgTask, LearningRequest, TaskStatus } from '../../workforce/types.js';

/** 仅用户 JWT 可访问（拒 apikey 主体）——与 workforce.ts 同款门。 */
function requireJwtUser(request: { user?: JwtPayload }): JwtPayload {
  const user = request.user;
  if (!user || user.sub.startsWith('apikey:')) {
    throw new AuthorizationError('数字员工组织接口仅支持用户 JWT 访问', ErrorCode.AUTH_INSUFFICIENT_ROLE);
  }
  return user;
}

/** 学习 blocked 任务的处置分类（据 result_summary 标记派生，确定性）。 */
type BlockedDisposition = 'gap' | 'degraded' | 'timeout';

function dispositionOf(task: OrgTask): BlockedDisposition {
  const summary = task.resultSummary ?? '';
  if (summary.includes('[learning_timeout]')) return 'timeout';
  if (summary.includes('[降级]')) return 'degraded';
  return 'gap';
}

export function registerWorkforceVizRoutes(app: FastifyInstance, db: IDatabase, clock: Clock): void {
  const storeFor = (request: FastifyRequest): OrgWorkforceStore => new OrgWorkforceStore(db, request.tenantId);
  const now = (): number => clock.now();

  app.get<{ Params: { orgId: string } }>('/api/v1/workforce/orgs/:orgId/visualization', async (request) => {
    requireJwtUser(request);
    const { orgId } = request.params;
    const store = storeFor(request);
    const lrStore = new LearningRequestStore(db, request.tenantId);
    const capIndex = new CapabilityIndexStore(db, request.tenantId);
    const signalsSvc = new WorkerSignalsService(store, now);
    const personaSvc = new WorkerPersonaSignalsService(signalsSvc, new WorkerCollaborationMemoryStore(db, request.tenantId));

    /* ── 基础结构 ── */
    const positions = store.listPositions(orgId);
    const workers = store.listWorkers(orgId);
    const edges = store.listEdges(orgId);
    const goals = store.listGoals(orgId);
    const positionById = new Map(positions.map((p) => [p.id, p]));

    /* ── ① 组织树节点（worker + 岗位原型 + 雇佣状态 + 信号摘要）── */
    const orgTreeNodes = workers.map((w) => {
      const pos = positionById.get(w.positionId);
      const signal = signalsSvc.getOperatingSignal(orgId, w.id);
      return {
        workerId: w.id,
        personaId: w.personaId,
        displayName: w.displayName,
        employmentStatus: w.employmentStatus,
        roleCode: pos?.roleCode ?? '',
        title: pos?.title ?? '',
        jobFamily: pos?.jobFamily ?? '',
        seniority: pos?.seniority ?? 'ic',
        /* 信号摘要（节点上色/标记用）。 */
        load: signal?.load ?? 'idle',
        needsAttention: signal?.needsAttention ?? false,
        activeTaskCount: signal?.activeTaskCount ?? 0,
      };
    });
    /* 汇报边（manager→report）。根节点 managerWorkerId=null（不画边）。 */
    const orgTreeEdges = edges
      .filter((e) => e.managerWorkerId !== null)
      .map((e) => ({ from: e.managerWorkerId as string, to: e.reportWorkerId, edgeType: e.edgeType }));

    /* ── ② 目标 → 任务流（每目标的任务状态分布，让管理者看推进/卡点）── */
    const goalFlow = goals.map((g) => {
      const tasks = store.listTasksByGoal(orgId, g.id);
      const byStatus = countByStatus(tasks);
      return {
        goalId: g.id,
        title: g.title,
        status: g.status,
        ownerWorkerId: g.ownerWorkerId,
        taskCount: tasks.length,
        tasksByStatus: byStatus,
        /* 卡点摘要：blocked 任务数（含学习挂起）。 */
        blockedCount: byStatus.blocked ?? 0,
      };
    });

    /* ── ③ worker 信号仪表（运行信号 + 人格信号）── */
    const signals = workers.map((w) => {
      const operating = signalsSvc.getOperatingSignal(orgId, w.id);
      const persona = personaSvc.getPersonaSignal(orgId, w.id);
      return {
        workerId: w.id,
        displayName: w.displayName,
        operating: operating ?? null,
        persona: persona ? { decisionConfidence: persona.decisionConfidence, collaborationReach: persona.collaborationReach, shouldReport: persona.shouldReport } : null,
      };
    });

    /* ── ④ ADR-0057 学习闭环（net-new 聚合）：每 persona 已学能力 / 进行中学习 / 挂起处置 ── */
    const learningLoop = buildLearningLoop(orgId, workers, store, lrStore, capIndex);

    return {
      data: {
        orgId,
        orgTree: { nodes: orgTreeNodes, edges: orgTreeEdges },
        goalFlow,
        signals,
        learningLoop,
      },
    };
  });
}

/** 任务按状态计数（确定性，全状态键齐全，前端画堆叠条不缺键）。 */
function countByStatus(tasks: readonly OrgTask[]): Record<TaskStatus, number> {
  const counts: Record<TaskStatus, number> = {
    draft: 0, delegated: 0, in_progress: 0, submitted: 0, approved: 0, rejected: 0, blocked: 0,
  };
  for (const t of tasks) counts[t.status]++;
  return counts;
}

/**
 * 学习闭环聚合（per persona，零-LLM 确定性）：
 *   - learnedCapabilities：CapabilityIndex 已学能力（正式来源，含 examScore）。
 *   - activeLearning：进行中学习请求（pending/learning）。
 *   - blockedTasks：因学习缺口挂起的任务，按处置分类（gap/degraded/timeout）。
 * per-persona 隔离（红线 8）：学习账本/能力索引均按 personaId 查；org-level 任务按 orgId。
 */
function buildLearningLoop(
  orgId: string,
  workers: ReturnType<OrgWorkforceStore['listWorkers']>,
  store: OrgWorkforceStore,
  lrStore: LearningRequestStore,
  capIndex: CapabilityIndexStore,
) {
  /* org 内全部学习 blocked 任务（仅有关联学习请求的；按 assignee 分组）。 */
  const blockedTasks = store.listLearningBlockedTasks(orgId);
  const blockedByWorker = new Map<string, OrgTask[]>();
  for (const t of blockedTasks) {
    if (!t.assignedToWorkerId) continue;
    const arr = blockedByWorker.get(t.assignedToWorkerId) ?? [];
    arr.push(t);
    blockedByWorker.set(t.assignedToWorkerId, arr);
  }

  /* org 内进行中学习请求（pending + learning），按 persona 分组。 */
  const activePending = lrStore.listByOrg(orgId, 'pending');
  const activeLearning = lrStore.listByOrg(orgId, 'learning');
  const activeByPersona = new Map<string, LearningRequest[]>();
  for (const r of [...activePending, ...activeLearning]) {
    const arr = activeByPersona.get(r.personaId) ?? [];
    arr.push(r);
    activeByPersona.set(r.personaId, arr);
  }

  return workers.map((w) => {
    const learned = capIndex.listByPersona(w.personaId);
    const active = activeByPersona.get(w.personaId) ?? [];
    const blocked = (blockedByWorker.get(w.id) ?? []).map((t) => ({
      taskId: t.id,
      title: t.title,
      disposition: dispositionOf(t),
      requiredCapabilities: t.requiredCapabilities,
      resumeAttemptCount: t.resumeAttemptCount,
    }));
    return {
      workerId: w.id,
      personaId: w.personaId,
      displayName: w.displayName,
      learnedCapabilities: learned.map((e) => ({ capability: e.capability, examScore: e.examScore, learnedAt: e.learnedAt })),
      activeLearning: active.map((r) => ({ capability: r.capability, status: r.status, priority: r.priority })),
      blockedTasks: blocked,
    };
  });
}

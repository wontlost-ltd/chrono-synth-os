/**
 * 数字员工组织**交互控制台**写/动作 API（E3，ADR-0055）。
 *
 * 把 D 链（D1 actor / D2 审批门 / D3 真实执行）接进生产 HTTP——人类经控制台**驱动**数字员工：
 *   - 发起目标（manager 数字员工确定性分解→委派→执行 stub→汇报→聚合；**不调真实工具**）；
 *   - 看「待我审批」+ 人类 approve/reject；
 *   - 请求执行审批（按有效风险拿审批 id）；
 *   - 触发某已委派任务**真实执行**（接 ToolInvocationPipeline，全确定性门控）。
 *
 * 红线（Codex 复审强化的安全面）：
 *   - 写/动作路由是**治理级操作** → preHandler requireRole('admin')（与 privacy/GDPR 同级），不止 JWT；
 *     （workforce org_id 是自由字符串、无 organization_memberships 支撑，故用租户级 admin 角色门，非 org-RBAC）；
 *   - 人类法律 principal = 当前登录用户（request.user.sub）——body **无** principal 字段，不可冒充；
 *   - **风险信号服务端派生**（deriveRiskSignals 读 tool registry），body 只能上调不能下调——
 *     否则 low 任务 + 高风险工具可被省略信号绕过审批门直接对外执行（铁律1）；
 *   - 审批放行走 D3 绑定校验（isExecutionApprovalCleared）；pending_confirmation 不自动补 token；
 *   - D2/D3 领域错误转稳定 4xx（不泄露 500），写路由加限流（防滥用）。
 */

import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { IDatabase } from '../../storage/database.js';
import type { Clock } from '../../utils/clock.js';
import type { JwtPayload } from '../../types/auth.js';
import { NotFoundError, StateError, ValidationError, ChronoError, ErrorCode } from '../../errors/index.js';
import { requireRole } from '../plugins/rbac.js';
import { OrgWorkforceStore } from '../../storage/org-workforce-store.js';
import { OrgChartService } from '../../workforce/org-chart-service.js';
import { OrgPlanningService } from '../../workforce/org-planning-service.js';
import { ApprovalService, InvalidApprovalError } from '../../workforce/approval-service.js';
import { WorkerExecutionService, WorkerExecutionError, type ToolExecutor } from '../../workforce/worker-execution-service.js';
import { MissingHumanPrincipalError } from '../../workforce/worker-execution-actor.js';
import { LearningRequestService } from '../../workforce/learning-request-service.js';
import { LearningRequestStore } from '../../storage/learning-request-store.js';
import { CapabilityIndexStore } from '../../storage/capability-index-store.js';
import { CapabilityAssignmentService } from '../../workforce/capability-assignment-service.js';
import { TaskDispositionService } from '../../workforce/task-disposition-service.js';
import { UnsupportedGoalTypeError, AssigneeNotFoundError } from '../../workforce/org-planning-service.js';
import { deriveRiskSignals, type ToolRiskSource } from '../../workforce/tool-risk-deriver.js';
import {
  WorkforceRunGoalBodySchema, WorkforceApprovalDecisionBodySchema,
  WorkforceExecuteTaskBodySchema, WorkforceRequestApprovalBodySchema,
} from '../schemas/api-schemas.js';

/** 写路由限流（治理级操作，防滥用/DoS；与 privacy 同量级）。 */
const WRITE_RATE = { rateLimit: { max: 30, timeWindow: '1 minute' } } as const;

/** 当前登录用户（preHandler requireRole 已确保是 admin 用户 JWT；此处只取 sub 作 principal）。 */
function currentUser(request: { user?: JwtPayload }): JwtPayload {
  /* requireRole 已挡非 admin / apikey；理论不会走到这里，防御性兜底。 */
  if (!request.user) throw new ValidationError('缺少用户身份', ErrorCode.VALIDATION_REQUIRED);
  return request.user;
}

/**
 * 把 D2/D3 领域错误转成稳定 4xx（不泄露 500）：
 *   - NotFound 类 → 由调用处先抛 NotFoundError；
 *   - 审批非法/执行前置不满足/缺 principal/未知 goalType/assignee 缺失 → 409 或 400。
 * ChronoError 直接放行（已带 statusCode）。
 */
function as4xx(err: unknown): never {
  if (err instanceof ChronoError) throw err;
  if (err instanceof MissingHumanPrincipalError) throw new ValidationError(err.message, ErrorCode.VALIDATION_REQUIRED);
  if (err instanceof UnsupportedGoalTypeError) throw new ValidationError(err.message, ErrorCode.VALIDATION_RANGE);
  if (err instanceof AssigneeNotFoundError) throw new ValidationError(err.message, ErrorCode.VALIDATION_RANGE);
  if (err instanceof InvalidApprovalError) throw new StateError(err.message, ErrorCode.STATE_INVALID_TRANSITION);
  if (err instanceof WorkerExecutionError) throw new StateError(err.message, ErrorCode.STATE_INVALID_TRANSITION);
  throw err; /* 真未知错误仍交全局 handler（500），不掩盖 bug。 */
}

export function registerWorkforceActionRoutes(
  app: FastifyInstance, db: IDatabase, executor: ToolExecutor, clock: Clock, toolRisk: ToolRiskSource,
): void {
  const storeFor = (request: FastifyRequest): OrgWorkforceStore => new OrgWorkforceStore(db, request.tenantId);
  const now = (): number => clock.now();
  /* 治理级写动作统一门：admin 角色 + 限流。 */
  const guarded = { preHandler: requireRole('admin'), config: WRITE_RATE };

  /**
   * 按组织当前数字员工重建 roleCode→workerId（runGoal 需把分解的 assigneeRoleCode 映射到下属）。
   * 确定性：listWorkers/listPositions 均 ORDER BY created_at,id；同 role 多 worker 时取**最早创建**那个
   * （首个 set 后不覆盖），保证相同组织相同委派。
   */
  const workerIdByRole = (store: OrgWorkforceStore, orgId: string): ReadonlyMap<string, string> => {
    const roleByPosition = new Map(store.listPositions(orgId).map((p) => [p.id, p.roleCode]));
    const map = new Map<string, string>();
    for (const w of store.listWorkers(orgId)) {
      const role = roleByPosition.get(w.positionId);
      if (role && !map.has(role)) map.set(role, w.id); /* 同 role 取最早，不覆盖 → 确定性 */
    }
    return map;
  };

  /* POST 发起目标：manager 数字员工运行一个目标（确定性分解→委派→执行 stub→汇报→聚合）。
   * 注：runGoal 用确定性执行 stub（**不调真实工具、无对外副作用**）；真实工具执行走下方 execute 接口。 */
  app.post<{ Params: { orgId: string } }>('/api/v1/workforce/orgs/:orgId/goals', guarded, async (request, reply) => {
    currentUser(request);
    const body = WorkforceRunGoalBodySchema.parse(request.body);
    const { orgId } = request.params;
    const store = storeFor(request);
    if (!store.getWorker(orgId, body.managerWorkerId)) {
      throw new NotFoundError(`数字员工 ${body.managerWorkerId} 不存在`, ErrorCode.NOT_FOUND_TASK);
    }
    const planning = new OrgPlanningService(store, new OrgChartService(store, now), now);
    try {
      const result = planning.runGoal(
        orgId, body.managerWorkerId,
        { title: body.title, description: body.description, goalType: body.goalType },
        workerIdByRole(store, orgId),
      );
      reply.code(201);
      /* result 含 pendingRealExecution / goalStatus：纯推理环节 stub 完成，需真实工具的环节留 delegated
       * 待治理执行门（A↔D 集成）。前端据此引导「还有 N 个环节待执行/审批」，不误导为已全部对外完成。 */
      return { data: result };
    } catch (err) { as4xx(err); }
  });

  /* GET 待审批列表（控制台「待我审批」视图；先 expire 过期再列）。 */
  app.get<{ Params: { orgId: string } }>('/api/v1/workforce/orgs/:orgId/approvals/pending', { preHandler: requireRole('admin') }, async (request) => {
    currentUser(request);
    const store = storeFor(request);
    const { orgId } = request.params;
    store.expireStaleApprovals(orgId, now());
    return { data: store.listPendingApprovals(orgId) };
  });

  /* POST 请求执行审批：服务端按有效风险（任务 A0 风险 + **工具派生风险** + body 声明信号）算；low → auto_cleared。 */
  app.post<{ Params: { orgId: string } }>('/api/v1/workforce/orgs/:orgId/approvals', guarded, async (request, reply) => {
    currentUser(request);
    const body = WorkforceRequestApprovalBodySchema.parse(request.body);
    const { orgId } = request.params;
    const store = storeFor(request);
    const task = store.getTask(orgId, body.taskId);
    if (!task) throw new NotFoundError(`任务 ${body.taskId} 不存在`, ErrorCode.NOT_FOUND_TASK);
    /* 风险信号服务端派生（toolId 给定时读 registry，用**真实 args** 派生动态高风险——与 execute 同 args，
     * 避免「申请审批 auto_cleared 但执行又 needs_approval」的坏流程；否则按 body 声明；只增不减）。 */
    const signals = body.toolId
      ? deriveRiskSignals(toolRisk, body.toolId, body.arguments, body.riskSignals)
      : (body.riskSignals ?? {});
    const approvals = new ApprovalService(store, now, undefined, request.tenantId);
    try {
      const result = approvals.request({
        orgId, subjectType: 'task_execution', subjectId: body.taskId,
        requesterWorkerId: body.requesterWorkerId,
        risk: { taskRisk: task.riskLevel, ...signals },
        allowWorkerApproval: body.allowWorkerApproval,
        ...(body.ttlMs !== undefined ? { ttlMs: body.ttlMs } : {}),
      });
      reply.code(201);
      return { data: result };
    } catch (err) { as4xx(err); }
  });

  /* POST 人类决定一个审批（approve/reject）。principal = 当前登录用户（人类法律责任主体）。 */
  app.post<{ Params: { orgId: string; approvalId: string } }>('/api/v1/workforce/orgs/:orgId/approvals/:approvalId/decision', guarded, async (request) => {
    const user = currentUser(request);
    const body = WorkforceApprovalDecisionBodySchema.parse(request.body);
    const { orgId, approvalId } = request.params;
    const store = storeFor(request);
    if (!store.getApproval(orgId, approvalId)) {
      throw new NotFoundError(`审批 ${approvalId} 不存在`, ErrorCode.NOT_FOUND_TASK);
    }
    const approvals = new ApprovalService(store, now, undefined, request.tenantId);
    /* 控制台决策一律走**人类**路径（approverUserId = 登录用户 sub）——上级数字员工审批不经此 HTTP 入口。 */
    try {
      if (body.decision === 'approve') {
        approvals.approveByHuman(orgId, approvalId, user.sub);
      } else {
        approvals.reject(orgId, approvalId, { userId: user.sub });
      }
    } catch (err) { as4xx(err); }
    return { data: store.getApproval(orgId, approvalId) };
  });

  /* POST 触发某已委派任务真实执行（D3：接 ToolInvocationPipeline，全确定性门控 + 审批门 + 人类 principal）。 */
  app.post<{ Params: { orgId: string; taskId: string } }>('/api/v1/workforce/orgs/:orgId/tasks/:taskId/execute', guarded, async (request) => {
    const user = currentUser(request);
    const body = WorkforceExecuteTaskBodySchema.parse(request.body);
    const { orgId, taskId } = request.params;
    const store = storeFor(request);
    const approvals = new ApprovalService(store, now, undefined, request.tenantId);
    /* ADR-0057 L2+L7：注入学习请求 service——执行前确定性能力缺口门（缺则 learning_required，不硬干）。
     * L7：注入 CapabilityIndexStore，已学能力优先读正式索引（∪ L2 passed 兜底）。 */
    const learning = new LearningRequestService(
      new LearningRequestStore(db, request.tenantId), now, randomUUID, request.tenantId,
      new CapabilityIndexStore(db, request.tenantId),
    );
    /* ADR-0057 L8b：缺口处置——挂起前先尝试委派给有能力的同事（尽量不卡死）。降级默认关（保守，
     * allowDegrade 缺省 false）——避免对「必须做全」的任务标 submitted 误读为完成；委派失败则落 L8a 挂起。 */
    const disposition = new TaskDispositionService({
      store, capabilities: new CapabilityAssignmentService(store, learning), now,
    });
    const svc = new WorkerExecutionService(store, approvals, executor, now, request.tenantId, learning, disposition);
    /* 风险信号服务端派生（读 registry；body 只能上调，不能省略高风险工具来绕审批门）。 */
    const signals = deriveRiskSignals(toolRisk, body.toolId, body.arguments, body.riskSignals);
    let result;
    try {
      result = await svc.execute({
        orgId, taskId, workerId: body.workerId,
        /* 人类法律 principal = 当前登录用户（org_worker 不得无 principal 执行，ADR-0055 D0.1）。 */
        principalUserId: user.sub,
        toolId: body.toolId, arguments: body.arguments,
        riskSignals: signals,
        ...(body.approvalId ? { approvalId: body.approvalId } : {}),
        ...(body.confirmationToken ? { confirmationToken: body.confirmationToken } : {}),
      });
    } catch (err) { as4xx(err); }
    /* needs_approval / needs_pipeline_confirmation 不是 5xx——是确定性门控的正常结果，返回 200 让前端引导下一步。 */
    if (result.kind === 'failed') {
      throw new StateError(`执行被拦截/失败：${result.status}（${result.reason}）`, ErrorCode.STATE_INVALID_TRANSITION);
    }
    return { data: result };
  });
}

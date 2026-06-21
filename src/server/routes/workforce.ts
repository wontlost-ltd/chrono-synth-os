/**
 * 数字员工组织只读 API（E1）。
 *
 * 把数字组织的结构与活动暴露成只读 GET 接口——回答「我的数字员工在干嘛」的数据基础。
 * **只读**：不创建/委派/执行任何东西（写操作留后续切片，且必须走授权/审批）。
 * JWT 鉴权 + 租户隔离（request.tenantId）；org_id 来自路径参数，store 显式按 tenant+org 过滤。
 *
 * 路由（enterprise 侧，不碰 /companion）：
 *   GET /api/v1/workforce/goal-types                       — 支持的 goal type（含 rubric）
 *   GET /api/v1/workforce/orgs/:orgId/chart                — 组织图（岗位+员工+汇报关系）
 *   GET /api/v1/workforce/orgs/:orgId/goals                — 目标列表
 *   GET /api/v1/workforce/orgs/:orgId/goals/:goalId        — 单目标 + 其任务 + 汇报链
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { IDatabase } from '../../storage/database.js';
import type { JwtPayload } from '../../types/auth.js';
import { AuthorizationError, NotFoundError, ErrorCode } from '../../errors/index.js';
import { OrgWorkforceStore } from '../../storage/org-workforce-store.js';
import { getDecompositionPlaybook, supportedGoalTypes } from '../../workforce/decomposition-playbook.js';

/** 仅用户 JWT 可访问（拒 apikey 主体）——与 persona-core 同款门。 */
function requireJwtUser(request: { user?: JwtPayload }): JwtPayload {
  const user = request.user;
  if (!user || user.sub.startsWith('apikey:')) {
    throw new AuthorizationError('数字员工组织接口仅支持用户 JWT 访问', ErrorCode.AUTH_INSUFFICIENT_ROLE);
  }
  return user;
}

export function registerWorkforceRoutes(app: FastifyInstance, db: IDatabase): void {
  const storeFor = (request: FastifyRequest): OrgWorkforceStore => new OrgWorkforceStore(db, request.tenantId);

  /* 支持的 goal type + 各自质量 rubric（前端建目标时可见）。 */
  app.get('/api/v1/workforce/goal-types', async (request) => {
    requireJwtUser(request);
    const types = supportedGoalTypes().map((goalType) => {
      const pb = getDecompositionPlaybook(goalType)!;
      return { goalType, qualityRubric: pb.qualityRubric };
    });
    return { data: types };
  });

  /* 组织图：岗位 + 数字员工 + 汇报关系（一次取齐，前端画组织树）。 */
  app.get<{ Params: { orgId: string } }>('/api/v1/workforce/orgs/:orgId/chart', async (request) => {
    requireJwtUser(request);
    const store = storeFor(request);
    const { orgId } = request.params;
    return {
      data: {
        orgId,
        positions: store.listPositions(orgId),
        workers: store.listWorkers(orgId),
        reportingEdges: store.listEdges(orgId),
      },
    };
  });

  /* 目标列表（按时间序）。 */
  app.get<{ Params: { orgId: string } }>('/api/v1/workforce/orgs/:orgId/goals', async (request) => {
    requireJwtUser(request);
    return { data: storeFor(request).listGoals(request.params.orgId) };
  });

  /* 单目标详情：目标 + 任务（含 A0 契约字段）+ 汇报链（完整证据链，回答「这个目标谁干了啥」）。 */
  app.get<{ Params: { orgId: string; goalId: string } }>('/api/v1/workforce/orgs/:orgId/goals/:goalId', async (request) => {
    requireJwtUser(request);
    const store = storeFor(request);
    const { orgId, goalId } = request.params;
    const goal = store.getGoal(orgId, goalId);
    if (!goal) throw new NotFoundError(`目标 ${goalId} 不存在`, ErrorCode.NOT_FOUND_TASK);
    return {
      data: {
        goal,
        tasks: store.listTasksByGoal(orgId, goalId),
        reports: store.listReportsByGoal(orgId, goalId),
      },
    };
  });
}

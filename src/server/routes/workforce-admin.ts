/**
 * 数字员工组织**管理** API（生产 self-service：建组织 / 招数字员工）。
 *
 * 补上生产缺口——此前建组织/出生数字员工只能靠 seed-org 脚本（固定 pod、改脚本重部署）。本片让管理员经
 * 控制台/API **自助**：建组织（建首个根数字员工）+ 往已有组织招人（指定岗位/原型/直接上级），每名新员工
 * 出生**独立人格内核**（复用 WorkforcePersonaBootstrapService，零-LLM 确定性 + 原子 + 幂等）。
 *
 * 治理级操作（与 workforce-actions 同级）：preHandler requireRole('admin') + 写限流；租户隔离。
 * personaId 服务端按 (orgId, roleCode) 派生（前端不传），避免冲突/伪造/跨 persona 串。
 *
 * 路由：
 *   POST /api/v1/workforce/orgs                    — 建组织（+ 根数字员工）
 *   POST /api/v1/workforce/orgs/:orgId/workers     — 招一名数字员工到已有组织
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { IDatabase } from '../../storage/database.js';
import type { ChronoSynthOS } from '../../chrono-synth-os.js';
import type { TenantOSFactory } from '../../multi-tenant/tenant-os-factory.js';
import type { JwtPayload } from '../../types/auth.js';
import { StateError, ValidationError, ChronoError, ErrorCode } from '../../errors/index.js';
import { requireRole } from '../plugins/rbac.js';
import { OrgWorkforceStore } from '../../storage/org-workforce-store.js';
import { OrgChartService, InvalidOrgChartError } from '../../workforce/org-chart-service.js';
import { WorkforcePersonaBootstrapService } from '../../workforce/workforce-persona-bootstrap-service.js';
import { OrgRestructureService } from '../../workforce/org-restructure-service.js';
import { RestructureSuggestionsService } from '../../workforce/restructure-suggestions-service.js';
import {
  WorkforceCreateOrgBodySchema, WorkforceHireWorkerBodySchema,
  WorkforceAbsorbBodySchema, WorkforceReparentBodySchema, WorkforceOffboardBodySchema,
} from '../schemas/api-schemas.js';

/** 写路由限流（治理级，与 workforce-actions 同量级）。 */
const WRITE_RATE = { rateLimit: { max: 30, timeWindow: '1 minute' } } as const;

function currentUser(request: { user?: JwtPayload }): JwtPayload {
  if (!request.user) throw new ValidationError('缺少用户身份', ErrorCode.VALIDATION_REQUIRED);
  return request.user;
}

/** 组织结构非法（环/上级不存在/roleCode 重复/组织已存在等）→ 稳定 4xx。 */
function as4xx(err: unknown): never {
  if (err instanceof ChronoError) throw err;
  if (err instanceof InvalidOrgChartError) throw new StateError(err.message, ErrorCode.STATE_INVALID_TRANSITION);
  throw err;
}

/** personaId 服务端派生（按 orgId+roleCode 稳定唯一；同组织同岗位恒同 persona，防冲突/伪造）。 */
function derivePersonaId(orgId: string, roleCode: string): string {
  return `persona-${orgId}-${roleCode}`;
}

export function registerWorkforceAdminRoutes(app: FastifyInstance, db: IDatabase, os: ChronoSynthOS, tenantFactory?: TenantOSFactory): void {
  const storeFor = (request: FastifyRequest): OrgWorkforceStore => new OrgWorkforceStore(db, request.tenantId);
  const now = (): number => os.getClock().now();  /* 全租户共享时钟（重组是结构-only，宿主 db，不需 tenant-OS 时钟）。 */
  const guarded = { preHandler: requireRole('admin'), config: WRITE_RATE };

  /**
   * 按请求租户取 tenant-scoped OS（关键：人格出生必须落**请求租户**的内核表，否则非-default 租户的出生会落
   * default 租户=跨租户 bug；与 companion/value/memory 路由同款 getTenantOS 解析）。default 租户用 deps.os。
   */
  const osFor = (request: FastifyRequest): ChronoSynthOS => {
    const tid = request.tenantId;
    if (tenantFactory && tid && tid !== 'default') return tenantFactory.getTenantOS(tid);
    return os;
  };

  /* POST 建组织（+ 根数字员工，无上级）。组织由「有 worker」隐式存在 → 建组织即 bootstrap 单根 worker。 */
  app.post('/api/v1/workforce/orgs', guarded, async (request, reply) => {
    currentUser(request);
    const body = WorkforceCreateOrgBodySchema.parse(request.body);
    const tenantOS = osFor(request);
    /* 组织结构走**宿主 db + 显式 tenant_id**（与所有 workforce 路由同款，OrgWorkforceStore 自己写 tenant_id，
     * 不经 TenantDatabase 避双重 scope/参数错位）；人格出生走 **tenant-scoped OS 的 getCore**（落请求租户内核）。
     * 二者落同一宿主 db 的同一租户；原子性由 bootstrap 内 tenantOS.getDatabase().transaction()（委托宿主 db 同
     * 连接）覆盖——结构写（宿主 db store）与出生写（getCore）在同一事务，整体回滚。 */
    const store = storeFor(request);
    /* 组织已存在（有 worker）→ 拒（建组织是建新的，不是改既有）。 */
    if (store.listWorkers(body.orgId).length > 0) {
      throw new StateError(`组织 ${body.orgId} 已存在`, ErrorCode.STATE_INVALID_TRANSITION);
    }
    const orgChart = new OrgChartService(store, () => tenantOS.getClock().now());
    const bootstrap = new WorkforcePersonaBootstrapService(tenantOS, orgChart, () => tenantOS.getClock().now());
    try {
      /* bootstrap 一名根数字员工（managerRoleCode=null）+ 出生独立人格内核（原子事务）。 */
      const result = bootstrap.bootstrap(body.orgId, [{
        roleCode: body.roleCode, title: body.title, jobFamily: body.jobFamily, seniority: body.seniority,
        displayName: body.displayName, personaId: derivePersonaId(body.orgId, body.roleCode),
        managerRoleCode: null, archetype: body.archetype,
      }]);
      reply.code(201);
      const rootWorkerId = result.chart.workerIdByRole.get(body.roleCode)!;
      return { data: { orgId: body.orgId, rootWorkerId, birth: result.births[0] } };
    } catch (err) { as4xx(err); }
  });

  /* POST 招一名数字员工到已有组织（指定岗位/原型/直接上级 managerWorkerId）。出生独立人格内核。 */
  app.post<{ Params: { orgId: string } }>('/api/v1/workforce/orgs/:orgId/workers', guarded, async (request, reply) => {
    currentUser(request);
    const body = WorkforceHireWorkerBodySchema.parse(request.body);
    const { orgId } = request.params;
    const tenantOS = osFor(request);
    const store = storeFor(request);  /* 宿主 db + 显式 tenant_id（同建组织）。 */
    const orgChart = new OrgChartService(store, () => tenantOS.getClock().now());
    const bootstrap = new WorkforcePersonaBootstrapService(tenantOS, orgChart, () => tenantOS.getClock().now());
    try {
      /* hireWorker：增量校验（组织存在/上级存在/roleCode 唯一）+ 建结构 + 出生人格（原子事务）。 */
      const { workerId, birth } = bootstrap.hireWorker(orgId, {
        roleCode: body.roleCode, title: body.title, jobFamily: body.jobFamily, seniority: body.seniority,
        displayName: body.displayName, personaId: derivePersonaId(orgId, body.roleCode),
        managerRoleCode: null /* hireWorker 用 managerWorkerId，此字段不参与；占位满足 WorkerSpec。 */,
        managerWorkerId: body.managerWorkerId, archetype: body.archetype,
      });
      reply.code(201);
      return { data: { orgId, workerId, birth } };
    } catch (err) { as4xx(err); }
  });

  /* ── 重组/并购（确定性结构操作；决策由人类给，系统只执行+守不变量。结构-only 无人格写，用宿主 db store）── */

  /* POST 吸收：源组织并入本组织（路径 orgId=目标），源根接到 mountUnderWorkerId 下。 */
  app.post<{ Params: { orgId: string } }>('/api/v1/workforce/orgs/:orgId/absorb', guarded, async (request, reply) => {
    currentUser(request);
    const body = WorkforceAbsorbBodySchema.parse(request.body);
    const { orgId } = request.params;
    const svc = new OrgRestructureService(storeFor(request), now);
    try {
      const result = svc.absorb({ targetOrgId: orgId, sourceOrgId: body.sourceOrgId, mountUnderWorkerId: body.mountUnderWorkerId });
      reply.code(200);
      return { data: result };
    } catch (err) { as4xx(err); }
  });

  /* POST reparent：改某 worker 的直接上级。 */
  app.post<{ Params: { orgId: string } }>('/api/v1/workforce/orgs/:orgId/reparent', guarded, async (request) => {
    currentUser(request);
    const body = WorkforceReparentBodySchema.parse(request.body);
    const { orgId } = request.params;
    const svc = new OrgRestructureService(storeFor(request), now);
    try {
      svc.reparent({ orgId, workerId: body.workerId, newManagerWorkerId: body.newManagerWorkerId });
      return { data: { orgId, workerId: body.workerId, newManagerWorkerId: body.newManagerWorkerId } };
    } catch (err) { as4xx(err); }
  });

  /* POST offboard：裁撤一名 worker（有下属/在手任务须给安置/重分配对象）。 */
  app.post<{ Params: { orgId: string } }>('/api/v1/workforce/orgs/:orgId/offboard', guarded, async (request) => {
    currentUser(request);
    const body = WorkforceOffboardBodySchema.parse(request.body);
    const { orgId } = request.params;
    const svc = new OrgRestructureService(storeFor(request), now);
    try {
      svc.offboard({
        orgId, workerId: body.workerId,
        ...(body.reparentReportsTo ? { reparentReportsTo: body.reparentReportsTo } : {}),
        ...(body.reassignTasksTo ? { reassignTasksTo: body.reassignTasksTo } : {}),
      });
      return { data: { orgId, workerId: body.workerId, status: 'offboarded' } };
    } catch (err) { as4xx(err); }
  });

  /* GET 重组建议（确定性信号 → 建议，不自动执行；只读，admin 看治理）。 */
  app.get<{ Params: { orgId: string } }>('/api/v1/workforce/orgs/:orgId/restructure/suggestions', { preHandler: requireRole('admin') }, async (request) => {
    currentUser(request);
    const { orgId } = request.params;
    const suggestions = new RestructureSuggestionsService(storeFor(request), now).suggest(orgId);
    return { data: { orgId, suggestions } };
  });
}

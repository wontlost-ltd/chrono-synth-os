/**
 * 组织重组/并购 service（restructure & M&A）——把「大组织吸收小组织 + 重组保持竞争力」落成**确定性结构操作**。
 *
 * 守愿景红线：**决策由人类/外部给**（该不该吸收、该怎么重组是战略判断，不在此推理），本 service 只**确定性执行**
 * 结构变更，并守组织不变量（无环 / 单根 / 汇报唯一 / 不孤儿 / 在手任务不丢）。零-LLM，纯结构操作（不碰人格内核）。
 *
 * 三个执行原语 + 不变量守卫：
 *   1. **reparent**（改汇报线）：worker 挂到新上级下。守：新上级存在且 active、非自挂、**不成环**（新上级不在
 *      worker 子树里）。改既有汇报边（唯一约束 → UPDATE 非插新）。
 *   2. **offboard**（裁撤/下线）：worker 标 offboarded（软删保审计）。守：**非根**（根裁撤会让组织无根）、
 *      **下属先安置**（有直接下属须 reparent 给指定新上级，否则孤儿）、**在手任务先重分配**（delegated/in_progress/
 *      submitted 的任务须 reassign 给指定 worker，否则任务悬空）。原子。
 *   3. **absorb**（吸收/并购）：源组织 B 全部结构 + 派生数据迁入目标组织 A（12 张含 org_id 表），B 的根接到 A 的
 *      指定节点下。守：两组织都存在、挂载点存在且属 A 且 active、B 有根；**roleCode 冲突自动加后缀**（B 的撞名
 *      岗位改 `<role>__from_<B>`）；迁移后 A 仍单根（A 原根不变，B 根降为子节点）。原子（整事务，失败全回滚）。
 */

import type { OrgWorkforceStore } from '../storage/org-workforce-store.js';
import type { OrgTask } from './types.js';
import { InvalidOrgChartError } from './org-chart-service.js';

/** 在手任务状态（offboard 前须重分配的；已完成/拒绝的不算在手）。 */
const IN_HAND_STATUSES = new Set(['delegated', 'in_progress', 'submitted']);

export interface ReparentInput {
  readonly orgId: string;
  readonly workerId: string;
  readonly newManagerWorkerId: string;
}

export interface OffboardInput {
  readonly orgId: string;
  readonly workerId: string;
  /** 有直接下属时，把下属 reparent 给谁（必填若有下属）。 */
  readonly reparentReportsTo?: string;
  /** 有在手任务时，把任务 reassign 给谁（必填若有在手任务）。 */
  readonly reassignTasksTo?: string;
}

export interface AbsorbInput {
  /** 吸收方（大组织）。 */
  readonly targetOrgId: string;
  /** 被吸收方（小组织）。 */
  readonly sourceOrgId: string;
  /** 源组织的根接到目标组织的哪个 worker 下（挂载点，属目标组织且 active）。 */
  readonly mountUnderWorkerId: string;
}

export interface AbsorbResult {
  readonly movedWorkers: number;
  /** roleCode 冲突重命名记录（审计）。 */
  readonly renamedRoles: ReadonlyArray<{ from: string; to: string }>;
  readonly sourceRootWorkerId: string;
}

export class OrgRestructureService {
  constructor(
    private readonly store: OrgWorkforceStore,
    private readonly now: () => number,
  ) {}

  /** 改某 worker 的直接上级。守：新上级存在+active、非自挂、不成环（新上级不在 worker 子树）。 */
  reparent(input: ReparentInput): void {
    const { orgId, workerId, newManagerWorkerId } = input;
    if (workerId === newManagerWorkerId) throw new InvalidOrgChartError('不能把自己挂到自己下');
    if (!this.store.getWorker(orgId, workerId)) throw new InvalidOrgChartError(`worker 不存在：${workerId}`);
    const mgr = this.store.getWorker(orgId, newManagerWorkerId);
    if (!mgr) throw new InvalidOrgChartError(`新上级不存在：${newManagerWorkerId}`);
    if (mgr.employmentStatus !== 'active') throw new InvalidOrgChartError(`新上级非 active：${newManagerWorkerId}`);
    /* 不成环：新上级不能在 worker 的子树里（否则 worker 反成新上级的上级 → 环）。 */
    if (this.isInSubtree(orgId, workerId, newManagerWorkerId)) {
      throw new InvalidOrgChartError(`reparent 会成环：${newManagerWorkerId} 在 ${workerId} 的子树内`);
    }
    if (!this.store.reparentWorker(orgId, workerId, newManagerWorkerId, this.now())) {
      throw new InvalidOrgChartError(`worker ${workerId} 无汇报边（根 worker 不可 reparent，或数据异常）`);
    }
  }

  /**
   * 裁撤/下线一名 worker（软删 offboarded）。守 + 安置（原子）：
   *   - 非根（根裁撤会让组织无根，拒）。
   *   - 有直接下属 → 须 reparentReportsTo（把下属全 reparent 给它），否则拒。
   *   - 有在手任务 → 须 reassignTasksTo（把任务全 reassign 给它），否则拒。
   */
  offboard(input: OffboardInput): void {
    const { orgId, workerId } = input;
    const worker = this.store.getWorker(orgId, workerId);
    if (!worker) throw new InvalidOrgChartError(`worker 不存在：${workerId}`);
    /* 非根：根 worker（无上级）裁撤会让组织无根。 */
    if (this.store.getManagerOf(orgId, workerId) === null) {
      throw new InvalidOrgChartError('不能裁撤根 worker（组织会无根）；如要换帅请先 reparent 接班人为根');
    }

    this.store.transaction(() => {
      /* 下属安置：有直接下属须给新上级。 */
      const reports = this.store.listDirectReports(orgId, workerId);
      if (reports.length > 0) {
        if (!input.reparentReportsTo) throw new InvalidOrgChartError(`worker ${workerId} 有 ${reports.length} 名直接下属，须指定 reparentReportsTo 安置`);
        const newMgr = this.store.getWorker(orgId, input.reparentReportsTo);
        if (!newMgr || newMgr.employmentStatus !== 'active') throw new InvalidOrgChartError(`reparentReportsTo 无效或非 active：${input.reparentReportsTo}`);
        /* 把每个下属 reparent 给新上级（复用 reparent 的不成环守卫）。 */
        for (const reportId of reports) {
          this.reparent({ orgId, workerId: reportId, newManagerWorkerId: input.reparentReportsTo });
        }
      }
      /* 在手任务重分配：delegated/in_progress/submitted 须给新 assignee。 */
      const inHand = this.store.listTasksByAssignee(orgId, workerId).filter((t: OrgTask) => IN_HAND_STATUSES.has(t.status));
      if (inHand.length > 0) {
        if (!input.reassignTasksTo) throw new InvalidOrgChartError(`worker ${workerId} 有 ${inHand.length} 个在手任务，须指定 reassignTasksTo 重分配`);
        const newAssignee = this.store.getWorker(orgId, input.reassignTasksTo);
        if (!newAssignee || newAssignee.employmentStatus !== 'active') throw new InvalidOrgChartError(`reassignTasksTo 无效或非 active：${input.reassignTasksTo}`);
        for (const t of inHand) {
          if (!this.store.reassignTaskIfHeldBy(orgId, t.id, workerId, input.reassignTasksTo, this.now())) {
            throw new InvalidOrgChartError(`任务 ${t.id} 重分配失败（已被并发改走），请重试`);
          }
        }
      }
      /* 软删：标 offboarded（保审计，不硬删）。 */
      if (!this.store.setWorkerEmploymentStatus(orgId, workerId, 'offboarded', this.now())) {
        throw new InvalidOrgChartError(`offboard 失败：${workerId}`);
      }
    });
  }

  /**
   * 吸收：源组织 B 并入目标组织 A——B 全部结构 + 派生数据迁入 A（12 张含 org_id 表），B 根接到 A 的挂载点下。
   * 守：两组织存在、挂载点属 A 且 active、B 有根；roleCode 冲突自动加后缀；A 迁移后仍单根。原子（整事务）。
   */
  absorb(input: AbsorbInput): AbsorbResult {
    const { targetOrgId, sourceOrgId, mountUnderWorkerId } = input;
    if (targetOrgId === sourceOrgId) throw new InvalidOrgChartError('不能吸收自己');
    if (this.store.listWorkers(targetOrgId).length === 0) throw new InvalidOrgChartError(`目标组织不存在：${targetOrgId}`);
    if (this.store.listWorkers(sourceOrgId).length === 0) throw new InvalidOrgChartError(`源组织不存在：${sourceOrgId}`);
    const mount = this.store.getWorker(targetOrgId, mountUnderWorkerId);
    if (!mount) throw new InvalidOrgChartError(`挂载点 worker 不在目标组织：${mountUnderWorkerId}`);
    if (mount.employmentStatus !== 'active') throw new InvalidOrgChartError(`挂载点非 active：${mountUnderWorkerId}`);
    /* 源组织的根（无上级的 worker）——迁移后接到挂载点下。 */
    const sourceRoot = this.findRoot(sourceOrgId);
    if (!sourceRoot) throw new InvalidOrgChartError(`源组织无根（结构异常）：${sourceOrgId}`);

    return this.store.transaction(() => {
      /* ① 解 roleCode 冲突：源组织撞目标组织的 roleCode → 加后缀（org_positions 唯一约束 (tenant,org,role_code)）。 */
      const targetRoles = new Set(this.store.listPositions(targetOrgId).map((p) => p.roleCode));
      const renamedRoles: Array<{ from: string; to: string }> = [];
      for (const pos of this.store.listPositions(sourceOrgId)) {
        if (targetRoles.has(pos.roleCode)) {
          const to = `${pos.roleCode}__from_${sourceOrgId}`;
          this.store.renamePositionRoleCode(sourceOrgId, pos.roleCode, to);
          renamedRoles.push({ from: pos.roleCode, to });
        }
      }
      /* ② 迁移 12 张表的 org_id：B → A。 */
      const movedWorkers = this.store.migrateOrgStructure(sourceOrgId, targetOrgId);
      /* ③ B 的根接到 A 的挂载点下（原 manager_worker_id=null → mountUnderWorkerId）。
       *    此时 B 的边已迁到 A（org_id=A），故在 A 上 reparent B 根。A 单根不变（A 原根仍 null，B 根降为子节点）。 */
      this.store.reparentWorker(targetOrgId, sourceRoot, mountUnderWorkerId, this.now());
      return { movedWorkers, renamedRoles, sourceRootWorkerId: sourceRoot };
    });
  }

  /** 某 org 的根 worker id（无上级的 active worker）；无 → null。 */
  private findRoot(orgId: string): string | null {
    for (const w of this.store.listWorkers(orgId)) {
      if (this.store.getManagerOf(orgId, w.id) === null) return w.id;
    }
    return null;
  }

  /** candidate 是否在 root worker 的子树内（含 root 自己）——reparent 不成环守卫。BFS 向下，防环上限。 */
  private isInSubtree(orgId: string, rootWorkerId: string, candidateWorkerId: string): boolean {
    if (rootWorkerId === candidateWorkerId) return true;
    const queue = [rootWorkerId];
    const seen = new Set<string>([rootWorkerId]);
    let guard = 0;
    const max = this.store.listWorkers(orgId).length + 1;
    while (queue.length > 0 && guard++ < max) {
      const cur = queue.shift()!;
      for (const child of this.store.listDirectReports(orgId, cur)) {
        if (child === candidateWorkerId) return true;
        if (!seen.has(child)) { seen.add(child); queue.push(child); }
      }
    }
    return false;
  }
}

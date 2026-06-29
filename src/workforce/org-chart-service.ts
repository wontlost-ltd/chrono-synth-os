/**
 * 组织图 service（digital workforce M1）——建立/校验数字组织结构。
 *
 * 职责：bootstrap 一个组织（建岗位/数字员工/汇报关系），并守两条组织不变量：
 *   ① 组织图无环（reporting_edges 不能成环，否则委派会死循环/无根）。
 *   ② 委派只能向**直接下属**（manager → 直接 report，不能越级/向上/向旁）。
 *
 * 纯确定性，零-LLM。id 默认 randomUUID（唯一性），但因果链结构不依赖 id（依赖岗位/汇报结构）。
 */

import { randomUUID } from 'node:crypto';
import type { OrgWorkforceStore } from '../storage/org-workforce-store.js';
import type { Seniority, ReportingEdgeType } from './types.js';

/** 一个岗位 + 占该岗位的数字员工的规格（bootstrap 输入）。 */
export interface WorkerSpec {
  readonly roleCode: string;
  readonly title: string;
  readonly jobFamily: string;
  readonly seniority: Seniority;
  readonly displayName: string;
  /** 绑定的人格内核 id（由调用方先用 template 实例化好 persona 再传入）。 */
  readonly personaId: string;
  /** 上级的 roleCode；null = 根（无上级，如 CEO）。 */
  readonly managerRoleCode: string | null;
  readonly edgeType?: ReportingEdgeType;
}

/** bootstrap 产出：roleCode → workerId 映射（供后续按角色定位数字员工）。 */
export interface BootstrapResult {
  readonly orgId: string;
  readonly workerIdByRole: ReadonlyMap<string, string>;
}

/** 组织结构非法（环 / 上级不存在 / 多根）。 */
export class InvalidOrgChartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidOrgChartError';
  }
}

export class OrgChartService {
  constructor(
    private readonly store: OrgWorkforceStore,
    private readonly now: () => number,
    private readonly idgen: () => string = randomUUID,
  ) {}

  /**
   * bootstrap 一个组织：建岗位 + 数字员工 + 汇报关系。先在内存校验结构（无环、单根、上级存在），
   * 通过后才落库（避免半成品组织）。
   */
  bootstrap(orgId: string, specs: readonly WorkerSpec[]): BootstrapResult {
    if (specs.length === 0) throw new InvalidOrgChartError('组织至少需要一个数字员工');
    this.validateStructure(specs);

    const ts = this.now();
    const workerIdByRole = new Map<string, string>();
    /* 先建岗位 + 员工，拿到每个 roleCode 的 workerId。 */
    for (const s of specs) {
      const positionId = this.idgen();
      const workerId = this.idgen();
      this.store.insertPosition({ id: positionId, orgId, title: s.title, jobFamily: s.jobFamily, seniority: s.seniority, roleCode: s.roleCode, createdAt: ts });
      this.store.insertWorker({ id: workerId, orgId, personaId: s.personaId, positionId, displayName: s.displayName, employmentStatus: 'active', createdAt: ts, updatedAt: ts });
      workerIdByRole.set(s.roleCode, workerId);
    }
    /* 再建汇报关系（此时所有 workerId 已知）。 */
    for (const s of specs) {
      const reportWorkerId = workerIdByRole.get(s.roleCode)!;
      const managerWorkerId = s.managerRoleCode === null ? null : workerIdByRole.get(s.managerRoleCode)!;
      this.store.insertEdge({ id: this.idgen(), orgId, managerWorkerId, reportWorkerId, edgeType: s.edgeType ?? 'solid', createdAt: ts });
    }
    return { orgId, workerIdByRole };
  }

  /**
   * 读取已存在组织的 roleCode→workerId 映射；组织不存在（无 worker）返回 null。
   * 由 listPositions（含 roleCode）+ listWorkers（含 positionId）join 重建。供幂等 bootstrap 复用。
   */
  getExistingChart(orgId: string): BootstrapResult | null {
    const workers = this.store.listWorkers(orgId);
    if (workers.length === 0) return null;
    const roleByPosition = new Map(this.store.listPositions(orgId).map((p) => [p.id, p.roleCode]));
    const workerIdByRole = new Map<string, string>();
    for (const w of workers) {
      const roleCode = roleByPosition.get(w.positionId);
      if (roleCode !== undefined) workerIdByRole.set(roleCode, w.id);
    }
    return { orgId, workerIdByRole };
  }

  /**
   * 幂等 bootstrap：组织已存在（已有 worker）则返回既有结构、**不重复建**（供 seed 安全重跑）；
   * 否则正常 bootstrap。注意：仅按「组织是否已存在」整体判定，不做 worker 级差量同步（diff 留后续需要时再加）。
   */
  bootstrapIfAbsent(orgId: string, specs: readonly WorkerSpec[]): BootstrapResult {
    const existing = this.getExistingChart(orgId);
    if (existing) return existing;
    return this.bootstrap(orgId, specs);
  }

  /**
   * 增量招一名数字员工到**已存在**组织（self-service hire）：建岗位 + worker + 汇报边到指定上级。
   * 与整组织 bootstrap 区别：新员工必有上级（managerWorkerId 非空，加入已有组织非建根），故天然不破单根；
   * 校验（确定性）：① 组织已存在（有 worker）② 上级 worker 存在于本组织 ③ roleCode 在本组织唯一。
   * 不建根、不成环（新叶子挂在已有节点下，沿现有树上溯不可能回到自己）。返回新 workerId。
   */
  hireWorker(orgId: string, spec: { roleCode: string; title: string; jobFamily: string; seniority: Seniority; displayName: string; personaId: string; managerWorkerId: string; edgeType?: ReportingEdgeType }): string {
    /* ① 组织必须已存在（招人是往已有组织加，不是建组织）。 */
    if (this.store.listWorkers(orgId).length === 0) {
      throw new InvalidOrgChartError(`组织 ${orgId} 不存在（先建组织再招人）`);
    }
    /* ② 上级 worker 必须存在于本组织。 */
    if (!this.store.getWorker(orgId, spec.managerWorkerId)) {
      throw new InvalidOrgChartError(`上级数字员工不存在：${spec.managerWorkerId}`);
    }
    /* ③ roleCode 在本组织唯一（不重复建岗位）。 */
    if (this.store.listPositions(orgId).some((p) => p.roleCode === spec.roleCode)) {
      throw new InvalidOrgChartError(`roleCode 已存在：${spec.roleCode}`);
    }
    const ts = this.now();
    const positionId = this.idgen();
    const workerId = this.idgen();
    this.store.insertPosition({ id: positionId, orgId, title: spec.title, jobFamily: spec.jobFamily, seniority: spec.seniority, roleCode: spec.roleCode, createdAt: ts });
    this.store.insertWorker({ id: workerId, orgId, personaId: spec.personaId, positionId, displayName: spec.displayName, employmentStatus: 'active', createdAt: ts, updatedAt: ts });
    this.store.insertEdge({ id: this.idgen(), orgId, managerWorkerId: spec.managerWorkerId, reportWorkerId: workerId, edgeType: spec.edgeType ?? 'solid', createdAt: ts });
    return workerId;
  }

  /**
   * 校验委派合法：fromWorker 委派给 toWorker，toWorker 必须是 fromWorker 的**直接下属**。
   * 不合法抛错（不能越级/向上/向旁/自委派）。
   */
  assertCanDelegate(orgId: string, fromWorkerId: string, toWorkerId: string): void {
    if (fromWorkerId === toWorkerId) {
      throw new InvalidOrgChartError('不能自委派');
    }
    const directReports = this.store.listDirectReports(orgId, fromWorkerId);
    if (!directReports.includes(toWorkerId)) {
      throw new InvalidOrgChartError(`委派非法：${toWorkerId} 不是 ${fromWorkerId} 的直接下属`);
    }
  }

  /** 内存校验组织结构：上级必须存在、单根、无环。 */
  private validateStructure(specs: readonly WorkerSpec[]): void {
    const roles = new Set(specs.map((s) => s.roleCode));
    if (roles.size !== specs.length) {
      throw new InvalidOrgChartError('roleCode 必须唯一');
    }
    /* 上级必须存在；统计根。 */
    let rootCount = 0;
    for (const s of specs) {
      if (s.managerRoleCode === null) {
        rootCount++;
      } else if (!roles.has(s.managerRoleCode)) {
        throw new InvalidOrgChartError(`上级岗位不存在：${s.managerRoleCode}`);
      }
    }
    if (rootCount === 0) throw new InvalidOrgChartError('组织图必须有一个根（无上级的顶层岗位）');
    if (rootCount > 1) throw new InvalidOrgChartError('组织图只能有一个根');
    /* 无环：沿 managerRoleCode 上溯每个节点到根，遇到重复访问即成环。 */
    const managerOf = new Map(specs.map((s) => [s.roleCode, s.managerRoleCode]));
    for (const s of specs) {
      const seen = new Set<string>();
      let cur: string | null = s.roleCode;
      while (cur !== null) {
        if (seen.has(cur)) throw new InvalidOrgChartError(`组织图成环，涉及岗位：${cur}`);
        seen.add(cur);
        cur = managerOf.get(cur) ?? null;
      }
    }
  }
}

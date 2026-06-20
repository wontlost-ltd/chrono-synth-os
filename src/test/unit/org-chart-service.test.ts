import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase } from '../../storage/database.js';
import { runDslSqliteMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/database.js';
import { OrgWorkforceStore } from '../../storage/org-workforce-store.js';
import { OrgChartService, InvalidOrgChartError, type WorkerSpec } from '../../workforce/org-chart-service.js';

/* 组织图不变量：无环 / 单根 / 上级存在 / 委派只向直接下属。确定性 id（计数器）便于断言。 */
describe('OrgChartService（组织图不变量）', () => {
  let db: IDatabase;
  let store: OrgWorkforceStore;
  let svc: OrgChartService;
  let counter: number;

  beforeEach(() => {
    db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    store = new OrgWorkforceStore(db, 'tenant-a');
    counter = 0;
    /* 确定性 id：id-1, id-2…（让因果链可断言，不依赖 randomUUID）。 */
    svc = new OrgChartService(store, () => 1000, () => `id-${++counter}`);
  });

  /** 一个 3 层小组织：CEO → Manager → IC。 */
  function threeLayerSpecs(): WorkerSpec[] {
    return [
      { roleCode: 'ceo', title: 'CEO', jobFamily: 'executive', seniority: 'exec', displayName: '数字CEO', personaId: 'p-ceo', managerRoleCode: null },
      { roleCode: 'mgr', title: '主管', jobFamily: 'manager', seniority: 'lead', displayName: '数字主管', personaId: 'p-mgr', managerRoleCode: 'ceo' },
      { roleCode: 'ic', title: 'IC', jobFamily: 'ic', seniority: 'ic', displayName: '数字员工', personaId: 'p-ic', managerRoleCode: 'mgr' },
    ];
  }

  it('bootstrap 合法 3 层组织 → 落库岗位/员工/汇报关系', () => {
    const res = svc.bootstrap('org-1', threeLayerSpecs());
    assert.equal(res.workerIdByRole.size, 3);
    assert.equal(store.listPositions('org-1').length, 3);
    assert.equal(store.listWorkers('org-1').length, 3);
    assert.equal(store.listEdges('org-1').length, 3);
    /* CEO 的直接下属是 mgr。 */
    const ceoId = res.workerIdByRole.get('ceo')!;
    const mgrId = res.workerIdByRole.get('mgr')!;
    assert.deepEqual(store.listDirectReports('org-1', ceoId), [mgrId]);
  });

  it('委派只向直接下属：mgr→ic 合法，ceo→ic 非法（越级），ic→mgr 非法（向上）', () => {
    const res = svc.bootstrap('org-1', threeLayerSpecs());
    const ceoId = res.workerIdByRole.get('ceo')!;
    const mgrId = res.workerIdByRole.get('mgr')!;
    const icId = res.workerIdByRole.get('ic')!;
    /* 合法：直接下属。 */
    svc.assertCanDelegate('org-1', mgrId, icId);
    /* 越级（ceo 直接派给 ic）→ 非法。 */
    assert.throws(() => svc.assertCanDelegate('org-1', ceoId, icId), InvalidOrgChartError);
    /* 向上（ic 派给 mgr）→ 非法。 */
    assert.throws(() => svc.assertCanDelegate('org-1', icId, mgrId), InvalidOrgChartError);
    /* 自委派 → 非法。 */
    assert.throws(() => svc.assertCanDelegate('org-1', mgrId, mgrId), InvalidOrgChartError);
  });

  it('拒绝成环的组织图（a→b→a）', () => {
    const cyclic: WorkerSpec[] = [
      { roleCode: 'a', title: 'A', jobFamily: 'm', seniority: 'lead', displayName: 'A', personaId: 'pa', managerRoleCode: 'b' },
      { roleCode: 'b', title: 'B', jobFamily: 'm', seniority: 'lead', displayName: 'B', personaId: 'pb', managerRoleCode: 'a' },
    ];
    assert.throws(() => svc.bootstrap('org-x', cyclic), InvalidOrgChartError);
    /* 校验失败 → 不落任何库（结构先校验后落库）。 */
    assert.equal(store.listWorkers('org-x').length, 0);
  });

  it('拒绝多根 / 无根 / 上级不存在', () => {
    /* 多根：两个 null manager。 */
    const multiRoot: WorkerSpec[] = [
      { roleCode: 'a', title: 'A', jobFamily: 'e', seniority: 'exec', displayName: 'A', personaId: 'pa', managerRoleCode: null },
      { roleCode: 'b', title: 'B', jobFamily: 'e', seniority: 'exec', displayName: 'B', personaId: 'pb', managerRoleCode: null },
    ];
    assert.throws(() => svc.bootstrap('o', multiRoot), /只能有一个根/);
    /* 上级不存在。 */
    const missingMgr: WorkerSpec[] = [
      { roleCode: 'a', title: 'A', jobFamily: 'e', seniority: 'exec', displayName: 'A', personaId: 'pa', managerRoleCode: null },
      { roleCode: 'b', title: 'B', jobFamily: 'i', seniority: 'ic', displayName: 'B', personaId: 'pb', managerRoleCode: 'ghost' },
    ];
    assert.throws(() => svc.bootstrap('o2', missingMgr), /上级岗位不存在/);
  });

  it('租户隔离：A 的组织 B 看不到', () => {
    svc.bootstrap('org-1', threeLayerSpecs());
    const storeB = new OrgWorkforceStore(db, 'tenant-b');
    assert.equal(storeB.listWorkers('org-1').length, 0);
  });
});

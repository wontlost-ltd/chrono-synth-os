/**
 * P1-M / SOC2 CC6.1 — SCIM provisioning must emit compliance evidence.
 *
 * 校验：
 *   - createUser 成功 → 写 scim_user_provisioned 行；
 *   - deleteUser 成功 → 写 scim_user_deprovisioned 行；
 *   - evidenceRecorder 抛错时不会阻塞 SCIM 主流程（best-effort）；
 *   - 不传 evidenceRecorder 时主流程仍正常工作（向后兼容）。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ScimProvisioningService } from '../../enterprise/scim-provisioning-service.js';
import { listEvidenceByControl, recordEvidence } from '../../compliance/evidence-store.js';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';

const TENANT = 'tenant-scim-cc61';

describe('P1-M — SCIM provisioning SOC2 CC6.1 evidence', () => {
  it('emits scim_user_provisioned evidence on createUser', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);

    const scim = new ScimProvisioningService(db, ({ tenantId, evidenceType, payload }) => {
      recordEvidence(db, {
        tenantId,
        controlId: 'CC6.1',
        evidenceType,
        payload,
        metadata: { collector_id: 'scim-provisioning-service' },
      });
    });

    const result = scim.createUser(TENANT, { email: 'alice@example.com', displayName: 'Alice' });
    assert.ok(result.user.id);

    const evidence = listEvidenceByControl(db, TENANT, 'CC6.1');
    const provisioned = evidence.filter(e => e.evidenceType === 'scim_user_provisioned');
    assert.equal(provisioned.length, 1);
    const payload = provisioned[0]?.payload as { email: string; isNew: boolean };
    assert.equal(payload.email, 'alice@example.com');
    assert.equal(payload.isNew, true);
  });

  it('emits scim_user_deprovisioned evidence on deleteUser', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);

    const scim = new ScimProvisioningService(db, ({ tenantId, evidenceType, payload }) => {
      recordEvidence(db, {
        tenantId,
        controlId: 'CC6.1',
        evidenceType,
        payload,
        metadata: { collector_id: 'scim-provisioning-service' },
      });
    });

    const { user } = scim.createUser(TENANT, { email: 'bob@example.com', displayName: 'Bob' });
    const deleted = scim.deleteUser(TENANT, user.id);
    assert.equal(deleted, true);

    const evidence = listEvidenceByControl(db, TENANT, 'CC6.1');
    const deprovisioned = evidence.filter(e => e.evidenceType === 'scim_user_deprovisioned');
    assert.equal(deprovisioned.length, 1);
    const payload = deprovisioned[0]?.payload as { userId: string };
    assert.equal(payload.userId, user.id);
  });

  it('does not block SCIM operations when evidence recorder throws', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);

    const scim = new ScimProvisioningService(db, () => {
      throw new Error('simulated evidence-store outage');
    });

    /* 仍应成功完成，主流程不能因证据通道故障而失败 */
    const result = scim.createUser(TENANT, { email: 'carol@example.com', displayName: 'Carol' });
    assert.ok(result.user.id);
  });

  it('invokes evidenceFailureSink with structured payload when recorder throws', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);

    const failures: Array<{ tenantId: string; evidenceType: string; error: string }> = [];
    const scim = new ScimProvisioningService(
      db,
      () => { throw new Error('outage'); },
      ({ tenantId, evidenceType, error }) => {
        failures.push({ tenantId, evidenceType, error: error.message });
      },
    );

    scim.createUser(TENANT, { email: 'edd@example.com', displayName: 'Edd' });

    assert.equal(failures.length, 1);
    assert.equal(failures[0]?.tenantId, TENANT);
    assert.equal(failures[0]?.evidenceType, 'scim_user_provisioned');
    assert.equal(failures[0]?.error, 'outage');
  });

  it('works without an evidenceRecorder (backward-compatible default)', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    const scim = new ScimProvisioningService(db);

    const result = scim.createUser(TENANT, { email: 'dave@example.com', displayName: 'Dave' });
    assert.ok(result.user.id);
    /* 单元路径未注入 recorder → 不应写入证据；返回正常 */
    const evidence = listEvidenceByControl(db, TENANT, 'CC6.1');
    assert.equal(evidence.filter(e => e.evidenceType === 'scim_user_provisioned').length, 0);
  });
});

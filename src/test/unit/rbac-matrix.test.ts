/**
 * P1-W-rbac — declarative RBAC matrix tests.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  hasPermission, assertPermitted, actionsForRole, matrixTable, RbacDeniedError,
} from '../../authz/rbac-matrix.js';

describe('RBAC matrix — admin', () => {
  it('admin can rotate JWT keys', () => {
    assert.equal(hasPermission('admin', 'auth.keys.rotate'), true);
  });
  it('admin can deny jtis', () => {
    assert.equal(hasPermission('admin', 'auth.keys.deny-jti'), true);
  });
  it('admin can place / release legal holds', () => {
    assert.equal(hasPermission('admin', 'legal-hold.place'), true);
    assert.equal(hasPermission('admin', 'legal-hold.release'), true);
  });
});

describe('RBAC matrix — member', () => {
  it('member can NOT rotate JWT keys', () => {
    assert.equal(hasPermission('member', 'auth.keys.rotate'), false);
  });
  it('member CAN read + create memories', () => {
    assert.equal(hasPermission('member', 'memory.read'), true);
    assert.equal(hasPermission('member', 'memory.create'), true);
  });
  it('member cannot delete personas', () => {
    assert.equal(hasPermission('member', 'persona.delete'), false);
  });
});

describe('RBAC matrix — viewer', () => {
  it('viewer is read-only across data plane', () => {
    assert.equal(hasPermission('viewer', 'persona.read'), true);
    assert.equal(hasPermission('viewer', 'persona.create'), false);
    assert.equal(hasPermission('viewer', 'memory.create'), false);
  });
  it('viewer can read compliance evidence (auditor role)', () => {
    assert.equal(hasPermission('viewer', 'compliance.evidence.read'), true);
  });
});

describe('RBAC matrix — service', () => {
  it('service role is locked to data reads + worker verbs', () => {
    assert.equal(hasPermission('service', 'memory.read'), true);
    assert.equal(hasPermission('service', 'worker.run'), true);
    assert.equal(hasPermission('service', 'worker.replay'), true);
  });
  it('service role CANNOT touch admin verbs', () => {
    assert.equal(hasPermission('service', 'auth.keys.rotate'), false);
    assert.equal(hasPermission('service', 'user.impersonate'), false);
    assert.equal(hasPermission('service', 'legal-hold.place'), false);
  });
});

describe('assertPermitted', () => {
  it('returns silently when permitted', () => {
    assert.doesNotThrow(() => assertPermitted('admin', 'auth.keys.rotate'));
  });
  it('throws RbacDeniedError carrying role + action', () => {
    try {
      assertPermitted('viewer', 'persona.delete');
      assert.fail('expected throw');
    } catch (err) {
      assert.ok(err instanceof RbacDeniedError);
      assert.equal(err.code, 'RBAC_DENIED');
      assert.equal(err.role, 'viewer');
      assert.equal(err.action, 'persona.delete');
    }
  });
});

describe('actionsForRole + matrixTable (auditor surface)', () => {
  it('actionsForRole returns sorted list', () => {
    const list = actionsForRole('viewer');
    const sorted = [...list].sort();
    assert.deepEqual(list, sorted);
  });

  it('matrixTable returns one row per distinct action with all four columns', () => {
    const table = matrixTable();
    assert.ok(table.length > 0);
    for (const row of table) {
      assert.equal(typeof row.action, 'string');
      assert.equal(typeof row.admin, 'boolean');
      assert.equal(typeof row.member, 'boolean');
      assert.equal(typeof row.viewer, 'boolean');
      assert.equal(typeof row.service, 'boolean');
    }
    /* Sanity: admin has at least as many true rows as any other role. */
    const counts = table.reduce(
      (acc, r) => ({
        admin: acc.admin + (r.admin ? 1 : 0),
        member: acc.member + (r.member ? 1 : 0),
        viewer: acc.viewer + (r.viewer ? 1 : 0),
        service: acc.service + (r.service ? 1 : 0),
      }),
      { admin: 0, member: 0, viewer: 0, service: 0 },
    );
    assert.ok(counts.admin >= counts.member);
    assert.ok(counts.member >= counts.viewer);
    assert.ok(counts.admin >= counts.service);
  });

  it('every action appears in at least one role (no orphan actions)', () => {
    const table = matrixTable();
    for (const row of table) {
      assert.ok(
        row.admin || row.member || row.viewer || row.service,
        `action ${row.action} has no role assigned — likely a typo in MATRIX`,
      );
    }
  });
});

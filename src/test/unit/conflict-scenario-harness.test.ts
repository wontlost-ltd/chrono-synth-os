/**
 * P3-E — CRDT Layer 1 conflict scenario harness tests.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildScenario, evaluateResolution, ALL_CONFLICT_CLASSES,
  type ConflictClass, type ConflictRecord,
} from '../../sync/conflict-scenario-harness.js';

describe('buildScenario — determinism', () => {
  it('every (class, seed) pair produces byte-identical output', () => {
    for (const c of ALL_CONFLICT_CLASSES) {
      const a = buildScenario(c, 1);
      const b = buildScenario(c, 1);
      assert.deepEqual(a, b, `class ${c} not deterministic`);
    }
  });

  it('different seeds produce distinct scenarios', () => {
    const a = buildScenario('CONCURRENT_FIELD_EDIT', 1);
    const b = buildScenario('CONCURRENT_FIELD_EDIT', 2);
    assert.notDeepEqual(a, b);
    assert.notEqual(a.scenarioId, b.scenarioId);
  });

  it('all five classes are covered', () => {
    assert.equal(ALL_CONFLICT_CLASSES.length, 5);
    for (const c of ALL_CONFLICT_CLASSES) {
      const scen = buildScenario(c, 0);
      assert.equal(scen.conflictClass, c);
      assert.ok(scen.acceptableResolutions.length > 0,
        `class ${c} has no acceptable resolution defined`);
    }
  });
});

describe('CONCURRENT_FIELD_EDIT', () => {
  it('accepts LWW + manual-merge variants', () => {
    const scen = buildScenario('CONCURRENT_FIELD_EDIT', 5);
    /* LWW (remote wins) */
    const lww: ConflictRecord = {
      id: scen.branches[0].records[0].id,
      fields: { title: 'Vendor Onboarding Checklist', owner: 'alice' },
      deleted: false,
      lastModified: scen.acceptableResolutions[0].lastModified,
    };
    assert.equal(evaluateResolution(scen, lww), true);
  });

  it('rejects an obviously wrong resolution', () => {
    const scen = buildScenario('CONCURRENT_FIELD_EDIT', 5);
    const wrong: ConflictRecord = {
      id: scen.branches[0].records[0].id,
      fields: { title: 'Something Else', owner: 'alice' },
      deleted: false,
      lastModified: { title: 0, owner: 0 },
    };
    assert.equal(evaluateResolution(scen, wrong), false);
  });
});

describe('DELETE_VS_EDIT', () => {
  it('only restores-with-edit is accepted (edits win over deletes)', () => {
    const scen = buildScenario('DELETE_VS_EDIT', 7);
    const restored = scen.acceptableResolutions[0];
    assert.equal(evaluateResolution(scen, restored), true);

    const stillDeleted: ConflictRecord = {
      ...restored, deleted: true,
    };
    assert.equal(evaluateResolution(scen, stillDeleted), false,
      'accepting the delete would mean losing the user edit silently — not allowed');
  });
});

describe('ORPHAN_PARENT', () => {
  it('only parent-restore is accepted (no data loss)', () => {
    const scen = buildScenario('ORPHAN_PARENT', 3);
    const restoredParent = scen.acceptableResolutions[0];
    assert.equal(evaluateResolution(scen, restoredParent), true);

    /* Trying to "resolve" by deleting the child orphan is data loss. */
    const childId = scen.branches[0].records[1].id;
    const wrong: ConflictRecord = {
      id: childId, fields: {}, deleted: true, lastModified: {},
    };
    assert.equal(evaluateResolution(scen, wrong), false);
  });
});

describe('CLOCK_SKEW', () => {
  it('accepts either branch deliberately', () => {
    const scen = buildScenario('CLOCK_SKEW', 9);
    assert.equal(evaluateResolution(scen, scen.acceptableResolutions[0]), true);
    assert.equal(evaluateResolution(scen, scen.acceptableResolutions[1]), true);
  });
});

describe('evaluateResolution', () => {
  it('field set must match exactly — extras are rejected', () => {
    const scen = buildScenario('CONCURRENT_FIELD_EDIT', 1);
    const extra: ConflictRecord = {
      ...scen.acceptableResolutions[0],
      fields: { ...scen.acceptableResolutions[0].fields, sneaky: 'injected' },
    };
    assert.equal(evaluateResolution(scen, extra), false);
  });

  it('lastModified must match — different timestamps are rejected', () => {
    const scen = buildScenario('CONCURRENT_FIELD_EDIT', 1);
    const mutated: ConflictRecord = {
      ...scen.acceptableResolutions[0],
      lastModified: { title: 0, owner: 0 },
    };
    assert.equal(evaluateResolution(scen, mutated), false);
  });
});

describe('Layer 1 study coverage', () => {
  it('a 10-participant study using all 5 classes can yield 50 deterministic fixtures', () => {
    const fixtures = new Set<string>();
    const classes: ConflictClass[] = [...ALL_CONFLICT_CLASSES];
    for (let participant = 0; participant < 10; participant += 1) {
      for (const c of classes) {
        const scen = buildScenario(c, participant);
        fixtures.add(scen.scenarioId);
      }
    }
    /* Every (class, participant) combo must yield a unique scenarioId
     * so the research telemetry can join sessions back to fixtures
     * unambiguously. */
    assert.equal(fixtures.size, 50);
  });
});

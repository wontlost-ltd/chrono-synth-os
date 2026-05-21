/**
 * CRDT conflict scenario harness — Layer 1 within-subjects validation.
 *
 * Plan: poc-to-enterprise-ga-2026-v7.3.md §5.3 P3-E (Layer 1)
 *
 * What this exists for:
 *   Layer 1 acceptance for the CRDT conflict-resolution UI is "5
 *   within-subjects scenario classes, 10 participants, 10/10 pass +
 *   P90 ≤2min + SEQ ≥5/7". Each class is a reproducible conflict
 *   pattern the participant must resolve in the UI. This module is
 *   the fixture builder — it produces deterministic snapshot pairs
 *   the test harness (and the participant) consume.
 *
 *   The harness does NOT host the UI itself; that lives in the
 *   desktop / web client. It exposes:
 *     - The 5 scenario classes as enum + factory
 *     - A deterministic builder that returns { localBranch, remoteBranch,
 *       expectedClass } so the same study can be reproduced byte-for-byte
 *     - An evaluator that takes the participant's chosen resolution and
 *       returns whether it matched the canonical "correct" outcome for
 *       that class (some classes have multiple acceptable answers)
 *
 *   v1 keeps the data model small: a record with `id` + `field` map +
 *   `lastModified`. CRDT semantics on richer types (rich text, lists)
 *   are Layer 2+ scope.
 */

export type ConflictClass =
  | 'CONCURRENT_FIELD_EDIT'        /* two replicas changed the same field */
  | 'DELETE_VS_EDIT'               /* one replica deleted, the other edited */
  | 'CONCURRENT_DELETE'            /* both replicas deleted with different timestamps */
  | 'ORPHAN_PARENT'                /* replica A added a child; replica B deleted the parent */
  | 'CLOCK_SKEW'                   /* identical edits but with wildly different wall-clock times */
;

export interface ConflictRecord {
  id: string;
  fields: Record<string, string | null>;
  /** Tombstone — replicas that deleted the record set this. */
  deleted: boolean;
  /** Per-field last-modified map (ms). */
  lastModified: Record<string, number>;
}

export interface ConflictBranch {
  /** Stable name (`local` / `remote-alice` / etc.) for the participant UI. */
  name: string;
  records: ConflictRecord[];
}

export interface ConflictScenario {
  conflictClass: ConflictClass;
  /** Stable test fixture id; same seed yields same scenario across runs. */
  scenarioId: string;
  description: string;
  branches: [ConflictBranch, ConflictBranch];
  /** Set of resolutions the harness will accept as "correct". Each is a
   *  fully-merged record state — the participant's choice is matched
   *  by deep equality against any element. */
  acceptableResolutions: ConflictRecord[];
}

/**
 * Build the canonical scenario for a class with a deterministic seed.
 * Every (class, seed) pair yields byte-identical output so a research
 * run can be reproduced from a CSV of (participantId, scenarios) →
 * exact same fixtures regenerate.
 */
export function buildScenario(conflictClass: ConflictClass, seed: number): ConflictScenario {
  const baseTs = 1_700_000_000_000 + seed * 1000;
  const recordId = `rec-${conflictClass.toLowerCase()}-${seed}`;
  switch (conflictClass) {
    case 'CONCURRENT_FIELD_EDIT': {
      const local: ConflictBranch = {
        name: 'local',
        records: [{
          id: recordId,
          fields: { title: 'Vendor Onboarding Doc — draft', owner: 'alice' },
          deleted: false,
          lastModified: { title: baseTs + 100, owner: baseTs },
        }],
      };
      const remote: ConflictBranch = {
        name: 'remote',
        records: [{
          id: recordId,
          fields: { title: 'Vendor Onboarding Checklist', owner: 'alice' },
          deleted: false,
          lastModified: { title: baseTs + 200, owner: baseTs },
        }],
      };
      /* Two acceptable outcomes: "remote wins" (latest timestamp) OR a
       * deliberate merge ("draft" suffix kept). Some study scripts
       * prefer LWW; others let the participant negotiate. The harness
       * accepts either to avoid penalising correct judgments that
       * happen to disagree with the LWW default. */
      return {
        conflictClass, scenarioId: `cfe-${seed}`,
        description: 'Both replicas edited the title concurrently. Remote was 100ms later.',
        branches: [local, remote],
        acceptableResolutions: [
          {
            id: recordId,
            fields: { title: 'Vendor Onboarding Checklist', owner: 'alice' },
            deleted: false,
            lastModified: { title: baseTs + 200, owner: baseTs },
          },
          {
            id: recordId,
            fields: { title: 'Vendor Onboarding Checklist (draft)', owner: 'alice' },
            deleted: false,
            lastModified: { title: baseTs + 200, owner: baseTs },
          },
        ],
      };
    }
    case 'DELETE_VS_EDIT': {
      const local: ConflictBranch = {
        name: 'local',
        records: [{
          id: recordId,
          fields: { title: 'Vendor X', notes: 'pending review' },
          deleted: false,
          lastModified: { title: baseTs, notes: baseTs + 500 },
        }],
      };
      const remote: ConflictBranch = {
        name: 'remote',
        records: [{
          id: recordId,
          fields: { title: 'Vendor X', notes: null },
          deleted: true,
          lastModified: { title: baseTs, notes: baseTs + 300 },
        }],
      };
      /* The canonical rule: edits win over deletes (deletes are too
       * easy to do by accident). The participant restoring the record
       * with the edit applied is the only fully-correct outcome. */
      return {
        conflictClass, scenarioId: `dve-${seed}`,
        description: 'Remote deleted the vendor record while you were editing notes.',
        branches: [local, remote],
        acceptableResolutions: [{
          id: recordId,
          fields: { title: 'Vendor X', notes: 'pending review' },
          deleted: false,
          lastModified: { title: baseTs, notes: baseTs + 500 },
        }],
      };
    }
    case 'CONCURRENT_DELETE': {
      const local: ConflictBranch = {
        name: 'local',
        records: [{
          id: recordId, fields: {}, deleted: true, lastModified: {},
        }],
      };
      const remote: ConflictBranch = {
        name: 'remote',
        records: [{
          id: recordId, fields: {}, deleted: true, lastModified: {},
        }],
      };
      /* Both replicas agree — outcome is trivial but the harness still
       * shows the conflict UI so participants learn that "agreement
       * conflicts" still appear in the inbox. The only acceptable
       * resolution is "stay deleted". */
      return {
        conflictClass, scenarioId: `cd-${seed}`,
        description: 'Both replicas deleted the same vendor record. Confirm deletion.',
        branches: [local, remote],
        acceptableResolutions: [{
          id: recordId, fields: {}, deleted: true, lastModified: {},
        }],
      };
    }
    case 'ORPHAN_PARENT': {
      const parentId = `parent-${seed}`;
      const childId = `child-${seed}`;
      const local: ConflictBranch = {
        name: 'local',
        records: [
          { id: parentId, fields: { name: 'Folder X' }, deleted: false, lastModified: { name: baseTs } },
          { id: childId, fields: { name: 'Doc Y', parent: parentId }, deleted: false, lastModified: { name: baseTs + 100 } },
        ],
      };
      const remote: ConflictBranch = {
        name: 'remote',
        records: [
          { id: parentId, fields: { name: 'Folder X' }, deleted: true, lastModified: { name: baseTs + 200 } },
        ],
      };
      /* Restore parent + keep child. Deleting the orphan child would
       * be data loss; we restore the parent which the remote intended
       * to delete *before* the child existed. */
      return {
        conflictClass, scenarioId: `op-${seed}`,
        description: 'You added a doc inside a folder. The remote deleted that folder.',
        branches: [local, remote],
        acceptableResolutions: [{
          id: parentId, fields: { name: 'Folder X' },
          deleted: false, lastModified: { name: baseTs },
        }],
      };
    }
    case 'CLOCK_SKEW': {
      /* Same field, same value, but one branch's clock is 365 days
       * ahead. The CRDT must NOT silently let "future" wins — that
       * makes a misconfigured laptop overwrite every legitimate edit. */
      const local: ConflictBranch = {
        name: 'local',
        records: [{
          id: recordId, fields: { title: 'Doc' }, deleted: false,
          lastModified: { title: baseTs },
        }],
      };
      const remote: ConflictBranch = {
        name: 'remote',
        records: [{
          id: recordId, fields: { title: 'Doc' }, deleted: false,
          lastModified: { title: baseTs + 365 * 86_400_000 },
        }],
      };
      /* The harness expects the UI to surface the skew warning and
       * let the participant pick either branch deliberately. Both
       * resolutions are accepted; the load-bearing assertion is that
       * the UI showed a warning at all (tested separately at the
       * component level). */
      return {
        conflictClass, scenarioId: `cs-${seed}`,
        description: 'Two branches edit the same field; the remote claims a timestamp 1 year in the future.',
        branches: [local, remote],
        acceptableResolutions: [
          local.records[0],
          remote.records[0],
        ],
      };
    }
  }
}

/**
 * Check the participant's chosen resolution against the scenario's
 * acceptable answers. Returns `true` when the resolution deep-equals
 * any acceptable record array element.
 */
export function evaluateResolution(scenario: ConflictScenario, resolution: ConflictRecord): boolean {
  for (const acceptable of scenario.acceptableResolutions) {
    if (deepEqualRecord(acceptable, resolution)) return true;
  }
  return false;
}

function deepEqualRecord(a: ConflictRecord, b: ConflictRecord): boolean {
  if (a.id !== b.id || a.deleted !== b.deleted) return false;
  const aKeys = Object.keys(a.fields).sort();
  const bKeys = Object.keys(b.fields).sort();
  if (aKeys.length !== bKeys.length) return false;
  for (let i = 0; i < aKeys.length; i += 1) {
    if (aKeys[i] !== bKeys[i]) return false;
    if (a.fields[aKeys[i]!] !== b.fields[bKeys[i]!]) return false;
  }
  const aLm = Object.keys(a.lastModified).sort();
  const bLm = Object.keys(b.lastModified).sort();
  if (aLm.length !== bLm.length) return false;
  for (let i = 0; i < aLm.length; i += 1) {
    if (aLm[i] !== bLm[i]) return false;
    if (a.lastModified[aLm[i]!] !== b.lastModified[bLm[i]!]) return false;
  }
  return true;
}

export const ALL_CONFLICT_CLASSES: readonly ConflictClass[] = [
  'CONCURRENT_FIELD_EDIT',
  'DELETE_VS_EDIT',
  'CONCURRENT_DELETE',
  'ORPHAN_PARENT',
  'CLOCK_SKEW',
];

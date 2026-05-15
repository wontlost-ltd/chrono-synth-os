import type { NormalizedStatement } from './normalize.js';

export interface Diff {
  readonly index: number;
  readonly kind: 'missing-old' | 'missing-new' | 'changed' | 'unnormalizable';
  readonly old?: NormalizedStatement;
  readonly newer?: NormalizedStatement;
  /** Present when kind === 'unnormalizable'; describes why normalize refused. */
  readonly reason?: string;
  /** Which side raised UnnormalizableDiff: the legacy SQL or the freshly rendered DSL output. */
  readonly side?: 'old' | 'new';
}

export function diffStatements(
  oldStmts: readonly NormalizedStatement[],
  newStmts: readonly NormalizedStatement[],
): readonly Diff[] {
  const diffs: Diff[] = [];
  const max = Math.max(oldStmts.length, newStmts.length);
  for (let index = 0; index < max; index += 1) {
    const old = oldStmts[index];
    const newer = newStmts[index];
    if (!old && newer) diffs.push({ index, kind: 'missing-old', newer });
    else if (old && !newer) diffs.push({ index, kind: 'missing-new', old });
    else if (old && newer && old.canonical !== newer.canonical) {
      diffs.push({ index, kind: 'changed', old, newer });
    }
  }
  return diffs;
}

import type { Dialect } from '../../src/parity/parse.js';
import type { Diff } from '../../src/parity/diff.js';
import type { Migration } from '../../src/types.js';
import { diffStatements } from '../../src/parity/diff.js';
import { UnnormalizableDiff, normalizeAst } from '../../src/parity/normalize.js';
import { parseSql, type ParseResult } from '../../src/parity/parse.js';

export interface ParityCheckOptions {
  readonly oldSql: readonly string[];
  readonly newSql: readonly string[];
  readonly dialect: Dialect;
  readonly dslMigration: Migration;
}

export interface ParityCheckResult {
  readonly pass: boolean;
  readonly diffs: readonly Diff[];
}

export async function checkParity(options: ParityCheckOptions): Promise<ParityCheckResult> {
  const oldParsed = await parseSql(options.oldSql, options.dialect);
  const newParsed = await parseSql(options.newSql, options.dialect);

  const oldResult = safeNormalize(oldParsed, options.dslMigration, 'old');
  if (oldResult.kind === 'unnormalizable') {
    return { pass: false, diffs: [oldResult.diff] };
  }
  const newResult = safeNormalize(newParsed, options.dslMigration, 'new');
  if (newResult.kind === 'unnormalizable') {
    return { pass: false, diffs: [newResult.diff] };
  }

  const diffs = diffStatements(oldResult.normalized, newResult.normalized);
  return { pass: diffs.length === 0, diffs };
}

type NormalizeOutcome =
  | { kind: 'ok'; normalized: ReturnType<typeof normalizeAst> }
  | { kind: 'unnormalizable'; diff: Diff };

function safeNormalize(parsed: ParseResult, migration: Migration, side: 'old' | 'new'): NormalizeOutcome {
  try {
    return { kind: 'ok', normalized: normalizeAst(parsed, migration) };
  } catch (error) {
    if (error instanceof UnnormalizableDiff) {
      return {
        kind: 'unnormalizable',
        diff: { index: 0, kind: 'unnormalizable', reason: error.message, side },
      };
    }
    throw error;
  }
}

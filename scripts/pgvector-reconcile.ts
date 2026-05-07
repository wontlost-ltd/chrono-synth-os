#!/usr/bin/env node
// pgvector reconciliation tool — covers stage 4 of pgvector-integration-2026.md.
//
// Two operations:
//   --mode=backfill    Scan rows that have embedding_json but a NULL embedding
//                      column, parse the JSON, and write the vector. Idempotent;
//                      safe to run repeatedly during the dual-write window.
//   --mode=verify      Scan rows where both columns are set; for each, compare
//                      JSON.parse(embedding_json) against the vector column.
//                      Reports any drift (count + first 10 ids).
//
// Both modes are read-only on schema; only backfill mutates data.
//
// Usage:
//   PG_URL=postgres://chrono:chrono@127.0.0.1:5433/chrono \
//     node dist/scripts/pgvector-reconcile.js --mode=backfill --batch=200
//   PG_URL=... node dist/scripts/pgvector-reconcile.js --mode=verify
//
// Exits 0 on success. verify exits 1 if any drift is detected (CI-friendly).
import type { IDatabase } from '../src/storage/database.js';

interface RowJsonOnly {
  memory_id: string;
  tenant_id: string;
  embedding_json: string;
  model: string;
  updated_at: number;
}

interface RowBoth {
  memory_id: string;
  embedding_json: string;
  /* The pg driver returns vector(N) as a string '[v1,v2,...]'. */
  embedding_text: string;
}

function parseFlags(): { mode: 'backfill' | 'verify'; batch: number; tolerance: number } {
  const args = process.argv.slice(2);
  let mode: 'backfill' | 'verify' | undefined;
  let batch = 500;
  /* float comparison tolerance — JS Number ↔ pgvector roundtrip can lose 1-2 ULPs. */
  let tolerance = 1e-6;
  for (const arg of args) {
    if (arg === '--mode=backfill') mode = 'backfill';
    else if (arg === '--mode=verify') mode = 'verify';
    else if (arg.startsWith('--batch=')) batch = parseInt(arg.slice(8), 10);
    else if (arg.startsWith('--tolerance=')) tolerance = Number(arg.slice(12));
    else throw new Error(`unknown flag: ${arg}`);
  }
  if (!mode) throw new Error('required: --mode=backfill | --mode=verify');
  if (!Number.isFinite(batch) || batch < 1) throw new Error(`bad --batch=${batch}`);
  return { mode, batch, tolerance };
}

function toPgVector(v: readonly number[]): string {
  return '[' + v.join(',') + ']';
}

function parseVectorText(text: string): number[] {
  /* pgvector emits '[1,2,3]' — strip brackets, split. Empty array '[]' → []. */
  const trimmed = text.trim();
  if (trimmed === '[]') return [];
  if (trimmed[0] !== '[' || trimmed[trimmed.length - 1] !== ']') {
    throw new Error(`unexpected pgvector text format: ${text.slice(0, 40)}`);
  }
  return trimmed.slice(1, -1).split(',').map(Number);
}

function backfill(db: IDatabase, batch: number, embeddingModel: string, embeddingDims: number): { scanned: number; written: number; failed: number } {
  let scanned = 0, written = 0, failed = 0;

  while (true) {
    const rows = db.prepare<RowJsonOnly>(
      `SELECT memory_id, tenant_id, embedding_json, model, updated_at
       FROM memory_embeddings
       WHERE embedding_json IS NOT NULL
         AND embedding IS NULL
       LIMIT ?`,
    ).all(batch);

    if (rows.length === 0) break;

    for (const row of rows) {
      scanned++;
      try {
        const parsed = JSON.parse(row.embedding_json) as number[];
        if (!Array.isArray(parsed) || parsed.length !== embeddingDims) {
          failed++;
          continue;
        }
        db.prepare<void>(
          `UPDATE memory_embeddings
           SET embedding = ?::vector,
               embedding_model = ?,
               embedding_dims = ?
           WHERE memory_id = ?`,
        ).run(toPgVector(parsed), embeddingModel, embeddingDims, row.memory_id);
        written++;
      } catch {
        failed++;
      }
    }
  }
  return { scanned, written, failed };
}

function verify(db: IDatabase, tolerance: number): { checked: number; drift: number; firstDriftIds: string[] } {
  /* The conversion `embedding::text` works on every pg driver version we
   * support and avoids the binary-protocol path that the pg client doesn't
   * speak natively. */
  const rows = db.prepare<RowBoth>(
    `SELECT memory_id, embedding_json, embedding::text AS embedding_text
     FROM memory_embeddings
     WHERE embedding_json IS NOT NULL
       AND embedding IS NOT NULL`,
  ).all();

  let drift = 0;
  const driftIds: string[] = [];

  for (const row of rows) {
    let isDrift = false;
    try {
      const fromJson = JSON.parse(row.embedding_json) as number[];
      const fromVec = parseVectorText(row.embedding_text);

      if (fromJson.length !== fromVec.length) {
        isDrift = true;
      } else {
        for (let i = 0; i < fromJson.length; i++) {
          if (Math.abs(fromJson[i] - fromVec[i]) > tolerance) {
            isDrift = true;
            break;
          }
        }
      }
    } catch {
      /* malformed JSON or vector text counts as drift. */
      isDrift = true;
    }

    if (isDrift) {
      drift++;
      if (driftIds.length < 10) driftIds.push(row.memory_id);
    }
  }

  return { checked: rows.length, drift, firstDriftIds: driftIds };
}

async function main(): Promise<void> {
  const { mode, batch, tolerance } = parseFlags();

  const url = process.env.PG_URL;
  if (!url) {
    console.error('PG_URL env var required');
    process.exit(2);
  }

  const { PostgresDatabase } = await import('../src/storage/postgres-database.js');
  const db = new PostgresDatabase(url, { max: 5, idleTimeoutMs: 10_000 });

  try {
    if (mode === 'backfill') {
      /* These match the production defaults; if your deployment uses different
       * dims/model, set them via env. */
      const model = process.env.EMBEDDING_MODEL ?? 'text-embedding-3-small';
      const dims = parseInt(process.env.EMBEDDING_DIMS ?? '1536', 10);
      const result = backfill(db, batch, model, dims);
      console.log(JSON.stringify({ mode, ...result }, null, 2));
      process.exit(0);
    } else {
      const result = verify(db, tolerance);
      console.log(JSON.stringify({ mode, ...result }, null, 2));
      process.exit(result.drift > 0 ? 1 : 0);
    }
  } finally {
    db.close();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(2);
});

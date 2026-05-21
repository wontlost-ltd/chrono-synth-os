#!/usr/bin/env node
/**
 * Ingest external evidence sources (CloudTrail, GitHub audit log) into
 * compliance_evidence.
 *
 * Plan: poc-to-enterprise-ga-2026-v7.3.md §3.1 P1-F-auto-1
 *
 * Inputs are NDJSON on stdin (one event per line). The caller decides
 * how to fetch — for CloudTrail this is usually `aws cloudtrail
 * lookup-events --max-results ... | jq -c '.Events[]'` or a digest
 * download from S3; for GitHub it's `gh api /orgs/.../audit-log
 * --paginate --jq '.[]'` or an enterprise export.
 *
 * Usage:
 *   PG_URL=postgres://... TENANT_ID=tenant-a SOURCE=cloudtrail \
 *     cat cloudtrail-events.ndjson | node dist/scripts/ingest-soc2-external.js
 *
 *   PG_URL=...  TENANT_ID=tenant-a SOURCE=github \
 *     gh api '/orgs/wontlost-ltd/audit-log?per_page=100' \
 *       --paginate --jq '.[]' \
 *       | node dist/scripts/ingest-soc2-external.js
 *
 * Exit codes:
 *   0  success, all events written
 *   1  some events failed (see stderr)
 *   2  invalid invocation
 */

import { createInterface } from 'node:readline';
import {
  ingestCloudTrailEvents, ingestGitHubAuditEvents,
  parseCloudTrailLine, parseGitHubAuditLine,
  type CloudTrailIamEvent, type GitHubAuditEvent,
} from '../src/compliance/external-evidence-ingest.js';
import type { IDatabase } from '../src/storage/database.js';

async function openDb(): Promise<IDatabase> {
  const pgUrl = process.env.PG_URL;
  if (pgUrl) {
    const { PostgresDatabase } = await import('../src/storage/postgres-database.js');
    return new PostgresDatabase(pgUrl, { max: 5, idleTimeoutMs: 10_000 });
  }
  const sqlitePath = process.env.SQLITE_PATH;
  if (!sqlitePath) {
    console.error('Either PG_URL or SQLITE_PATH must be set');
    process.exit(2);
  }
  const { SqliteDatabase } = await import('../src/storage/database.js');
  return new SqliteDatabase(sqlitePath);
}

async function main(): Promise<void> {
  const tenantId = process.env.TENANT_ID?.trim();
  const source = process.env.SOURCE?.trim();
  if (!tenantId) {
    console.error('TENANT_ID env var required');
    process.exit(2);
  }
  if (source !== 'cloudtrail' && source !== 'github') {
    console.error('SOURCE env var must be "cloudtrail" or "github"');
    process.exit(2);
  }
  const db = await openDb();
  try {
    const cloudtrail: CloudTrailIamEvent[] = [];
    const github: GitHubAuditEvent[] = [];
    let parsed = 0;
    let dropped = 0;
    const rl = createInterface({ input: process.stdin });
    for await (const line of rl) {
      if (source === 'cloudtrail') {
        const event = parseCloudTrailLine(line);
        if (event) { cloudtrail.push(event); parsed += 1; }
        else if (line.trim()) dropped += 1;
      } else {
        const event = parseGitHubAuditLine(line);
        if (event) { github.push(event); parsed += 1; }
        else if (line.trim()) dropped += 1;
      }
    }
    console.error(`parsed=${parsed} dropped=${dropped}`);
    const report = source === 'cloudtrail'
      ? ingestCloudTrailEvents(db, tenantId, cloudtrail)
      : ingestGitHubAuditEvents(db, tenantId, github);
    console.log(JSON.stringify(report));
    process.exit(report.errors.length > 0 ? 1 : 0);
  } finally {
    db.close();
  }
}

main().catch(err => {
  console.error('ingest failed:', err);
  process.exit(2);
});

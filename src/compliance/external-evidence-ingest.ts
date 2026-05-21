/**
 * External-source evidence ingest — CloudTrail + GitHub audit log adapters.
 *
 * Plan: poc-to-enterprise-ga-2026-v7.3.md §3.1 P1-F-auto-1
 *
 * Why not call the AWS / GitHub APIs directly here:
 *  - AWS SDK is ~50 MB of transitive deps that we'd pull just for this one
 *    surface; we'd rather let an ops shell pipe a CloudTrail digest into
 *    a stdin reader.
 *  - GitHub's audit-log endpoint requires an enterprise PAT we don't want
 *    sitting in app config alongside customer secrets.
 *
 * So this module exposes pure adapter functions that map *parsed* event
 * objects → EvidenceStore writes. The ops command (scripts/ingest-soc2-
 * external.ts) handles parsing and credentials.
 *
 * Idempotency: each event carries a stable upstream `eventId`. We embed
 * it into the evidence payload and the SHA-256 fingerprint, so re-ingest
 * of the same window produces identical hashes — duplicate detection at
 * audit time is straightforward.
 */

import type { SyncWriteUnitOfWork } from '@chrono/kernel';
import { recordEvidence } from './evidence-store.js';

/**
 * Subset of a CloudTrail event payload that maps to SOC2-relevant access
 * controls. We intentionally keep fields narrow: less surface = less PII
 * smuggled accidentally into evidence rows.
 */
export interface CloudTrailIamEvent {
  /** CloudTrail-unique event ID (e.g. `EVENT_ID` from the JSON record). */
  eventId: string;
  eventName: string;
  eventTimeIso: string;
  userIdentityType: string;
  userIdentityArn: string | null;
  awsRegion: string;
  sourceIPAddress: string | null;
  /** The principal that initiated the call; never the user's PII. */
  principalId: string | null;
  /** Coarse `errorCode` when the action was denied. */
  errorCode?: string | null;
}

/**
 * GitHub audit-log entry shape. We only ingest events relevant to
 * branch-protection / repo-secret / org-membership controls; the API
 * returns far more.
 */
export interface GitHubAuditEvent {
  /** Stable upstream document id (`_document_id` or fallback to `@timestamp+action`). */
  eventId: string;
  action: string;
  actorId: string | null;
  actorLogin: string | null;
  organizationId: string | null;
  /** Always ms since epoch (caller normalises from upstream `@timestamp`). */
  createdAtMs: number;
  /** Repo / branch / setting affected. */
  repository: string | null;
  branch: string | null;
}

export interface IngestReport {
  source: string;
  inserted: number;
  errors: Array<{ eventId: string; error: string }>;
}

/* Set of IAM event names worth keeping as SOC2 CC6.1 evidence. Other
 * CloudTrail events are noise for this control. */
const CLOUDTRAIL_IAM_EVENTS = new Set([
  'CreateUser', 'DeleteUser',
  'AttachUserPolicy', 'DetachUserPolicy',
  'CreateAccessKey', 'DeleteAccessKey', 'UpdateAccessKey',
  'AssumeRole', 'AssumeRoleWithSAML', 'AssumeRoleWithWebIdentity',
  'ConsoleLogin',
  'CreateLoginProfile', 'DeleteLoginProfile', 'UpdateLoginProfile',
]);

export function ingestCloudTrailEvents(
  tx: SyncWriteUnitOfWork,
  tenantId: string,
  events: readonly CloudTrailIamEvent[],
): IngestReport {
  const report: IngestReport = { source: 'cloudtrail', inserted: 0, errors: [] };
  for (const event of events) {
    if (!CLOUDTRAIL_IAM_EVENTS.has(event.eventName)) continue;
    try {
      recordEvidence(tx, {
        tenantId,
        controlId: 'CC6.1',
        evidenceType: 'cloudtrail_iam_event',
        collector: 'system',
        payload: {
          eventId: event.eventId,
          eventName: event.eventName,
          eventTimeIso: event.eventTimeIso,
          userIdentityType: event.userIdentityType,
          userIdentityArn: event.userIdentityArn,
          awsRegion: event.awsRegion,
          sourceIPAddress: event.sourceIPAddress,
          principalId: event.principalId,
          errorCode: event.errorCode ?? null,
        },
        metadata: { collector_id: 'cloudtrail-iam', upstream_event_id: event.eventId },
        collectedAt: Date.parse(event.eventTimeIso) || Date.now(),
      });
      report.inserted += 1;
    } catch (err) {
      report.errors.push({ eventId: event.eventId, error: (err as Error).message });
    }
  }
  return report;
}

/* GitHub audit actions worth keeping as SOC2 CC8.1 (change management). */
const GITHUB_CHANGE_MGMT_ACTIONS = new Set([
  /* Branch protection mutations */
  'protected_branch.create', 'protected_branch.update', 'protected_branch.destroy',
  'protected_branch.policy_override', 'protected_branch.policy_override_resolved',
  /* Repo secret rotation */
  'secret_scanning_alert.create', 'secret_scanning_alert.resolve',
  'org.set_actions_secret', 'org.remove_actions_secret',
  'repo.actions_secret_created', 'repo.actions_secret_removed',
  /* Org membership changes (CC6.1 boundary) */
  'org.add_member', 'org.remove_member', 'org.update_member',
  /* Workflow / deployment changes */
  'workflows.disable_workflow', 'workflows.enable_workflow',
]);

export function ingestGitHubAuditEvents(
  tx: SyncWriteUnitOfWork,
  tenantId: string,
  events: readonly GitHubAuditEvent[],
): IngestReport {
  const report: IngestReport = { source: 'github-audit', inserted: 0, errors: [] };
  for (const event of events) {
    if (!GITHUB_CHANGE_MGMT_ACTIONS.has(event.action)) continue;
    /* Map the action to the right control. Org-membership changes are
     * CC6.1 (logical access); everything else is CC8.1 (change management). */
    const controlId = event.action.startsWith('org.') ? 'CC6.1' : 'CC8.1';
    try {
      recordEvidence(tx, {
        tenantId,
        controlId,
        evidenceType: 'github_audit_event',
        collector: 'system',
        payload: {
          eventId: event.eventId,
          action: event.action,
          actorId: event.actorId,
          /* actorLogin is end-customer identifier on enterprise plans —
           * keep it in evidence (auditors expect to trace operator
           * actions to humans), but flag the field so a future PII
           * scrubber knows to redact for end-customer-facing exports. */
          actorLogin: event.actorLogin,
          organizationId: event.organizationId,
          repository: event.repository,
          branch: event.branch,
          createdAtMs: event.createdAtMs,
        },
        metadata: {
          collector_id: 'github-audit',
          upstream_event_id: event.eventId,
          pii_fields: ['actorLogin'],
        },
        collectedAt: event.createdAtMs,
      });
      report.inserted += 1;
    } catch (err) {
      report.errors.push({ eventId: event.eventId, error: (err as Error).message });
    }
  }
  return report;
}

/** NDJSON line → CloudTrail event parser. Tolerant of partial fields. */
export function parseCloudTrailLine(line: string): CloudTrailIamEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(trimmed) as Record<string, unknown>; }
  catch { return null; }
  const eventId = String(raw['eventID'] ?? raw['EventId'] ?? '').trim();
  const eventName = String(raw['eventName'] ?? raw['EventName'] ?? '').trim();
  if (!eventId || !eventName) return null;
  const userIdentity = (raw['userIdentity'] as Record<string, unknown> | undefined) ?? {};
  return {
    eventId,
    eventName,
    eventTimeIso: String(raw['eventTime'] ?? raw['EventTime'] ?? new Date().toISOString()),
    userIdentityType: String(userIdentity['type'] ?? 'Unknown'),
    userIdentityArn: (userIdentity['arn'] as string | undefined) ?? null,
    awsRegion: String(raw['awsRegion'] ?? raw['AwsRegion'] ?? 'unknown'),
    sourceIPAddress: (raw['sourceIPAddress'] as string | undefined) ?? null,
    principalId: (userIdentity['principalId'] as string | undefined) ?? null,
    errorCode: (raw['errorCode'] as string | undefined) ?? null,
  };
}

/** NDJSON line → GitHub audit event parser. Tolerant of partial fields. */
export function parseGitHubAuditLine(line: string): GitHubAuditEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(trimmed) as Record<string, unknown>; }
  catch { return null; }
  const action = String(raw['action'] ?? '').trim();
  if (!action) return null;
  const ts = raw['@timestamp'] ?? raw['created_at'];
  let createdAtMs = 0;
  if (typeof ts === 'number') createdAtMs = ts;
  else if (typeof ts === 'string') createdAtMs = Date.parse(ts);
  /* Fall back to current time only as a last resort — preserves
   * ingest progress for malformed sources without dropping the event. */
  if (!Number.isFinite(createdAtMs) || createdAtMs <= 0) createdAtMs = Date.now();
  const eventId = String(raw['_document_id'] ?? `${action}-${createdAtMs}-${raw['actor'] ?? 'na'}`);
  return {
    eventId,
    action,
    actorId: (raw['actor_id'] as string | undefined) ?? null,
    actorLogin: (raw['actor'] as string | undefined) ?? null,
    organizationId: (raw['org_id'] as string | undefined) ?? null,
    createdAtMs,
    repository: (raw['repo'] as string | undefined) ?? null,
    branch: (raw['branch'] as string | undefined) ?? null,
  };
}

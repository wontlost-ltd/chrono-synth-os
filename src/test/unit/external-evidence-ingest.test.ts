/**
 * P1-F-auto-1 — CloudTrail + GitHub audit-log ingest tests.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import {
  ingestCloudTrailEvents, ingestGitHubAuditEvents,
  parseCloudTrailLine, parseGitHubAuditLine,
} from '../../compliance/external-evidence-ingest.js';
import { listEvidenceByControl, countEvidence } from '../../compliance/evidence-store.js';

describe('parseCloudTrailLine', () => {
  it('parses a canonical CloudTrail JSON record', () => {
    const line = JSON.stringify({
      eventID: 'e-1',
      eventName: 'CreateUser',
      eventTime: '2026-05-21T10:00:00Z',
      awsRegion: 'us-east-1',
      sourceIPAddress: '203.0.113.1',
      userIdentity: { type: 'IAMUser', arn: 'arn:aws:iam::123:user/admin', principalId: 'AID123' },
      errorCode: null,
    });
    const event = parseCloudTrailLine(line);
    assert.ok(event);
    assert.equal(event.eventId, 'e-1');
    assert.equal(event.eventName, 'CreateUser');
    assert.equal(event.userIdentityArn, 'arn:aws:iam::123:user/admin');
    assert.equal(event.principalId, 'AID123');
  });

  it('returns null on blank or unparseable lines', () => {
    assert.equal(parseCloudTrailLine(''), null);
    assert.equal(parseCloudTrailLine('   '), null);
    assert.equal(parseCloudTrailLine('{not-json'), null);
  });

  it('returns null when required identifiers missing', () => {
    assert.equal(parseCloudTrailLine(JSON.stringify({ eventID: 'e-1' })), null);
    assert.equal(parseCloudTrailLine(JSON.stringify({ eventName: 'X' })), null);
  });
});

describe('parseGitHubAuditLine', () => {
  it('parses a canonical GitHub audit record with @timestamp', () => {
    const line = JSON.stringify({
      _document_id: 'doc-1',
      action: 'protected_branch.update',
      actor: 'alice',
      actor_id: 'A1',
      org_id: 'org-x',
      '@timestamp': 1716291600000,
      repo: 'wontlost-ltd/chrono-synth-os',
      branch: 'main',
    });
    const event = parseGitHubAuditLine(line);
    assert.ok(event);
    assert.equal(event.eventId, 'doc-1');
    assert.equal(event.action, 'protected_branch.update');
    assert.equal(event.actorLogin, 'alice');
    assert.equal(event.createdAtMs, 1716291600000);
    assert.equal(event.repository, 'wontlost-ltd/chrono-synth-os');
  });

  it('synthesises an eventId when _document_id missing', () => {
    const line = JSON.stringify({
      action: 'org.add_member',
      '@timestamp': 1716291600000,
      actor: 'bob',
    });
    const event = parseGitHubAuditLine(line);
    assert.ok(event);
    assert.match(event.eventId, /^org\.add_member-/);
  });

  it('returns null when action missing', () => {
    assert.equal(parseGitHubAuditLine(JSON.stringify({ actor: 'x' })), null);
  });
});

describe('ingestCloudTrailEvents', () => {
  it('records IAM-relevant events under CC6.1', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    const events = [
      { eventId: 'e-1', eventName: 'CreateUser', eventTimeIso: '2026-05-21T10:00:00Z', userIdentityType: 'IAMUser', userIdentityArn: 'arn:1', awsRegion: 'us-east-1', sourceIPAddress: null, principalId: null },
      { eventId: 'e-2', eventName: 'AssumeRole', eventTimeIso: '2026-05-21T10:01:00Z', userIdentityType: 'AssumedRole', userIdentityArn: 'arn:2', awsRegion: 'us-east-1', sourceIPAddress: null, principalId: null },
    ];
    const report = ingestCloudTrailEvents(db, 'tenant-a', events);
    assert.equal(report.inserted, 2);
    assert.equal(report.errors.length, 0);
    assert.equal(countEvidence(db, 'tenant-a', 'CC6.1'), 2);
  });

  it('skips non-IAM events without erroring', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    const events = [
      { eventId: 'e-1', eventName: 'CreateUser', eventTimeIso: '2026-05-21T10:00:00Z', userIdentityType: 'IAMUser', userIdentityArn: null, awsRegion: 'us-east-1', sourceIPAddress: null, principalId: null },
      { eventId: 'e-2', eventName: 'GetObject', eventTimeIso: '2026-05-21T10:01:00Z', userIdentityType: 'IAMUser', userIdentityArn: null, awsRegion: 'us-east-1', sourceIPAddress: null, principalId: null },
    ];
    const report = ingestCloudTrailEvents(db, 'tenant-a', events);
    assert.equal(report.inserted, 1, 'only CreateUser was IAM-relevant; GetObject filtered out');
  });

  it('stores upstream_event_id in metadata for dedup', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    ingestCloudTrailEvents(db, 'tenant-a', [
      { eventId: 'upstream-42', eventName: 'CreateAccessKey', eventTimeIso: '2026-05-21T10:00:00Z', userIdentityType: 'IAMUser', userIdentityArn: null, awsRegion: 'us-east-1', sourceIPAddress: null, principalId: null },
    ]);
    const rows = listEvidenceByControl(db, 'tenant-a', 'CC6.1');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].metadata?.upstream_event_id, 'upstream-42');
  });
});

describe('ingestGitHubAuditEvents', () => {
  it('routes change-mgmt actions to CC8.1 and org-membership to CC6.1', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    const report = ingestGitHubAuditEvents(db, 'tenant-a', [
      { eventId: 'a', action: 'protected_branch.update', actorId: '1', actorLogin: 'alice', organizationId: 'o', createdAtMs: 1, repository: 'r', branch: 'main' },
      { eventId: 'b', action: 'org.add_member', actorId: '2', actorLogin: 'bob', organizationId: 'o', createdAtMs: 2, repository: null, branch: null },
    ]);
    assert.equal(report.inserted, 2);
    assert.equal(countEvidence(db, 'tenant-a', 'CC8.1'), 1);
    assert.equal(countEvidence(db, 'tenant-a', 'CC6.1'), 1);
  });

  it('drops unrelated actions silently (no error, no row)', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    const report = ingestGitHubAuditEvents(db, 'tenant-a', [
      { eventId: 'a', action: 'team.add_member', actorId: '1', actorLogin: 'alice', organizationId: 'o', createdAtMs: 1, repository: null, branch: null },
      { eventId: 'b', action: 'org.set_actions_secret', actorId: '2', actorLogin: 'bob', organizationId: 'o', createdAtMs: 2, repository: null, branch: null },
    ]);
    assert.equal(report.inserted, 1, 'team.add_member is not in the change-mgmt allowlist; org.set_actions_secret is');
  });

  it('records actorLogin with a pii_fields flag so downstream redactors know', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    ingestGitHubAuditEvents(db, 'tenant-a', [
      { eventId: 'a', action: 'protected_branch.create', actorId: '1', actorLogin: 'alice', organizationId: 'o', createdAtMs: 1, repository: 'r', branch: 'main' },
    ]);
    const rows = listEvidenceByControl(db, 'tenant-a', 'CC8.1');
    const meta = rows[0].metadata as { pii_fields: string[] };
    assert.ok(meta.pii_fields.includes('actorLogin'));
  });
});

describe('idempotency by upstream eventId', () => {
  it('re-ingesting same events produces identical payload_sha256', () => {
    const events = [
      { eventId: 'stable-1', eventName: 'ConsoleLogin', eventTimeIso: '2026-05-21T10:00:00Z', userIdentityType: 'IAMUser', userIdentityArn: 'arn:x', awsRegion: 'us-east-1', sourceIPAddress: null, principalId: null, errorCode: null },
    ];
    const db1 = createMemoryDatabase();
    runDslSqliteMigrations(db1);
    ingestCloudTrailEvents(db1, 'tenant-a', events);
    const hash1 = (listEvidenceByControl(db1, 'tenant-a', 'CC6.1'))[0].payloadSha256;

    const db2 = createMemoryDatabase();
    runDslSqliteMigrations(db2);
    ingestCloudTrailEvents(db2, 'tenant-a', events);
    const hash2 = (listEvidenceByControl(db2, 'tenant-a', 'CC6.1'))[0].payloadSha256;

    assert.equal(hash1, hash2,
      're-ingesting the same upstream event must produce the same SHA-256; otherwise dedup at audit time breaks');
  });
});

/**
 * P1-P — IncidentNotifier tests.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import {
  IncidentNotifier, type NotificationSink, type IncidentEvent,
} from '../../incident/incident-notifier.js';
import { listEvidenceByControl } from '../../compliance/evidence-store.js';

class CapturingSink implements NotificationSink {
  readonly name: string;
  readonly received: IncidentEvent[] = [];
  constructor(name: string, private readonly fail = false) { this.name = name; }
  async send(event: IncidentEvent): Promise<void> {
    if (this.fail) throw new Error(`${this.name} synthetic failure`);
    this.received.push(event);
  }
}

const event: IncidentEvent = {
  tenantId: 't1',
  incidentId: 'inc_1',
  severity: 'critical',
  title: 'Audit chain break detected',
  description: 'verify-audit-chain returned 3 mismatches on tenant t1',
  context: { tenantId: 't1', breakCount: 3 },
};

describe('IncidentNotifier.dispatch', () => {
  it('sends to every sink', async () => {
    const a = new CapturingSink('slack');
    const b = new CapturingSink('email');
    const notifier = new IncidentNotifier([a, b]);
    const db = createMemoryDatabase(); runDslSqliteMigrations(db);

    const report = await notifier.dispatch(db, event);
    assert.equal(a.received.length, 1);
    assert.equal(b.received.length, 1);
    assert.equal(report.sinks.length, 2);
    assert.ok(report.sinks.every(s => s.ok));
  });

  it('isolates sink failures — one bad sink does not block others', async () => {
    const broken = new CapturingSink('slack', true);
    const ok = new CapturingSink('email');
    const notifier = new IncidentNotifier([broken, ok]);
    const db = createMemoryDatabase(); runDslSqliteMigrations(db);

    const report = await notifier.dispatch(db, event);
    assert.equal(report.sinks.length, 2);
    const brokenReport = report.sinks.find(s => s.name === 'slack')!;
    const okReport = report.sinks.find(s => s.name === 'email')!;
    assert.equal(brokenReport.ok, false);
    assert.match(brokenReport.error ?? '', /synthetic failure/);
    assert.equal(okReport.ok, true);
    assert.equal(ok.received.length, 1, 'good sink must still receive event');
  });

  it('writes CC7.4 evidence with per-sink outcome', async () => {
    const a = new CapturingSink('slack');
    const b = new CapturingSink('email', true);
    const notifier = new IncidentNotifier([a, b]);
    const db = createMemoryDatabase(); runDslSqliteMigrations(db);

    await notifier.dispatch(db, event);
    const rows = listEvidenceByControl(db, 't1', 'CC7.4');
    assert.equal(rows.length, 1);
    const payload = rows[0].payload as { incidentId: string; sinks: Array<{ name: string; ok: boolean }> };
    assert.equal(payload.incidentId, 'inc_1');
    assert.equal(payload.sinks.length, 2);
    /* Verify per-sink ok/error captured so the auditor sees which
     * notification channel failed during the incident. */
    const slack = payload.sinks.find(s => s.name === 'slack');
    const email = payload.sinks.find(s => s.name === 'email');
    assert.equal(slack?.ok, true);
    assert.equal(email?.ok, false);
  });

  it('null tx skips evidence write (DB-itself-down case)', async () => {
    const a = new CapturingSink('stdout');
    const notifier = new IncidentNotifier([a]);
    const report = await notifier.dispatch(null, event);
    /* Sink still delivered — that's the load-bearing requirement when
     * the DB is the thing on fire. */
    assert.equal(a.received.length, 1);
    assert.equal(report.sinks[0].ok, true);
  });
});

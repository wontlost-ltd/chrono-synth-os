/**
 * P1-Z-vuln-sla — vuln management SLA tracker tests.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  evaluateFinding, buildSlaReport, DEFAULT_SLAS,
  type VulnFinding, type CveSeverity,
} from '../../security/vuln-sla.js';

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

function finding(overrides: Partial<VulnFinding> = {}): VulnFinding {
  return {
    id: 'CVE-2026-1',
    severity: 'high',
    discoveredAtMs: 0,
    acknowledgedAtMs: null,
    resolvedAtMs: null,
    title: 'test',
    ...overrides,
  };
}

describe('evaluateFinding — status', () => {
  it('fixed → status=fixed regardless of timing', () => {
    const f = finding({ resolvedAtMs: 1_000_000 });
    const e = evaluateFinding(f, DEFAULT_SLAS, 99_999_999_999);
    assert.equal(e.status, 'fixed');
  });

  it('waived (non-expired) → status=waived', () => {
    const f = finding({ waiverExpiresAtMs: 100 });
    const e = evaluateFinding(f, DEFAULT_SLAS, 50);
    assert.equal(e.status, 'waived');
  });

  it('waiver expired → status reverts to normal evaluation', () => {
    const f = finding({ waiverExpiresAtMs: 100, severity: 'critical' });
    /* now = waiver + 10 days; critical fix sla = 7 days → fix-breached */
    const e = evaluateFinding(f, DEFAULT_SLAS, 100 + 10 * MS_PER_DAY);
    assert.equal(e.status, 'fix-breached');
  });

  it('in SLA before ack deadline', () => {
    const f = finding({ severity: 'critical', discoveredAtMs: 0 });
    /* critical ack = 4h; now = 2h */
    const e = evaluateFinding(f, DEFAULT_SLAS, 2 * MS_PER_HOUR);
    assert.equal(e.status, 'in-sla');
    assert.equal(e.ackOverdueMs, 0);
  });

  it('ack-breached when ack deadline passed and no ack recorded', () => {
    const f = finding({ severity: 'high', discoveredAtMs: 0 });
    /* high ack = 24h; now = 25h, fix deadline 30d not yet reached */
    const e = evaluateFinding(f, DEFAULT_SLAS, 25 * MS_PER_HOUR);
    assert.equal(e.status, 'ack-breached');
    assert.equal(e.ackOverdueMs, 1 * MS_PER_HOUR);
  });

  it('NOT ack-breached when acknowledged (even past deadline)', () => {
    const f = finding({ severity: 'high', discoveredAtMs: 0, acknowledgedAtMs: 1 });
    const e = evaluateFinding(f, DEFAULT_SLAS, 25 * MS_PER_HOUR);
    assert.equal(e.status, 'in-sla');
  });

  it('fix-breached when fix deadline passed', () => {
    const f = finding({ severity: 'critical', discoveredAtMs: 0, acknowledgedAtMs: 1 });
    /* critical fix = 7d; now = 8d → 1d overdue */
    const e = evaluateFinding(f, DEFAULT_SLAS, 8 * MS_PER_DAY);
    assert.equal(e.status, 'fix-breached');
    assert.equal(e.fixOverdueMs, 1 * MS_PER_DAY);
  });

  it('fix-breached takes precedence over ack-breached when both', () => {
    /* High severity, 60d old, never acked. Both deadlines blown but the
     * report should surface the more urgent fix breach. */
    const f = finding({ severity: 'high', discoveredAtMs: 0 });
    const e = evaluateFinding(f, DEFAULT_SLAS, 60 * MS_PER_DAY);
    assert.equal(e.status, 'fix-breached');
  });
});

describe('evaluateFinding — deadlines', () => {
  it('emits correct deadlines per severity', () => {
    const sevs: CveSeverity[] = ['critical', 'high', 'medium', 'low'];
    for (const sev of sevs) {
      const e = evaluateFinding(finding({ severity: sev, discoveredAtMs: 0 }), DEFAULT_SLAS, 0);
      const sla = DEFAULT_SLAS[sev];
      assert.equal(e.ackDeadlineMs, sla.ackHours * MS_PER_HOUR);
      assert.equal(e.fixDeadlineMs, sla.fixDays * MS_PER_DAY);
    }
  });
});

describe('buildSlaReport', () => {
  it('rolls per-severity totals', () => {
    const findings: VulnFinding[] = [
      finding({ id: 'a', severity: 'critical', discoveredAtMs: 0, resolvedAtMs: 100 }),       /* fixed */
      finding({ id: 'b', severity: 'high', discoveredAtMs: 0, acknowledgedAtMs: 1 }),         /* in-sla */
      finding({ id: 'c', severity: 'high', discoveredAtMs: 0 }),                              /* ack-breached at 25h */
      finding({ id: 'd', severity: 'critical', discoveredAtMs: 0 }),                          /* fix-breached at 8d */
      finding({ id: 'e', severity: 'low', discoveredAtMs: 0, waiverExpiresAtMs: 99_999_999_999 }),  /* waived */
    ];
    const report = buildSlaReport(findings, DEFAULT_SLAS, 8 * MS_PER_DAY);
    assert.equal(report.total, 5);
    assert.equal(report.bySeverity.critical.fixed, 1);
    assert.equal(report.bySeverity.critical.fixBreached, 1);
    assert.equal(report.bySeverity.high.inSla, 1);
    assert.equal(report.bySeverity.high.ackBreached, 1);
    assert.equal(report.bySeverity.low.waived, 1);
    assert.equal(report.breaches.length, 2,
      'breaches array surfaces both critical fix-breach + high ack-breach');
  });

  it('handles empty inventory', () => {
    const r = buildSlaReport([]);
    assert.equal(r.total, 0);
    assert.equal(r.breaches.length, 0);
    assert.equal(r.bySeverity.critical.total, 0);
  });
});

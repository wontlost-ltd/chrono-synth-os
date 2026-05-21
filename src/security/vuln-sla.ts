/**
 * Vulnerability management SLA tracker.
 *
 * Plan: poc-to-enterprise-ga-2026-v7.3.md §4.1 P1-Z-vuln-sla
 *
 * What this is:
 *   - Pure functions to evaluate whether an open CVE finding has
 *     breached its severity-based SLA (ack deadline + fix deadline).
 *   - A report builder that turns a list of findings into a per-severity
 *     summary: in-SLA / breached / fixed.
 *
 * What it's NOT:
 *   - Not a finding store. Callers persist findings wherever it makes
 *     sense (compliance_evidence on CC7.3 is one viable home; a
 *     dedicated `vuln_findings` table is another). v1 keeps the
 *     persistence decision out of scope.
 *   - Not a scanner. Upstream CodeQL / trivy / `npm audit --json` emit
 *     findings; this module evaluates them.
 *
 * SLA defaults derive from common procurement contracts (Mendable /
 * Stripe / etc.):
 *   CRITICAL: ack 4h, fix 7d
 *   HIGH:     ack 24h, fix 30d
 *   MEDIUM:   ack 7d,  fix 90d
 *   LOW:      ack 30d, fix 180d
 */

export type CveSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface VulnFinding {
  /** Stable id from the upstream scanner (e.g. CVE-2024-12345 or ghsa-xxx). */
  id: string;
  severity: CveSeverity;
  /** ms epoch when the finding was first detected by us. */
  discoveredAtMs: number;
  /** ms epoch when an operator acknowledged the finding; null while unack'd. */
  acknowledgedAtMs: number | null;
  /** ms epoch when the fix landed (PR merged + deploy); null if open. */
  resolvedAtMs: number | null;
  /** Short title for dashboards. */
  title: string;
  /** Optional waiver — when set, marks the finding as risk-accepted with
   * an expiry. Waivers > 90d auto-expire to keep the inventory current. */
  waiverExpiresAtMs?: number;
}

export interface SlaWindow {
  ackHours: number;
  fixDays: number;
}

export const DEFAULT_SLAS: Readonly<Record<CveSeverity, SlaWindow>> = {
  critical: { ackHours: 4, fixDays: 7 },
  high:     { ackHours: 24, fixDays: 30 },
  medium:   { ackHours: 7 * 24, fixDays: 90 },
  low:      { ackHours: 30 * 24, fixDays: 180 },
};

export type FindingStatus =
  | 'fixed'
  | 'waived'
  | 'in-sla'
  | 'ack-breached'
  | 'fix-breached';

export interface FindingEvaluation {
  finding: VulnFinding;
  status: FindingStatus;
  ackDeadlineMs: number;
  fixDeadlineMs: number;
  /** ms over the deadline; 0 when in SLA. */
  ackOverdueMs: number;
  fixOverdueMs: number;
}

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

/**
 * Classify one finding against an SLA + a clock. Returns deadlines + how
 * far over (or under) the deadlines we are at `nowMs`.
 *
 * Waivers take precedence over deadline math: a non-expired waiver
 * suppresses any breach signal regardless of acknowledge state. Once
 * the waiver expires the finding becomes treatable again — auditors
 * see the timeline reflects both windows.
 */
export function evaluateFinding(
  finding: VulnFinding,
  slas: Readonly<Record<CveSeverity, SlaWindow>> = DEFAULT_SLAS,
  nowMs: number = Date.now(),
): FindingEvaluation {
  const sla = slas[finding.severity];
  const ackDeadlineMs = finding.discoveredAtMs + sla.ackHours * MS_PER_HOUR;
  const fixDeadlineMs = finding.discoveredAtMs + sla.fixDays * MS_PER_DAY;

  if (finding.resolvedAtMs !== null) {
    return {
      finding,
      status: 'fixed',
      ackDeadlineMs,
      fixDeadlineMs,
      ackOverdueMs: 0,
      fixOverdueMs: 0,
    };
  }
  if (finding.waiverExpiresAtMs !== undefined && finding.waiverExpiresAtMs > nowMs) {
    return {
      finding,
      status: 'waived',
      ackDeadlineMs,
      fixDeadlineMs,
      ackOverdueMs: 0,
      fixOverdueMs: 0,
    };
  }

  const ackOverdueMs = finding.acknowledgedAtMs === null && nowMs > ackDeadlineMs
    ? nowMs - ackDeadlineMs
    : 0;
  const fixOverdueMs = nowMs > fixDeadlineMs ? nowMs - fixDeadlineMs : 0;

  if (fixOverdueMs > 0) return { finding, status: 'fix-breached', ackDeadlineMs, fixDeadlineMs, ackOverdueMs, fixOverdueMs };
  if (ackOverdueMs > 0) return { finding, status: 'ack-breached', ackDeadlineMs, fixDeadlineMs, ackOverdueMs, fixOverdueMs };
  return { finding, status: 'in-sla', ackDeadlineMs, fixDeadlineMs, ackOverdueMs: 0, fixOverdueMs: 0 };
}

export interface VulnSlaReport {
  total: number;
  bySeverity: Record<CveSeverity, {
    total: number;
    inSla: number;
    fixed: number;
    waived: number;
    ackBreached: number;
    fixBreached: number;
  }>;
  breaches: FindingEvaluation[];
}

/**
 * Roll a list of findings into a dashboard-friendly report. The dashboard
 * (Grafana / Looker) reads `bySeverity` for the matrix view and `breaches`
 * for the open-issues list.
 */
export function buildSlaReport(
  findings: readonly VulnFinding[],
  slas: Readonly<Record<CveSeverity, SlaWindow>> = DEFAULT_SLAS,
  nowMs: number = Date.now(),
): VulnSlaReport {
  const empty = () => ({ total: 0, inSla: 0, fixed: 0, waived: 0, ackBreached: 0, fixBreached: 0 });
  const bySeverity: VulnSlaReport['bySeverity'] = {
    critical: empty(), high: empty(), medium: empty(), low: empty(),
  };
  const breaches: FindingEvaluation[] = [];
  for (const f of findings) {
    const ev = evaluateFinding(f, slas, nowMs);
    const slot = bySeverity[f.severity];
    slot.total += 1;
    switch (ev.status) {
      case 'fixed': slot.fixed += 1; break;
      case 'waived': slot.waived += 1; break;
      case 'in-sla': slot.inSla += 1; break;
      case 'ack-breached': slot.ackBreached += 1; breaches.push(ev); break;
      case 'fix-breached': slot.fixBreached += 1; breaches.push(ev); break;
    }
  }
  return { total: findings.length, bySeverity, breaches };
}

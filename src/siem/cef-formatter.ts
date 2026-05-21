/**
 * CEF (Common Event Format) formatter for SIEM export.
 *
 * Plan: poc-to-enterprise-ga-2026-v7.3.md §4 P1-Q-3 + §8 #22
 *
 * Reference: HP ArcSight CEF v23. Format is:
 *   CEF:Version|Device Vendor|Device Product|Device Version|Signature ID|Name|Severity|Extension
 *
 * Constraints:
 *   - Pipes in header field values must be escaped as \|
 *   - Backslashes anywhere → \\
 *   - Extension key=value pairs: equals in value escaped as \=
 *   - Newlines in extension value escaped as \n
 *   - The whole record fits one syslog line; downstream SIEM splits on
 *     newlines, so producing one CEF record per audit event is the
 *     load-bearing invariant
 */

const VENDOR = 'ChronoSynth';
const PRODUCT = 'chrono-synth-os';
const CEF_VERSION = '0';
const DEVICE_VERSION = '2.0.0';

export type CefSeverity = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

export interface CefRecord {
  signatureId: string;
  /** Short human-readable name for the event class. */
  name: string;
  severity: CefSeverity;
  /** Extension key/value pairs (will be appended after the header). */
  extension: Record<string, string | number | boolean | null | undefined>;
}

/** Escape header-field chars per CEF spec. */
function escapeHeaderField(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
}

/** Escape extension-value chars per CEF spec. */
function escapeExtensionValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/=/g, '\\=')
    .replace(/\r?\n/g, '\\n');
}

function serialiseExtension(ext: CefRecord['extension']): string {
  /* Sort keys for deterministic output — easier to diff in test snapshots
   * and downstream tooling that wants stable parse order. */
  return Object.keys(ext)
    .sort()
    .filter(k => ext[k] !== null && ext[k] !== undefined)
    .map(k => `${k}=${escapeExtensionValue(String(ext[k]))}`)
    .join(' ');
}

export function formatCef(record: CefRecord): string {
  const header = [
    `CEF:${CEF_VERSION}`,
    escapeHeaderField(VENDOR),
    escapeHeaderField(PRODUCT),
    escapeHeaderField(DEVICE_VERSION),
    escapeHeaderField(record.signatureId),
    escapeHeaderField(record.name),
    String(record.severity),
  ].join('|');
  const ext = serialiseExtension(record.extension);
  return ext ? `${header}|${ext}` : `${header}|`;
}

/** Wrap CEF record in RFC 5424 syslog frame for forwarding. */
export interface SyslogOptions {
  facility: number;     /* 0-23; 16 = local0 */
  hostname: string;
  app: string;
}

export function wrapSyslog(cef: string, opts: SyslogOptions): string {
  const facility = Math.min(23, Math.max(0, opts.facility));
  /* Priority = facility * 8 + severity. We always emit severity 5 (notice)
   * at the syslog layer; the CEF record carries its own per-event
   * severity inside the body. */
  const pri = facility * 8 + 5;
  const ts = new Date().toISOString();
  return `<${pri}>1 ${ts} ${opts.hostname} ${opts.app} - - - ${cef}`;
}

/**
 * Map an audit-log row to a CEF record. Centralised here so the SIEM
 * exporter and any ad-hoc forwarder produce identical wire format.
 */
export interface AuditEventLike {
  id: string;
  tenantId: string;
  eventKind: string;
  actionType: string;
  createdAt: number;
  actorType: string | null;
  actorId: string | null;
  targetType: string | null;
  targetId: string | null;
  method: string;
  path: string;
  statusCode: number;
  recordHash: string | null;
  chainSeq: number | null;
}

export function auditToCef(event: AuditEventLike): CefRecord {
  /* Severity heuristic: 5xx = high (8), 4xx = medium (5), 2xx = info (3). */
  const sev: CefSeverity = event.statusCode >= 500
    ? 8
    : event.statusCode >= 400
      ? 5
      : 3;
  return {
    signatureId: event.actionType,
    name: `${event.eventKind} ${event.method} ${event.path}`,
    severity: sev,
    extension: {
      cs1Label: 'tenant_id', cs1: event.tenantId,
      cs2Label: 'actor', cs2: event.actorId ?? '',
      cs3Label: 'target', cs3: event.targetType ? `${event.targetType}:${event.targetId ?? ''}` : '',
      cs4Label: 'chain', cs4: event.chainSeq === null ? '' : String(event.chainSeq),
      cn1Label: 'status_code', cn1: event.statusCode,
      rt: event.createdAt,
      externalId: event.id,
      cfp1Label: 'record_hash', cfp1: event.recordHash ?? '',
    },
  };
}

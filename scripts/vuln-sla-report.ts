#!/usr/bin/env node
/**
 * Vuln SLA report — feeds `npm audit --json` (or compatible scanner
 * output) through src/security/vuln-sla.ts and prints a dashboard-
 * friendly summary.
 *
 * Plan: poc-to-enterprise-ga-2026-v7.3.md §4.1 P1-Z-vuln-sla
 *
 * Usage (CI):
 *   npm audit --json --omit=dev > audit.json
 *   VULN_DISCOVERED_AT_FILE=.vuln-discovered.json \
 *     node dist/scripts/vuln-sla-report.js audit.json
 *
 * VULN_DISCOVERED_AT_FILE is a JSON map { advisoryId: discoveredAtMs }
 * that this script reads + updates. Without it, each run treats every
 * finding as "discovered now" — which makes ack/fix deadlines reset
 * every CI run. Persist the file in the repo (or a sidecar bucket) so
 * the deadlines actually count forward.
 *
 * Exit codes:
 *   0 — no SLA breaches (some findings may still be open within SLA)
 *   1 — at least one finding is ack- or fix-breached
 *   2 — invalid invocation / parse error
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import {
  buildSlaReport, DEFAULT_SLAS, type CveSeverity, type VulnFinding,
} from '../src/security/vuln-sla.js';

interface NpmAuditAdvisory {
  source?: number;
  name?: string;
  title: string;
  severity: string;
  url?: string;
}

interface NpmAuditOutput {
  /* npm v9+ format. v7/v8 advisories shape differs; this script targets v9+. */
  vulnerabilities: Record<string, {
    name?: string;
    severity: string;
    via?: Array<NpmAuditAdvisory | string>;
  }>;
}

function severityFromNpm(raw: string): CveSeverity {
  /* npm audit emits 'critical' | 'high' | 'moderate' | 'low' | 'info'.
   * We collapse 'moderate'→'medium' and ignore 'info' (treated as 'low'
   * for SLA purposes to keep the dashboard simple). */
  const lower = raw.toLowerCase();
  if (lower === 'critical') return 'critical';
  if (lower === 'high') return 'high';
  if (lower === 'moderate' || lower === 'medium') return 'medium';
  return 'low';
}

function extractAdvisoryId(via: NpmAuditAdvisory | string | undefined, fallbackName: string): string {
  if (!via) return `npm:${fallbackName}`;
  if (typeof via === 'string') return `npm:${via}`;
  if (via.source) return `npm-source:${via.source}`;
  return `npm:${via.name ?? fallbackName}:${via.title.slice(0, 32)}`;
}

function loadDiscoveredAt(path: string | undefined): Map<string, number> {
  if (!path || !existsSync(path)) return new Map();
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, number>;
    return new Map(Object.entries(raw));
  } catch {
    return new Map();
  }
}

function saveDiscoveredAt(path: string, map: Map<string, number>): void {
  const obj: Record<string, number> = {};
  for (const [k, v] of map) obj[k] = v;
  writeFileSync(path, JSON.stringify(obj, null, 2) + '\n', 'utf-8');
}

function main(): void {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error('Usage: vuln-sla-report.js <npm-audit.json>');
    process.exit(2);
  }
  let raw: string;
  try { raw = readFileSync(inputPath, 'utf-8'); }
  catch (err) {
    console.error(`Cannot read ${inputPath}: ${(err as Error).message}`);
    process.exit(2);
  }
  let audit: NpmAuditOutput;
  try { audit = JSON.parse(raw) as NpmAuditOutput; }
  catch {
    console.error(`Invalid JSON: ${inputPath}`);
    process.exit(2);
  }

  const discoveredFile = process.env.VULN_DISCOVERED_AT_FILE;
  const discoveredAt = loadDiscoveredAt(discoveredFile);
  const now = Date.now();

  const findings: VulnFinding[] = [];
  for (const [name, entry] of Object.entries(audit.vulnerabilities ?? {})) {
    if (!Array.isArray(entry.via) || entry.via.length === 0) {
      /* npm sometimes emits transitive-only entries with `via: ['otherPackage']`;
       * still worth tracking as one finding. */
      const id = `npm:${name}`;
      if (!discoveredAt.has(id)) discoveredAt.set(id, now);
      findings.push({
        id, severity: severityFromNpm(entry.severity), title: name,
        discoveredAtMs: discoveredAt.get(id)!,
        acknowledgedAtMs: null, resolvedAtMs: null,
      });
      continue;
    }
    for (const via of entry.via) {
      const id = extractAdvisoryId(via, name);
      if (!discoveredAt.has(id)) discoveredAt.set(id, now);
      const title = typeof via === 'string' ? `${name} via ${via}` : via.title;
      findings.push({
        id, severity: severityFromNpm(entry.severity), title,
        discoveredAtMs: discoveredAt.get(id)!,
        acknowledgedAtMs: null, resolvedAtMs: null,
      });
    }
  }

  if (discoveredFile) saveDiscoveredAt(discoveredFile, discoveredAt);

  const report = buildSlaReport(findings, DEFAULT_SLAS, now);
  console.log(JSON.stringify(report, null, 2));
  if (report.breaches.length > 0) {
    console.error('');
    console.error(`!! ${report.breaches.length} SLA breach(es) — see breaches[] above`);
    process.exit(1);
  }
  console.error('vuln SLA: clean');
  process.exit(0);
}

main();

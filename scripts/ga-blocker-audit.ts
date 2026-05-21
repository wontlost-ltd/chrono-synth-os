#!/usr/bin/env node
/**
 * GA Blocker self-audit.
 *
 * Plan: poc-to-enterprise-ga-2026-v7.3.md §8
 *
 * Walks every blocker #1-28 from §8 and reports whether the OS-side
 * artifact is present. This is a static check — it verifies the
 * surfaces exist, NOT that they passed live acceptance criteria. The
 * acceptance is the customer / SOC2-auditor view; this script is the
 * developer-side "did we ship the code".
 *
 * Each blocker entry has:
 *   id        §8 number ("#1", "#19a", "#26")
 *   category  human-readable bucket
 *   stage     1A / 1B / 2
 *   artifacts list of (kind, path, description)
 *     - kind 'file'    must exist
 *     - kind 'test'    file must exist AND name a test in describe()/it()
 *     - kind 'config'  config schema must declare the listed field
 *     - kind 'external' tracked outside this repo (deploy / customer);
 *                       reported as "external" without pass/fail
 *
 * Exit codes:
 *   0  every internal artifact present
 *   1  one or more internal artifacts missing
 *   2  invocation error
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(process.cwd());

interface ArtifactCheck {
  kind: 'file' | 'test' | 'config' | 'external';
  path: string;
  desc: string;
}

interface Blocker {
  id: string;
  category: string;
  stage: '1A' | '1B' | '2';
  artifacts: ArtifactCheck[];
}

const BLOCKERS: Blocker[] = [
  { id: '#1', category: '合规证据基础 (P1-F-basic)', stage: '1A', artifacts: [
    { kind: 'file', path: 'src/compliance/evidence-store.ts', desc: 'EvidenceStore service' },
    { kind: 'file', path: 'packages/schema-dsl/src/migrations/server-simple/v074.ts', desc: 'compliance_evidence table migration' },
    { kind: 'test', path: 'src/test/unit/evidence-store.test.ts', desc: 'EvidenceStore tests' },
  ]},
  { id: '#2', category: '供应链签名 (P1-D)', stage: '1A', artifacts: [
    { kind: 'file', path: '.github/workflows/release.yml', desc: 'release workflow with cosign+SBOM+SLSA' },
  ]},
  { id: '#2a', category: '安全 CI (P0-A)', stage: '1A', artifacts: [
    { kind: 'file', path: '.github/workflows/security.yml', desc: 'CodeQL + secrets + SBOM + ZAP' },
  ]},
  { id: '#2b', category: 'PG 集成测试默认 (P0-B)', stage: '1A', artifacts: [
    { kind: 'file', path: '.github/workflows/ci.yml', desc: 'PG canonical job' },
  ]},
  { id: '#3', category: '跨租户 blast radius DB (P0-C)', stage: '1A', artifacts: [
    { kind: 'file', path: 'src/test/integration/negative-rls-bypass.test.ts', desc: 'RLS bypass negative tests' },
    { kind: 'file', path: 'src/test/integration/negative-rls-fuzz.test.ts', desc: '10000-iter property fuzz' },
  ]},
  { id: '#4', category: 'JWT key lifecycle (P0-D)', stage: '1A', artifacts: [
    { kind: 'file', path: 'src/server/plugins/jwt-keyring.ts', desc: 'KeyRing 4-state machine' },
    { kind: 'file', path: 'src/server/plugins/jwt-deny-list.ts', desc: 'jti deny-list' },
    { kind: 'test', path: 'src/test/integration/jwt-key-lifecycle.test.ts', desc: 'KeyRing tests' },
  ]},
  { id: '#5', category: 'Audit log immutable (P0-E)', stage: '1A', artifacts: [
    { kind: 'file', path: 'src/audit/audit-hash-chain.ts', desc: 'append-only hash chain' },
    { kind: 'test', path: 'src/test/integration/negative-audit-tamper.test.ts', desc: 'tamper detection tests' },
  ]},
  { id: '#6', category: '可观测性基线 (P1-A+B+C)', stage: '1A', artifacts: [
    { kind: 'file', path: 'src/observability/tracing.ts', desc: 'OTel tracer init' },
    { kind: 'file', path: 'src/logging/pino-logger.ts', desc: 'JSON logger with trace_id mixin' },
    { kind: 'external', path: 'chrono-synth-deploy/k8s/addons/observability-slo/', desc: 'SLO recording rules + alerts (deploy)' },
  ]},
  { id: '#7', category: 'NetworkPolicy + Kyverno (P0-F)', stage: '1A', artifacts: [
    { kind: 'external', path: 'chrono-synth-deploy/k8s/base/network-policy.yaml', desc: 'NetworkPolicy default-deny (deploy)' },
    { kind: 'external', path: 'chrono-synth-deploy/compliance/kyverno/policies/disallow-host-path.yaml', desc: 'Kyverno baseline (deploy)' },
  ]},
  { id: '#8', category: 'Onboarding 基线 (P1-K)', stage: '1A', artifacts: [
    { kind: 'file', path: 'src/onboarding/onboarding-v2-service.ts', desc: 'onboarding service with telemetry' },
    { kind: 'external', path: '.claude/runbooks/p1-k-study1-research-plan.md', desc: 'user study runbook' },
  ]},
  { id: '#9', category: 'a11y basic (P1-AY-basic)', stage: '1A', artifacts: [
    { kind: 'test', path: 'src/test/integration/a11y-headers.test.ts', desc: 'error code contract test' },
  ]},
  { id: '#10', category: '客户支持 SLA basic (P1-L)', stage: '1A', artifacts: [
    { kind: 'file', path: 'src/compliance/evidence-collectors.ts', desc: '3 built-in SOC2 collectors' },
    { kind: 'file', path: 'scripts/collect-soc2-evidence.ts', desc: 'ops command' },
  ]},
  { id: '#11', category: 'i18n basic', stage: '1A', artifacts: [
    { kind: 'file', path: 'src/i18n/locale-resolver.ts', desc: 'Accept-Language parser' },
    { kind: 'file', path: 'src/i18n/message-catalog.ts', desc: 'en+zh-CN catalog' },
  ]},
  { id: '#12', category: 'DR core restore (P1-DR-core)', stage: '1A', artifacts: [
    { kind: 'external', path: 'chrono-synth-deploy/scripts/dr-restore.sh', desc: 'PITR + cross-region restore (deploy)' },
  ]},
  { id: '#13', category: 'DR 六项完整 (P1-I-1..5)', stage: '1B', artifacts: [
    { kind: 'file', path: 'scripts/audit-restore-check.ts', desc: 'audit chain restore (P1-I-5)' },
    { kind: 'external', path: 'chrono-synth-deploy/scripts/', desc: 'PITR / failover / tenant restore / KMS outage (deploy)' },
  ]},
  { id: '#14', category: 'Security GameDay (P1-J)', stage: '1B', artifacts: [
    { kind: 'external', path: '.claude/runbooks/gameday-scenarios.md', desc: '4 scenario runbooks (process)' },
  ]},
  { id: '#15', category: '身份生命周期 (P1-M)', stage: '1B', artifacts: [
    { kind: 'file', path: 'src/identity/break-glass-service.ts', desc: 'break-glass tokens' },
    { kind: 'file', path: 'src/enterprise/scim-provisioning-service.ts', desc: 'SCIM provisioning' },
  ]},
  { id: '#16', category: '数据治理 basic (P1-N)', stage: '1B', artifacts: [
    { kind: 'file', path: 'src/privacy/legal-hold-service.ts', desc: 'legal hold registry' },
    { kind: 'file', path: 'src/privacy/privacy-service.ts', desc: 'tenant deletion / DSAR' },
  ]},
  { id: '#17', category: '变更安全 (P1-O)', stage: '1B', artifacts: [
    { kind: 'file', path: 'src/feature-flags/feature-flag-service.ts', desc: 'flags + kill switch' },
  ]},
  { id: '#18', category: '滥用保护 (P1-O-abuse)', stage: '1B', artifacts: [
    { kind: 'file', path: 'src/server/plugins/backpressure.ts', desc: 'per-tenant concurrency cap' },
    { kind: 'file', path: 'src/server/plugins/rate-limit.ts', desc: 'token-bucket rate limit' },
  ]},
  { id: '#19a', category: '事故响应 (P1-P)', stage: '1B', artifacts: [
    { kind: 'file', path: 'src/incident/incident-notifier.ts', desc: 'incident notifier' },
  ]},
  { id: '#19b', category: '非 DB 租户隔离 (P1-R-tenant-iso)', stage: '1B', artifacts: [
    { kind: 'file', path: 'src/multi-tenant/tenant-key-prefix.ts', desc: 'TenantKeyPrefix helper' },
  ]},
  { id: '#19c', category: '管理后台访问 (P1-S-admin-access)', stage: '1B', artifacts: [
    { kind: 'file', path: 'src/identity/impersonation-audit.ts', desc: 'impersonation audit trail' },
  ]},
  { id: '#19d', category: '边缘 WAF / DDoS (P1-T-edge)', stage: '1B', artifacts: [
    { kind: 'file', path: 'src/server/plugins/helmet.ts', desc: 'OWASP baseline headers' },
  ]},
  { id: '#19e', category: '迁移回滚 (P1-U)', stage: '1B', artifacts: [
    { kind: 'file', path: 'scripts/migration-dry-run.ts', desc: 'migration dry-run + impact preview' },
  ]},
  { id: '#19f', category: '应用 RBAC/ABAC (P1-W-rbac)', stage: '1B', artifacts: [
    { kind: 'file', path: 'src/authz/rbac-matrix.ts', desc: 'declarative RBAC matrix' },
  ]},
  { id: '#19g', category: 'SSRF + egress (P1-X-ssrf)', stage: '1B', artifacts: [
    { kind: 'file', path: 'src/security/ssrf-guard.ts', desc: 'SSRF guard + DNS rebinding' },
  ]},
  { id: '#19h', category: 'API 基线 (P1-Y-api-baseline)', stage: '1B', artifacts: [
    { kind: 'file', path: 'src/server/plugins/csrf.ts', desc: 'CSRF double-submit' },
  ]},
  { id: '#20', category: '数据分类 basic (P1-Q-1)', stage: '2', artifacts: [
    { kind: 'file', path: 'src/data-classification/pii-detector.ts', desc: 'PII detector + tagging' },
  ]},
  { id: '#21', category: 'Secrets 生命周期 (P1-Q-2)', stage: '2', artifacts: [
    { kind: 'file', path: 'src/storage/encryption.ts', desc: 'FieldEncryption' },
    { kind: 'file', path: 'scripts/lint-field-encryption.ts', desc: 'coverage lint' },
  ]},
  { id: '#22', category: 'SIEM basic export (P1-Q-3)', stage: '2', artifacts: [
    { kind: 'file', path: 'src/siem/cef-formatter.ts', desc: 'CEF formatter' },
    { kind: 'file', path: 'src/siem/siem-delivery.ts', desc: 'delivery with DLQ + retry' },
  ]},
  { id: '#23', category: '渗透测试 + 漏洞披露', stage: '2', artifacts: [
    { kind: 'external', path: 'pen-test-vendor', desc: 'vendor SOW (customer task)' },
  ]},
  { id: '#24', category: 'Vuln management SLA (P1-Z)', stage: '2', artifacts: [
    { kind: 'file', path: 'src/security/vuln-sla.ts', desc: 'SLA tracker + report' },
    { kind: 'file', path: 'scripts/vuln-sla-report.ts', desc: 'CI report script' },
  ]},
  { id: '#25', category: 'KMS 多云矩阵', stage: '2', artifacts: [
    { kind: 'file', path: 'src/enterprise/kms-client.ts', desc: 'multi-provider client' },
    { kind: 'file', path: 'src/enterprise/kms-conformance.ts', desc: 'Layer 1 Core conformance' },
    { kind: 'external', path: 'GCP/Azure/OCI/Vault SDK integrations', desc: 'Layer 2/3 (per-provider tests)' },
  ]},
  { id: '#26', category: 'SOC2 Type I 报告', stage: '2', artifacts: [
    { kind: 'external', path: 'SOC2 auditor delivery', desc: 'Type I report PDF (customer + waiting)' },
  ]},
  { id: '#27', category: 'Publishable ACR', stage: '2', artifacts: [
    { kind: 'external', path: 'CMP-3 third-party a11y audit', desc: 'VPAT/EN 301 549 (customer)' },
  ]},
  { id: '#28', category: '43 项采购包', stage: '2', artifacts: [
    { kind: 'external', path: 'CS-2.5 procurement bundle', desc: '43-item commit (customer)' },
  ]},
];

interface AuditResult {
  blocker: Blocker;
  artifacts: Array<{ artifact: ArtifactCheck; ok: boolean | 'external'; detail: string }>;
}

function checkArtifact(a: ArtifactCheck): { ok: boolean | 'external'; detail: string } {
  if (a.kind === 'external') return { ok: 'external', detail: 'tracked outside this repo' };
  const full = resolve(ROOT, a.path);
  if (!existsSync(full)) return { ok: false, detail: `missing: ${a.path}` };
  if (a.kind === 'test') {
    /* Verify the test file has at least one describe()/it() */
    const src = readFileSync(full, 'utf-8');
    if (!/\b(describe|it|test)\s*\(/.test(src)) {
      return { ok: false, detail: `${a.path} present but no describe()/it()` };
    }
  }
  return { ok: true, detail: a.path };
}

function main(): void {
  const results: AuditResult[] = BLOCKERS.map(b => ({
    blocker: b,
    artifacts: b.artifacts.map(a => ({ artifact: a, ...checkArtifact(a) })),
  }));

  /* Per-blocker summary line. */
  for (const r of results) {
    const present = r.artifacts.filter(a => a.ok === true).length;
    const missing = r.artifacts.filter(a => a.ok === false);
    const external = r.artifacts.filter(a => a.ok === 'external').length;
    const status = missing.length === 0 ? '✓' : '✖';
    console.log(JSON.stringify({
      id: r.blocker.id,
      category: r.blocker.category,
      stage: r.blocker.stage,
      status,
      present,
      external,
      missing: missing.length,
      missingDetails: missing.map(a => a.detail),
    }));
  }

  const internalMissing = results.flatMap(r => r.artifacts.filter(a => a.ok === false));
  console.error('');
  if (internalMissing.length === 0) {
    console.error(`✓ All ${BLOCKERS.length} blockers have their OS-side artifacts in place.`);
    console.error('  External artifacts (deploy repo, customer, vendor) tracked separately.');
    process.exit(0);
  }
  console.error(`✖ ${internalMissing.length} internal artifact(s) missing:`);
  for (const m of internalMissing) console.error(`    - ${m.detail}`);
  process.exit(1);
}

main();

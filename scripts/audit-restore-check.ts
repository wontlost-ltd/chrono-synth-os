#!/usr/bin/env node
/**
 * Audit log restore integrity check — P1-I-5.
 *
 * Plan: poc-to-enterprise-ga-2026-v7.3.md §3.4 P1-I-5
 *
 * Purpose: validate the audit_log hash chain end-to-end for one or all
 * tenants. Operationalises P0-E's verifyAuditChain() as the restore-
 * time gate: after PITR + WAL replay, this script tells you whether
 * the restored data is intact and where any breaks are.
 *
 * Output for each tenant:
 *   { tenantId, ok, totalChecked, breakCount, firstBreakAtSeq }
 *
 * Exit codes:
 *   0  every tenant chain verifies clean
 *   1  ≥1 tenant chain has breaks
 *   2  invalid invocation / DB error
 *
 * Usage:
 *   # All tenants
 *   PG_URL=... node dist/scripts/audit-restore-check.js
 *   # Specific tenants
 *   PG_URL=... TENANT_IDS=t1,t2 node dist/scripts/audit-restore-check.js
 */

import { verifyAuditChain } from '../src/audit/audit-log-store.js';
import { verifyAuditAnchors } from '../src/audit/audit-anchor-verifier.js';
import {
  normalizeAnchorTenantId,
  type AuditChainKmsProvider,
} from '../src/audit/audit-chain-anchor-service.js';
import type { IDatabase } from '../src/storage/database.js';

/**
 * 严格 KMS 验签需要运行时注入一个能 verify 的 provider。本脚本通过
 * `KMS_VERIFIER_MODULE` 环境变量动态 import，目标模块需 default export
 * 或命名 export `verifier`，返回一个实现 AuditChainKmsProvider 的对象。
 * 这样部署侧 (chrono-synth-deploy) 可以为每个云接入自定义 verifier，
 * 而 OS 仓库不需要捆绑供应商 SDK。
 */
async function loadKmsVerifier(): Promise<Pick<AuditChainKmsProvider, 'verify'> | undefined> {
  const modulePath = process.env.KMS_VERIFIER_MODULE;
  if (!modulePath) return undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: any = await import(modulePath);
  const candidate = mod.verifier ?? mod.default;
  if (!candidate || typeof candidate.verify !== 'function') {
    throw new Error(`KMS_VERIFIER_MODULE=${modulePath} did not export a verifier with verify()`);
  }
  return candidate as Pick<AuditChainKmsProvider, 'verify'>;
}

async function openDb(): Promise<IDatabase> {
  const pgUrl = process.env.PG_URL;
  if (pgUrl) {
    const { PostgresDatabase } = await import('../src/storage/postgres-database.js');
    return new PostgresDatabase(pgUrl, { max: 2, idleTimeoutMs: 10_000 });
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
  const db = await openDb();
  try {
    let tenantIds: string[];
    const override = process.env.TENANT_IDS?.trim();
    if (override) {
      tenantIds = override.split(',').map(s => s.trim()).filter(Boolean);
    } else {
      /* 取 audit_log ∪ audit_chain_anchors 的 tenant_id 集合，保证
       * "孤儿锚"（audit 已删但锚仍在）也能纳入恢复校验，避免静默漂移。 */
      const auditRows = db.prepare<{ tenant_id: string }>(
        'SELECT DISTINCT tenant_id FROM audit_log WHERE chain_seq IS NOT NULL',
      ).all();
      const anchorRows = db.prepare<{ tenant_id: string }>(
        'SELECT DISTINCT tenant_id FROM audit_chain_anchors',
      ).all();
      tenantIds = Array.from(new Set([
        ...auditRows.map(r => r.tenant_id),
        ...anchorRows.map(r => r.tenant_id),
      ]));
    }

    if (tenantIds.length === 0) {
      console.log('No tenants with chained audit data; nothing to verify.');
      process.exit(0);
    }

    /* 在循环外做一次锚定校验：anchor 表覆盖全部租户，仅扫描一次就够。
     * 之后按 normalize 后的 tenantId 过滤每条 issue 写入对应租户报告
     * （verifier 输出的 issue.tenantId 始终是 normalize 形式，例如 ''
     * 会被替换为 'platform'）。
     *
     * 严格模式（运维侧通过环境变量打开）：
     *   - REQUIRE_ANCHORS=1     → 每个 tenantId 必须至少有一条锚行
     *   - STRICT_KMS_VERIFY=1   → 运行时未注入 KMS verify 视为 error
     *   - KMS_VERIFIER_MODULE   → 严格模式同时需要真正能 verify 的 provider
     * GA 验收时三者都应配齐。 */
    const requireAnchors = process.env.REQUIRE_ANCHORS === '1';
    const requireSignatures = process.env.STRICT_KMS_VERIFY === '1';
    const kmsProvider = await loadKmsVerifier();
    const anchorResult = await verifyAuditAnchors({
      db,
      requireSignatures,
      ...(kmsProvider ? { kmsProvider } : {}),
      ...(requireAnchors ? { requireAnchorsForTenants: tenantIds } : {}),
    });

    let totalBroken = 0;
    for (const tenantId of tenantIds) {
      const result = verifyAuditChain(db, tenantId);
      const firstBreak = result.breaks[0];
      const reportTenantKey = normalizeAnchorTenantId(tenantId);
      const tenantAnchorIssues = anchorResult.issues.filter(issue => issue.tenantId === reportTenantKey);
      const anchorHasError = tenantAnchorIssues.some(issue => issue.severity === 'error');
      const summary = {
        tenantId,
        ok: result.ok && !anchorHasError,
        totalChecked: result.totalChecked,
        breakCount: result.breaks.length,
        firstBreakAtSeq: firstBreak?.chainSeq ?? null,
        firstBreakReason: firstBreak?.reason ?? null,
        anchorsOk: !anchorHasError,
        anchorIssues: tenantAnchorIssues.map(issue => ({
          anchorId: issue.anchorId,
          reason: issue.reason,
          severity: issue.severity,
        })),
      };
      console.log(JSON.stringify(summary));
      if (!result.ok || anchorHasError) totalBroken += 1;
    }

    /* 兜底：把没有被任何 tenant 报告吸收的"孤儿"锚错误单独汇报，
     * 防止 verifier 在 tenantIds 集合之外发现的问题被丢弃。 */
    const reportedTenantKeys = new Set(tenantIds.map(t => normalizeAnchorTenantId(t)));
    const orphanIssues = anchorResult.issues.filter(issue => !reportedTenantKeys.has(issue.tenantId));
    if (orphanIssues.length > 0) {
      console.log(JSON.stringify({
        tenantId: '<orphan>',
        ok: false,
        orphanAnchorIssues: orphanIssues.map(issue => ({
          tenantId: issue.tenantId,
          anchorId: issue.anchorId,
          reason: issue.reason,
          severity: issue.severity,
        })),
      }));
      if (orphanIssues.some(issue => issue.severity === 'error')) totalBroken += 1;
    }

    if (totalBroken > 0) {
      console.error('');
      console.error(`${totalBroken} of ${tenantIds.length} tenant chain(s) broken.`);
      console.error('Next steps:');
      console.error('  1. Identify the most recent intact chain_seq from PITR backups');
      console.error('  2. Restore only the audit_log rows up to that seq');
      console.error('  3. Replay subsequent rows from append-only backup (if any)');
      console.error('  4. Re-run this script to confirm restore was clean');
      process.exit(1);
    }
    console.error(`All ${tenantIds.length} tenant audit chains verified clean.`);
    process.exit(0);
  } finally {
    db.close();
  }
}

main().catch(err => {
  console.error('audit-restore-check failed:', err);
  process.exit(2);
});

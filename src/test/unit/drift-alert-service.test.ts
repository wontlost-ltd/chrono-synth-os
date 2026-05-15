/**
 * 单元测试：DriftAlertService（T0-B 收尾）
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase } from '../../storage/database.js';
import { runDslSqliteMigrations } from '../../storage/index.js';
import { DriftAlertService } from '../../safety/drift-alert-service.js';
import { SilentLogger } from '../../utils/logger.js';
import type { DriftReport } from '../../safety/persona-drift-analyzer.js';

function setup() {
  const db = createMemoryDatabase();
  runDslSqliteMigrations(db);
  return { db };
}

function makeReport(level: 'ok' | 'warning' | 'critical', driftCount = 1): DriftReport {
  return {
    reportId: `drift_${level}_${Math.random().toString(36).slice(2, 8)}`,
    tenantId: 'default',
    baselineSnapshotId: 'snap_baseline',
    analyzedAt: Date.now(),
    overallDriftScore: level === 'critical' ? 0.4 : level === 'warning' ? 0.2 : 0.05,
    alertLevel: level,
    valueDrifts: Array.from({ length: driftCount }, (_, i) => ({
      valueId: `v${i}`,
      label: `value-${i}`,
      baseline: 0.5,
      current: 0.5 + (i * 0.05),
      delta: i * 0.05,
      alertLevel: 'ok' as const,
    })),
  };
}

describe('DriftAlertService', () => {
  it('alertLevel=ok 时不写审计、不发 webhook', async () => {
    const { db } = setup();
    try {
      const service = new DriftAlertService({
        tx: db,
        logger: new SilentLogger(),
        options: { webhookUrl: '', webhookTimeoutMs: 1000, webhookSecret: '' },
      });
      const result = await service.process(makeReport('ok'));
      assert.equal(result.alertEmitted, false);
      assert.equal(result.auditId, null);
      const auditCount = db.prepare<{ count: number }>(
        `SELECT COUNT(*) AS count FROM audit_log WHERE action_type LIKE 'safety.drift.%'`,
      ).get()?.count ?? 0;
      assert.equal(auditCount, 0);
    } finally { db.close(); }
  });

  it('alertLevel=warning 时写 audit_log，无 webhook URL 不发请求', async () => {
    const { db } = setup();
    const originalFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = (async () => { fetchCalled = true; return new Response('', { status: 200 }); }) as typeof fetch;
    try {
      const service = new DriftAlertService({
        tx: db,
        logger: new SilentLogger(),
        options: { webhookUrl: '', webhookTimeoutMs: 1000, webhookSecret: '' },
      });
      const result = await service.process(makeReport('warning'));
      assert.equal(result.alertEmitted, true);
      assert.ok(result.auditId);
      const row = db.prepare<{ action_type: string }>(
        `SELECT action_type FROM audit_log WHERE id = ?`,
      ).get(result.auditId);
      assert.equal(row?.action_type, 'safety.drift.warning');
      assert.equal(fetchCalled, false);
    } finally {
      globalThis.fetch = originalFetch;
      db.close();
    }
  });

  it('alertLevel=critical + 配置 webhookUrl 时发 POST 请求并附 secret 头', async () => {
    const { db } = setup();
    const originalFetch = globalThis.fetch;
    let receivedUrl = '';
    let receivedHeaders: Record<string, string> = {};
    let receivedBody = '';
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      receivedUrl = String(input);
      receivedHeaders = Object.fromEntries(
        Object.entries(init?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]),
      );
      receivedBody = String(init?.body ?? '');
      return new Response('', { status: 200 });
    }) as typeof fetch;
    try {
      const service = new DriftAlertService({
        tx: db,
        logger: new SilentLogger(),
        options: {
          webhookUrl: 'https://hooks.example/drift',
          webhookTimeoutMs: 2_000,
          webhookSecret: 'shhh',
        },
      });
      const result = await service.process(makeReport('critical'));
      assert.equal(result.alertEmitted, true);
      /* webhook 是 fire-and-forget，给一个 microtask 让它跑完 */
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      assert.equal(receivedUrl, 'https://hooks.example/drift');
      assert.equal(receivedHeaders['x-chrono-webhook-secret'], 'shhh');
      assert.equal(receivedHeaders['content-type'], 'application/json');
      const parsed = JSON.parse(receivedBody);
      assert.equal(parsed.type, 'safety.drift_alert');
      assert.equal(parsed.report.alertLevel, 'critical');
    } finally {
      globalThis.fetch = originalFetch;
      db.close();
    }
  });

  it('webhook HTTP 失败不抛错（best-effort），audit_log 仍写入', async () => {
    const { db } = setup();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('upstream down', { status: 502 })) as typeof fetch;
    try {
      const service = new DriftAlertService({
        tx: db,
        logger: new SilentLogger(),
        options: {
          webhookUrl: 'https://hooks.example/drift',
          webhookTimeoutMs: 2_000,
          webhookSecret: '',
        },
      });
      const result = await service.process(makeReport('warning'));
      assert.equal(result.alertEmitted, true);
      assert.ok(result.auditId);
      /* 让异步 webhook 失败 propagate 到 logger（不应抛） */
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
    } finally {
      globalThis.fetch = originalFetch;
      db.close();
    }
  });

  it('valueDrifts 超过 50 条时按 |delta| 排序截断', async () => {
    const { db } = setup();
    const originalFetch = globalThis.fetch;
    let receivedBody = '';
    globalThis.fetch = (async (_url, init?: RequestInit) => {
      receivedBody = String(init?.body ?? '');
      return new Response('', { status: 200 });
    }) as typeof fetch;
    try {
      const service = new DriftAlertService({
        tx: db,
        logger: new SilentLogger(),
        options: { webhookUrl: 'https://hooks.example/drift', webhookTimeoutMs: 2_000, webhookSecret: '' },
      });
      const big = makeReport('critical', 80);
      await service.process(big);
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      const parsed = JSON.parse(receivedBody);
      assert.equal(parsed.report.valueDrifts.length, 50);
    } finally {
      globalThis.fetch = originalFetch;
      db.close();
    }
  });
});

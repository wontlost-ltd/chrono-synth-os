/**
 * ADR-0047：response_templates（连带 distilled_artifacts / persona_leases）必须随租户
 * 导出 + 擦除（GDPR 数据生命周期）。这是端到端行为断言，强于「在清单里」的静态 guard。
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { PrivacyService } from '../../privacy/privacy-service.js';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import { ResponseTemplateStore } from '../../storage/response-template-store.js';
import { TestClock, SilentLogger } from '../../utils/index.js';
import type { IDatabase } from '../../storage/index.js';

const TENANT = 'default';
const PERSONA = 'persona_x';

describe('Privacy export/erase covers response_templates (ADR-0047)', () => {
  let os: ChronoSynthOS | undefined;

  afterEach(() => { os?.close(); os = undefined; });

  function setup(): { db: IDatabase; privacy: PrivacyService } {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    os = new ChronoSynthOS({ db, skipMigrations: true, clock: new TestClock(1000), logger: new SilentLogger() });
    os.start();
    return { db, privacy: new PrivacyService(os, undefined) };
  }

  it('export 包含 response_templates 行', () => {
    const { db, privacy } = setup();
    new ResponseTemplateStore(db, TENANT).appendVersion(PERSONA, 'greeting', '你好', 'dart-1', 1000);

    const out = privacy.exportData(TENANT);
    const tables = out.content.tables as Record<string, unknown[]>;
    assert.ok(tables.response_templates, 'export 应包含 response_templates');
    assert.equal(tables.response_templates.length, 1);
  });

  it('erase 删除 response_templates 行（擦除后无残留）', () => {
    const { db, privacy } = setup();
    const store = new ResponseTemplateStore(db, TENANT);
    store.appendVersion(PERSONA, 'greeting', '你好', null, 1000);
    store.appendVersion(PERSONA, 'farewell', '再见', null, 1100);
    assert.equal(store.listByPersona(PERSONA).length, 2);

    const res = privacy.eraseData(TENANT);
    assert.ok((res.tablesAffected as Record<string, number>).response_templates >= 2, 'erase 应统计 response_templates 删除数');

    /* 残留检查：直查表确认空 */
    const left = db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM response_templates WHERE tenant_id = ?').get(TENANT)?.c;
    assert.equal(left, 0, '擦除后不应有残留');
  });

  it('export/erase 也覆盖 distilled_artifacts / persona_leases（同批补登记的表）', () => {
    const { db, privacy } = setup();
    const now = 1000;
    db.prepare<void>(
      `INSERT INTO distilled_artifacts (id, tenant_id, persona_id, kind, source, payload, confidence, evidence, status, reason, created_at, compiled_at)
       VALUES (?, ?, ?, 'value_shift', 'reflection', '{}', 0.9, '[]', 'candidate', NULL, ?, NULL)`,
    ).run('da1', TENANT, PERSONA, now);
    db.prepare<void>(
      `INSERT INTO persona_leases (tenant_id, persona_id, purpose, holder_token, acquired_at, expires_at)
       VALUES (?, ?, 'earning', 'tok', ?, ?)`,
    ).run(TENANT, PERSONA, now, now + 60000);

    const exported = privacy.exportData(TENANT).content.tables as Record<string, unknown[]>;
    assert.ok(exported.distilled_artifacts?.length === 1, 'export 含 distilled_artifacts');
    assert.ok(exported.persona_leases?.length === 1, 'export 含 persona_leases');

    privacy.eraseData(TENANT);
    assert.equal(db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM distilled_artifacts WHERE tenant_id = ?').get(TENANT)?.c, 0);
    assert.equal(db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM persona_leases WHERE tenant_id = ?').get(TENANT)?.c, 0);
  });
});

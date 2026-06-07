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

  /* ── B 类：脱敏导出（敏感凭证列不得出现在导出里）+ 仍擦除 ── */

  it('B 类 user_oauth_tokens：导出脱敏（不含 access/refresh token），擦除照常', () => {
    const { db, privacy } = setup();
    db.prepare<void>(
      `INSERT INTO user_oauth_tokens (id, tenant_id, user_id, provider, scope, access_token_encrypted, refresh_token_encrypted, access_expires_at, granted_at, updated_at, revoked_at, revocation_reason)
       VALUES ('o1', ?, 'u1', 'google', 'calendar', 'SECRET_ACCESS', 'SECRET_REFRESH', 2000, 1000, 1000, NULL, NULL)`,
    ).run(TENANT);

    const rows = (privacy.exportData(TENANT).content.tables as Record<string, Array<Record<string, unknown>>>).user_oauth_tokens;
    assert.ok(rows?.length === 1, '导出应含 user_oauth_tokens 元数据');
    const row = rows[0];
    assert.equal(row.provider, 'google', '非敏感列应导出');
    assert.ok(!('access_token_encrypted' in row), 'access token 列不得出现在导出');
    assert.ok(!('refresh_token_encrypted' in row), 'refresh token 列不得出现在导出');
    /* 整个导出 JSON 不得含明文密钥 */
    assert.ok(!JSON.stringify(rows).includes('SECRET_ACCESS'), '导出不得泄露 token 值');

    privacy.eraseData(TENANT);
    assert.equal(db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM user_oauth_tokens WHERE tenant_id = ?').get(TENANT)?.c, 0, 'B 类仍须擦除');
  });

  it('B 类 api_keys：导出不含 key_hash，擦除照常', () => {
    const { db, privacy } = setup();
    db.prepare<void>(
      `INSERT INTO api_keys (id, tenant_id, key_hash, plan_id, is_revoked, created_at) VALUES ('k1', ?, 'HASH_SECRET', 'pro', 0, 1000)`,
    ).run(TENANT);
    const rows = (privacy.exportData(TENANT).content.tables as Record<string, Array<Record<string, unknown>>>).api_keys;
    assert.ok(rows?.length === 1);
    assert.ok(!('key_hash' in rows[0]), 'key_hash 不得出现在导出');
    assert.ok(!JSON.stringify(rows).includes('HASH_SECRET'));
    privacy.eraseData(TENANT);
    assert.equal(db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM api_keys WHERE tenant_id = ?').get(TENANT)?.c, 0);
  });

  /* ── C 类：保留豁免（擦除后审计/法务表仍在；hash-chain 表不导出） ── */

  it('C 类 legal_holds / compliance_evidence：擦除后仍保留（GDPR Art.17(3)），且可导出', () => {
    const { db, privacy } = setup();
    const now = 1000;
    db.prepare<void>(
      `INSERT INTO legal_holds (id, tenant_id, subject, subject_id, reason, created_by, created_at, released_at, released_by)
       VALUES ('lh1', ?, 'tenant', ?, 'litigation', 'admin', ?, NULL, NULL)`,
    ).run(TENANT, TENANT, now);
    db.prepare<void>(
      `INSERT INTO compliance_evidence (id, tenant_id, control_id, evidence_type, collector, payload_json, payload_sha256, collected_at, period_start, period_end, metadata_json)
       VALUES ('ce1', ?, 'CC6.1', 'config', 'auto', '{}', 'abc', ?, ?, ?, '{}')`,
    ).run(TENANT, now, now, now);

    /* 导出应包含（数据主体知情权） */
    const exported = privacy.exportData(TENANT).content.tables as Record<string, unknown[]>;
    assert.ok(exported.legal_holds?.length === 1, '保留豁免表仍应导出');
    assert.ok(exported.compliance_evidence?.length === 1);

    /* 擦除后必须仍在（保留义务高于删除权） */
    privacy.eraseData(TENANT);
    assert.equal(db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM legal_holds WHERE tenant_id = ?').get(TENANT)?.c, 1, 'legal_holds 擦除豁免');
    assert.equal(db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM compliance_evidence WHERE tenant_id = ?').get(TENANT)?.c, 1, 'compliance_evidence 擦除豁免');
  });

  it('C 类 audit_chain_anchors：擦除后保留（不破坏 hash chain）且不入导出（纯系统完整性）', () => {
    const { db, privacy } = setup();
    db.prepare<void>(
      `INSERT INTO audit_chain_anchors (id, tenant_id, from_seq, to_seq, tail_hash, signature, key_id, alg, signed_at)
       VALUES ('a1', ?, 1, 100, 'TAILHASH', 'SIG', 'k1', 'ed25519', '2026-01-01T00:00:00Z')`,
    ).run(TENANT);

    const exported = privacy.exportData(TENANT).content.tables as Record<string, unknown[]>;
    assert.ok(!exported.audit_chain_anchors, 'hash-chain 锚点不应入 DSAR 导出（纯系统完整性数据）');

    privacy.eraseData(TENANT);
    assert.equal(db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM audit_chain_anchors WHERE tenant_id = ?').get(TENANT)?.c, 1, '擦除不得破坏审计链');
  });

  /* ── legal hold 阻断擦除（GDPR Art.17(3)(b)）：保留义务高于删除权 ── */

  it('active legal hold 期间 eraseData 被阻断（不删任何数据），释放后才可擦除', () => {
    const { db, privacy } = setup();
    /* 放一条业务数据 + 一个 active tenant 级 legal hold */
    new ResponseTemplateStore(db, TENANT).appendVersion(PERSONA, 'greeting', '你好', null, 1000);
    db.prepare<void>(
      `INSERT INTO legal_holds (id, tenant_id, subject, subject_id, reason, created_by, created_at, released_at, released_by)
       VALUES ('lh-active', ?, 'tenant', NULL, 'litigation', 'admin', 1000, NULL, NULL)`,
    ).run(TENANT);

    /* 擦除被阻断：blocked=true、deleted=false、未删数据 */
    const blocked = privacy.eraseData(TENANT);
    assert.equal(blocked.blocked, true, 'active hold 应阻断擦除');
    assert.equal(blocked.deleted, false);
    assert.match(blocked.blocked ? blocked.reason : '', /legal hold active/i);
    assert.equal(
      db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM response_templates WHERE tenant_id = ?').get(TENANT)?.c, 1,
      'hold 期间数据不得被删',
    );

    /* 释放 hold 后可擦除 */
    db.prepare<void>('UPDATE legal_holds SET released_at = 2000, released_by = ? WHERE id = ?').run('admin', 'lh-active');
    const ok = privacy.eraseData(TENANT);
    assert.equal(ok.blocked, false);
    assert.equal(ok.deleted, true, '释放 hold 后应可擦除');
    assert.equal(db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM response_templates WHERE tenant_id = ?').get(TENANT)?.c, 0);
  });

  /* ── B 类列级脱敏 ratchet：声明每张 B 表的敏感列 + sentinel 值，断言导出不泄露 ──
   * 防回归：未来给 B 表加敏感列若不更新 exportSql，sentinel 会出现在导出 JSON → 测试失败。 */
  it('B 类脱敏 ratchet：每张 B 表插 sentinel 敏感值后，导出 JSON 不含敏感列名与值', () => {
    const { db, privacy } = setup();
    const SENT = 'SENTINEL_SECRET_VALUE';
    /* 每张 B 表：完整 INSERT（含敏感列填 sentinel）+ 期望从导出排除的敏感列名 */
    const cases: Array<{ table: string; insert: string; params: unknown[]; excluded: string[] }> = [
      { table: 'api_keys', excluded: ['key_hash'],
        insert: `INSERT INTO api_keys (id,tenant_id,key_hash,plan_id,is_revoked,created_at) VALUES ('k',?,?,'p',0,1)`, params: [TENANT, SENT] },
      { table: 'import_commit_tokens', excluded: ['token'],
        insert: `INSERT INTO import_commit_tokens (token,tenant_id,import_id,manifest_checksum,expires_at,created_at) VALUES (?,?,'imp','sum',9,1)`, params: [SENT, TENANT] },
      { table: 'user_oauth_tokens', excluded: ['access_token_encrypted', 'refresh_token_encrypted'],
        insert: `INSERT INTO user_oauth_tokens (id,tenant_id,user_id,provider,scope,access_token_encrypted,refresh_token_encrypted,access_expires_at,granted_at,updated_at,revoked_at,revocation_reason) VALUES ('o',?,'u','g','s',?,?,9,1,1,NULL,NULL)`, params: [TENANT, SENT, SENT + '2'] },
      { table: 'tool_permissions', excluded: ['revocation_key'],
        insert: `INSERT INTO tool_permissions (id,tenant_id,persona_id,tool_id,scope,constraints_json,granted_by,granted_at,expires_at,revoked_at,revocation_reason,revocation_key) VALUES ('tp',?,'p','t','execute','{}','u',1,NULL,NULL,NULL,?)`, params: [TENANT, SENT] },
      { table: 'agency_authorizations', excluded: ['revocation_key'],
        insert: `INSERT INTO agency_authorizations (id,tenant_id,persona_id,principal_user_id,scope,scope_description,allowed_tools_json,denied_tools_json,status,granted_at,expires_at,revoked_at,revocation_reason,revocation_key) VALUES ('aa',?,'p','u','s','d','[]','[]','active',1,NULL,NULL,NULL,?)`, params: [TENANT, SENT] },
      { table: 'tool_invocations', excluded: ['input_hash', 'confirmation_token_id'],
        insert: `INSERT INTO tool_invocations (id,tenant_id,persona_id,tool_id,invoker_type,invoker_id,status,input_hash,output_size_bytes,error_message,cost_cents,duration_ms,invoked_at,completed_at,confirmation_token_id,invoker_user_id) VALUES ('ti',?,'p','t','internal','iv','ok',?,0,NULL,0,1,1,1,?,'u')`, params: [TENANT, SENT, SENT + '3'] },
      { table: 'conversation_confirmation_tokens', excluded: ['id', 'input_hash'],
        insert: `INSERT INTO conversation_confirmation_tokens (id,tenant_id,persona_id,session_id,external_user_id,requested_topic,requested_rule,input_hash,issued_at,expires_at,consumed_at) VALUES (?,?,'p','sess','eu','topic','rule',?,1,9,NULL)`, params: [SENT, TENANT, SENT + '4'] },
      { table: 'export_jobs', excluded: ['download_url', 'pack_json'],
        insert: `INSERT INTO export_jobs (id,tenant_id,state,percent,eta_ms,created_at,completed_at,download_url,error_code,warnings,pack_json) VALUES ('ej',?,'completed',100,0,1,1,?,NULL,'[]',?)`, params: [TENANT, SENT, SENT + '5'] },
    ];

    for (const c of cases) db.prepare<void>(c.insert).run(...(c.params as never[]));

    const tables = privacy.exportData(TENANT).content.tables as Record<string, Array<Record<string, unknown>>>;
    for (const c of cases) {
      const rows = tables[c.table];
      assert.ok(rows && rows.length === 1, `${c.table} 应被导出`);
      for (const col of c.excluded) {
        assert.ok(!(col in rows[0]), `${c.table}.${col} 敏感列不得出现在导出`);
      }
    }
    /* 整个导出 JSON 不得含任何 sentinel 值（彻底防泄露） */
    const blob = JSON.stringify(tables);
    assert.ok(!blob.includes(SENT), '导出 JSON 不得含任何 sentinel 敏感值');
  });
});

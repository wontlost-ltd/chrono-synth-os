/**
 * 完整性 ratchet：每张 tenant-scoped 表（含 tenant_id 列）必须**显式**归类为
 *   - 已纳入隐私导出/擦除（PRIVACY_COVERED_TABLES），或
 *   - 保留豁免（PRIVACY_RETENTION_EXEMPT_TABLES，GDPR Art.17(3) 法律/审计保留，导出可有、擦除一定无）。
 * 不允许出现两者都不在的表（= 新漏网）。新增 tenant 表必须二选一登记。
 *
 * 背景：曾有 35 张 tenant 表未纳入隐私导出/擦除（跨多个历史 PR 累积的 GDPR 缺口）。
 * 本轮按 A(标准导出+擦除)/B(脱敏导出+擦除)/C(保留不擦除) 全部归类，债清单清零；
 * 本 ratchet 锁定「不再新增漏网」。分类证据见 .claude/context-gdpr-tables.json。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import { PRIVACY_COVERED_TABLES, PRIVACY_RETENTION_EXEMPT_TABLES } from '../../privacy/privacy-service.js';

interface SqliteTableRow { readonly name: string }
interface SqliteColRow { readonly name: string }

describe('Privacy coverage ratchet: every tenant-scoped table is classified', () => {
  it('每张含 tenant_id 列的表都在「已覆盖」或「保留豁免」之一（无新漏网）', () => {
    const db = createMemoryDatabase();
    runDslSqliteMigrations(db);

    const tables = db.prepare<SqliteTableRow>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    ).all();

    const tenantTables: string[] = [];
    for (const t of tables) {
      const cols = db.prepare<SqliteColRow>(`PRAGMA table_info(${t.name})`).all();
      if (cols.some((c) => c.name === 'tenant_id')) tenantTables.push(t.name);
    }
    assert.ok(tenantTables.length > 0, 'sanity: should discover tenant-scoped tables');

    const unclassified = tenantTables.filter(
      (name) => !PRIVACY_COVERED_TABLES.has(name) && !PRIVACY_RETENTION_EXEMPT_TABLES.has(name),
    );
    assert.deepEqual(
      unclassified, [],
      `这些 tenant-scoped 表既未纳入隐私导出/擦除，也未登记为保留豁免：\n  ${unclassified.join('\n  ')}\n` +
      `新增 tenant 表必须纳入 privacy-service TENANT_TABLES/RELATED_TABLES，或（确有法律/审计保留义务时）` +
      `加入 RETENTION_EXEMPT_TABLES。`,
    );
  });

  it('covered 与 retention-exempt 不重叠（一张表不能既擦除又豁免）', () => {
    const overlap = [...PRIVACY_RETENTION_EXEMPT_TABLES].filter((t) => PRIVACY_COVERED_TABLES.has(t));
    assert.deepEqual(overlap, [], `这些表同时出现在 covered 和 retention-exempt：${overlap.join(', ')}`);
  });

  it('回归锚点：审计/法务表保留豁免（不在 covered/会擦除集）', () => {
    for (const t of ['legal_holds', 'compliance_evidence', 'audit_chain_anchors', 'kms_key_audit']) {
      assert.ok(PRIVACY_RETENTION_EXEMPT_TABLES.has(t), `${t} 必须保留豁免`);
      assert.ok(!PRIVACY_COVERED_TABLES.has(t), `${t} 不应在会擦除的 covered 集`);
    }
  });

  it('回归锚点：凭证表纳入覆盖（脱敏导出 + 擦除）', () => {
    for (const t of ['api_keys', 'user_oauth_tokens', 'tool_permissions', 'persona_rules']) {
      assert.ok(PRIVACY_COVERED_TABLES.has(t), `${t} 必须在隐私覆盖（脱敏导出 + 擦除）`);
    }
  });
});

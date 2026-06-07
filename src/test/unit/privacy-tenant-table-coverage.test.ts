/**
 * 增量护栏（ratchet）：每张 tenant-scoped 表（含 tenant_id 列）必须**显式**归类为
 * 「已纳入隐私导出/擦除」或「已知未覆盖技术债」之一——不允许出现既不在覆盖清单、
 * 也不在已知债清单的表（= 新漏网）。新增 tenant 表必须二选一登记，否则测试失败。
 *
 * 背景：response_templates / distilled_artifacts / persona_leases 曾因新增时漏加
 * privacy TENANT_TABLES 而导致租户导出缺失、擦除残留（GDPR 缺口）。本测试从真实 DSL
 * schema 自动发现所有 tenant_id 表，把「隐性缺口」变成「显式登记 + 增量锁定」。
 *
 * ⚠️ KNOWN_UNCOVERED_DEBT：这是**既有合规技术债**（跨多个历史 PR 累积），不是「豁免」。
 * 这些表当前确实未纳入租户导出/擦除，属真实 GDPR 缺口，应由**专门的合规 PR** 逐表补齐
 * （注意 api_keys / user_oauth_tokens 等含敏感列，导出需脱敏；部分需 join 关联导出）。
 * 本测试只保证「不再新增漏网」，不替代那次补齐。每补齐一张，从本清单移除即可。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import { PRIVACY_COVERED_TABLES } from '../../privacy/privacy-service.js';

interface SqliteTableRow { readonly name: string }
interface SqliteColRow { readonly name: string }

/**
 * 已知未覆盖的 tenant-scoped 表（GDPR backlog）。每张都是待补的真实缺口。
 * 不要往这里加新表来「绕过」——新增表应优先纳入隐私导出/擦除。
 */
const KNOWN_UNCOVERED_DEBT: ReadonlySet<string> = new Set<string>([
  'billing_outbox', 'ws_event_log', 'api_keys', 'tenant_add_ons',
  'entitlements', 'observability_outbox', 'observability_rollups',
  'observability_processed_events', 'export_jobs', 'kms_key_audit',
  'event_ledger', 'persona_core_ledger_outbox', 'projection_store',
  'conflict_inbox', 'import_commit_tokens', 'import_jobs',
  'tenant_key_versions', 'tenant_vault_audit', 'tenant_storage_bindings',
  'drift_analysis_log', 'persona_templates', 'bulk_knowledge_import_jobs',
  'conversation_messages', 'conversation_confirmation_tokens',
  'tool_permissions', 'agency_authorizations', 'tool_invocations',
  'user_oauth_tokens', 'events_user_journey', 'core_values_snapshot',
  'compliance_evidence', 'legal_holds', 'break_glass_jti_consumptions',
  'audit_chain_anchors', 'audit_chain_anchor_failures',
]);

describe('Privacy coverage ratchet: tenant-scoped tables must be classified', () => {
  it('每张含 tenant_id 列的表都在「已覆盖」或「已知未覆盖债」之一（无新漏网）', () => {
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
      (name) => !PRIVACY_COVERED_TABLES.has(name) && !KNOWN_UNCOVERED_DEBT.has(name),
    );
    assert.deepEqual(
      unclassified, [],
      `这些 tenant-scoped 表既未纳入隐私导出/擦除，也未登记为已知技术债：\n  ${unclassified.join('\n  ')}\n` +
      `新增 tenant 表必须纳入 privacy-service TENANT_TABLES，或（确有理由暂缓时）登记到 KNOWN_UNCOVERED_DEBT。`,
    );
  });

  it('债清单不含已覆盖的表（补齐后须从债清单移除，避免清单腐烂）', () => {
    const overlap = [...KNOWN_UNCOVERED_DEBT].filter((t) => PRIVACY_COVERED_TABLES.has(t));
    assert.deepEqual(overlap, [], `这些表已纳入隐私覆盖，应从 KNOWN_UNCOVERED_DEBT 移除：${overlap.join(', ')}`);
  });

  it('回归锚点：ADR-0047/0048 新增三表已纳入隐私覆盖（不在债清单）', () => {
    for (const t of ['response_templates', 'distilled_artifacts', 'persona_leases']) {
      assert.ok(PRIVACY_COVERED_TABLES.has(t), `${t} 必须在隐私覆盖清单`);
      assert.ok(!KNOWN_UNCOVERED_DEBT.has(t), `${t} 不应在债清单`);
    }
  });
});

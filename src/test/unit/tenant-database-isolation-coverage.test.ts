/**
 * 完整性 ratchet：每张 tenant-scoped 表（含 tenant_id 列）要么在 TenantDatabase 的
 * 自动租户隔离表集（ALL_TENANT_TABLES，query 改写时注入/校验 tenant），要么显式登记为
 * 已知未隔离（KNOWN_UNISOLATED）。不允许新增表悄悄绕过租户隔离。
 *
 * 背景：与 privacy 覆盖同源的系统性缺口——发现 13 张含 tenant_id 的表当前不在
 * TenantDatabase 隔离集。本轮不盲目把它们塞进隔离包装（会改 query 改写行为，需逐表
 * 验证安全），而是登记为债 + 锁住增量，留独立 PR 评估。本轮 GDPR 新纳管的 35 张表
 * 已全部进入隔离集。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import { ALL_TENANT_TABLES } from '../../multi-tenant/tenant-database.js';

interface SqliteTableRow { readonly name: string }
interface SqliteColRow { readonly name: string }

/**
 * 已知未纳入 TenantDatabase 自动隔离的 tenant_id 表（隔离债）。
 * 多为通过专用 store/服务自带 tenant 作用域、或属租户根（users）的表；逐表验证后
 * 应或纳入隔离集、或确认豁免。不要往这里加新表来绕过隔离。
 */
const KNOWN_UNISOLATED: ReadonlySet<string> = new Set<string>([
  'users',            /* 租户根表本身 */
  'quota_limits', 'quota_usage', 'idempotency_keys', /* 由专用 executor 自带 tenant 作用域 */
  'tasks', 'life_simulations', 'subscriptions', 'usage_records', 'llm_usage',
  'decision_cases', 'decision_runs', 'decision_feedbacks', 'onboarding_sessions',
]);

describe('TenantDatabase isolation ratchet: tenant tables must be isolated or registered', () => {
  it('每张含 tenant_id 列的表都在隔离集或已知未隔离债（无新绕过）', () => {
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

    const unregistered = tenantTables.filter(
      (name) => !ALL_TENANT_TABLES.has(name) && !KNOWN_UNISOLATED.has(name),
    );
    assert.deepEqual(
      unregistered, [],
      `这些 tenant-scoped 表既不在 TenantDatabase 隔离集，也未登记为已知未隔离债：\n  ${unregistered.join('\n  ')}\n` +
      `新增 tenant 表应纳入 TenantDatabase TENANT_TABLES，或（确有理由时）登记 KNOWN_UNISOLATED。`,
    );
  });

  it('债清单不含已隔离的表（纳入后须从债清单移除）', () => {
    const overlap = [...KNOWN_UNISOLATED].filter((t) => ALL_TENANT_TABLES.has(t));
    assert.deepEqual(overlap, [], `这些表已在隔离集，应从 KNOWN_UNISOLATED 移除：${overlap.join(', ')}`);
  });

  it('回归锚点：本轮 GDPR 纳管的代表性表已进入隔离集', () => {
    for (const t of ['response_templates', 'user_oauth_tokens', 'conversation_messages', 'legal_holds', 'api_keys']) {
      assert.ok(ALL_TENANT_TABLES.has(t), `${t} 应在 TenantDatabase 隔离集`);
    }
  });
});

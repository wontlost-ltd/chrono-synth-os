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
 * 已知未纳入 TenantDatabase 自动隔离的 tenant_id 表。经 ②b 逐表审计（Codex 独立核验，
 * 见 docs/audit/2026-06-11-tenant-table-isolation-audit.json）后，按访问路径的 tenant 约束分三类：
 *
 * 已登记 scoped 后续债（②b 复审）：
 *   - tasks / subscriptions / life_simulations：仍有 id-only 读/改面，需逐路径拆分（worker-only vs
 *     tenant-facing），见审计报告各表 Action。
 *   - SAFE-EXEMPT 表的「未来裸 SQL 防回归」：本 ratchet 只挡「新表完全不登记」，挡不住「未来给已豁免
 *     表新增忘带 tenant_id 的生产 SQL」。后续可加针对 SAFE-EXEMPT 表的静态/lint ratchet（标记触达
 *     onboarding_sessions/idempotency_keys 等且不带 tenant_id 的新 SQL，除非显式标注为全局维护）。
 *
 * SPECIAL：users 是租户根/身份表——登录与身份发现必须先全局按 email/id 找到 user 才能确定其
 * 租户归属，故部分访问天然全局；tenant-admin 路径仍要求 tenant 谓词。
 *
 * SAFE-EXEMPT（正式豁免）：所有读/改/删路径都在 SQL 层带 tenant_id 约束（经专用 executor/route
 * 保证），不经 TenantDatabase 改写但同样安全。逐表证据见审计报告。
 *
 * NEEDS-ISOLATION（剩余 scoped debt）：仍存在 id-only 读/改路径（跨租户泄漏面），但因含 worker
 * 全局语义/外部 id（Stripe）等，不能直接塞进 TenantDatabase，需逐路径拆分修复。
 *
 * 注：这些表都靠 executor/route 在 SQL 层手工带 tenant_id 保证隔离（而非 TenantDatabase 自动改写），
 * 故仍登记在此清单（不在 ALL_TENANT_TABLES），但 SAFE-EXEMPT/SPECIAL 类已逐表核验安全。
 */
const KNOWN_UNISOLATED: ReadonlySet<string> = new Set<string>([
  /* ── SPECIAL ── */
  'users',            /* 租户根/身份表：登录/身份发现天然全局，tenant-admin 路径仍带 tenant 谓词 */
  /* ── SAFE-EXEMPT（executor/route 层均带 tenant_id，逐表核验后正式豁免）── */
  'quota_limits', 'quota_usage',   /* quota-executors：读/写/删均 WHERE tenant_id */
  'usage_records', 'llm_usage',    /* usage/llm-usage-executors：租户读写带 tenant_id（仅 admin metrics 全局聚合）*/
  'decision_cases', 'decision_runs', 'decision_feedbacks', /* decisions route：读 WHERE id AND tenant_id */
  'onboarding_sessions', /* ②b 修复：读回从 id-only 改为 id AND tenant_id，全路径已带 tenant 约束 */
  'idempotency_keys',    /* ②b 修复：complete/delete 从 id-only 改为 id AND tenant_id（过期清理仍显式全局）*/
  /* ── 经 #124 逐路径核验：tenant-facing 路径已 SQL 层隔离 / 其余为合法全局 worker·webhook ── */
  'tasks',            /* #124 已加固：tenant-facing get/cancel 改用 getTaskForTenant（SQL 层 id+tenant）；
                         claim/complete/fail/reschedule/reaper/dequeue/purge 是 worker 全局语义，保持全局 */
  'subscriptions',    /* #124 核验：id-only UPDATE 均在 getLatestSubscription(tenantId) 之后（行已 tenant 验证）；
                         Stripe webhook 按 stripe_customer_id 是外部 id 驱动，天然全局——无需加 tenant 谓词 */
  'life_simulations', /* #124 核验：tenant-facing 路由用 getStatus(id,tenantId) 等 tenant 变体；id-only
                         getById/update 是 worker executeTask 内部路径（任务入队时已校 tenant 配额），合法全局 */
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
    for (const t of ['response_templates', 'persona_rules', 'llm_provider_credentials', 'tenant_llm_settings', 'perception_media_refs', 'perception_events', 'user_oauth_tokens', 'conversation_messages', 'legal_holds', 'api_keys']) {
      assert.ok(ALL_TENANT_TABLES.has(t), `${t} 应在 TenantDatabase 隔离集`);
    }
  });
});

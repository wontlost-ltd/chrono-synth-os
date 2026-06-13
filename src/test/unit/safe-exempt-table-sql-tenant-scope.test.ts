/**
 * 完整性 ratchet（防回归）：SAFE-EXEMPT 表的裸 SQL 必须带 tenant_id 或显式登记为合法全局。
 *
 * 背景：以下表不走 TenantDatabase 自动租户改写，全靠 executor/route 在 SQL 层手工带
 * tenant_id 谓词保证隔离（见 src/test/unit/tenant-database-isolation-coverage.test.ts 的
 * KNOWN_UNISOLATED 与 docs/audit/2026-06-11-tenant-table-isolation-audit.json）。现有
 * isolation ratchet 只挡「新表完全不登记」，挡不住「未来给已豁免表新增一条忘带 tenant_id
 * 谓词的生产 SQL」——那会悄悄打开跨租户泄漏面。
 *
 * 本 ratchet 静态扫描所有非测试源码里**直接出现 SAFE-EXEMPT 表名**的 SQL 字符串字面量，
 * 规则：同一字符串内必须出现 `tenant_id`，否则该 SQL 必须显式登记进 ALLOWED_GLOBAL_SQL
 * （合法全局：worker 全局语义 / 过期清理 / webhook 外部 id / 已解析 tenant-owned row id /
 * admin 全局聚合 / 从 id 反查 tenant）。新增不带 tenant_id 的裸 SQL 必须带理由登记，
 * 否则测试红——把「忘带 tenant 谓词」挡在合入前。
 *
 * allowlist 用「表名 + 规范化 SQL 指纹」做键（不随行号漂移）；SQL 内容改了才需重新登记，
 * 符合「内容变了重新审」。指纹来源经 #124 复审与逐路径核验（见上述审计报告）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

const SRC_ROOT = resolve(process.cwd(), 'src');

/**
 * SAFE-EXEMPT 表：含 tenant_id 列但不在 TenantDatabase 自动隔离集，靠手工 SQL 谓词隔离。
 * 与 tenant-database-isolation-coverage.test.ts 的 KNOWN_UNISOLATED 同源（users 是身份根表，
 * 登录/身份发现天然全局，不纳入本 SQL 谓词扫描）。
 */
const SAFE_EXEMPT_TABLES: readonly string[] = [
  'quota_limits', 'quota_usage', 'usage_records', 'llm_usage',
  'decision_cases', 'decision_runs', 'decision_feedbacks',
  'onboarding_sessions', 'idempotency_keys',
  'tasks', 'subscriptions', 'life_simulations',
];

/**
 * 合法全局 SQL allowlist（不含 tenant_id 但已逐条核验安全）。
 * 键 = `表名::规范化指纹`。新增一条裸全局 SQL 必须在此登记 + 写明 globalKind/理由。
 *
 * globalKind 分类：
 *   - worker_global_semantics：worker 在全局 dequeue/claim 后按 task·simulation row id 操作
 *   - expired_cleanup：TTL/保留期到期清理，按时间删，非请求数据访问
 *   - webhook_external_id：Stripe webhook 入口按外部 id（stripe_customer_id）反查，尚无 tenant 上下文
 *   - resolved_tenant_row_id：先经 tenant-scoped SELECT 验证归属，再按已验证 row id 写
 *   - admin_global_aggregation：运维/管理面全局聚合指标
 *   - tenant_owner_resolution：从全局 id 反查所属 tenant（用于后续 share/协作鉴权）
 */
interface AllowedGlobalSql {
  readonly table: string;
  readonly fingerprint: string;   // 规范化后的 SQL（lowercase + 折叠空白 + 去尾分号）
  readonly globalKind: string;
  readonly reason: string;
}

const ALLOWED_GLOBAL_SQL: readonly AllowedGlobalSql[] = [
  /* ── subscriptions：Stripe webhook + 已解析 tenant-owned row id ── */
  { table: 'subscriptions', globalKind: 'webhook_external_id',
    fingerprint: 'select * from subscriptions where stripe_customer_id = ? order by created_at desc limit 1',
    reason: 'Stripe webhook 按外部 stripe_customer_id 反查租户订阅，此时尚无 tenant 上下文' },
  { table: 'subscriptions', globalKind: 'webhook_internal_row_id',
    fingerprint: 'update subscriptions set stripe_customer_id = ?, updated_at = ? where id = ?',
    reason: 'webhook/checkout 按已解析的全局订阅 row id 更新' },
  { table: 'subscriptions', globalKind: 'webhook_internal_row_id',
    fingerprint: "update subscriptions set stripe_subscription_id = ?, status = ?, plan_id = ?, current_period_start = ?, current_period_end = ?, updated_at = ? where id = ?",
    reason: 'webhook 按已解析的全局订阅 row id 更新' },
  { table: 'subscriptions', globalKind: 'webhook_external_id',
    fingerprint: "update subscriptions set status = 'canceled', plan_id = 'free', updated_at = ? where stripe_customer_id = ?",
    reason: 'webhook 取消按 Stripe customer 外部 id' },
  { table: 'subscriptions', globalKind: 'webhook_internal_row_id',
    fingerprint: 'update subscriptions set trial_end = ?, cancel_at_period_end = ?, grace_period_ends_at = null, updated_at = ? where id = ?',
    reason: 'webhook 生命周期更新按已解析的全局订阅 row id' },
  { table: 'subscriptions', globalKind: 'webhook_internal_row_id',
    fingerprint: "update subscriptions set status = case when status in ('past_due', 'canceled') then 'active' else status end, grace_period_ends_at = null, last_invoice_id = coalesce(?, last_invoice_id), updated_at = ? where id = ?",
    reason: 'invoice paid webhook 复活按已解析的全局订阅 row id' },
  { table: 'subscriptions', globalKind: 'webhook_internal_row_id',
    fingerprint: "update subscriptions set status = 'past_due', grace_period_ends_at = ?, last_invoice_id = coalesce(?, last_invoice_id), updated_at = ? where id = ?",
    reason: 'invoice failed webhook 标记按已解析的全局订阅 row id' },
  { table: 'subscriptions', globalKind: 'resolved_tenant_row_id',
    fingerprint: "update subscriptions set plan_id = ?, status = 'active', current_period_start = ?, current_period_end = ?, updated_at = ? where id = ?",
    reason: 'billing-service subscribeTenant 在 getLatestSubscription(tenantId) 验证归属后按已验证 row id 改套餐' },

  /* ── idempotency_keys：TTL 清理 ── */
  { table: 'idempotency_keys', globalKind: 'expired_cleanup',
    fingerprint: 'delete from idempotency_keys where expires_at <= ?',
    reason: '过期幂等键 TTL 清理，按时间删，非请求数据访问' },

  /* ── tasks：worker 全局队列语义 + TTL 清理 + 运维聚合 ── */
  { table: 'tasks', globalKind: 'worker_global_semantics',
    fingerprint: 'select * from tasks where id = ?',
    reason: 'worker/内部按已出队 task id 读；tenant-facing 读必须用 id+tenant 变体（见 #124）' },
  { table: 'tasks', globalKind: 'expired_cleanup',
    fingerprint: "select id from tasks where status in ('completed', 'failed') and updated_at < ? limit ?",
    reason: '终态 task 保留期扫描（后接批量删）' },
  { table: 'tasks', globalKind: 'worker_global_semantics',
    fingerprint: "update tasks set status = 'running', claimed_by = ?, claimed_at = ?, updated_at = ? where id = ? and status = 'pending'",
    reason: 'worker 全局 dequeue 后按 id claim' },
  { table: 'tasks', globalKind: 'worker_global_semantics',
    fingerprint: "update tasks set status = 'completed', result = ?, updated_at = ? where id = ?",
    reason: 'worker 完成已 claim 的全局 task' },
  { table: 'tasks', globalKind: 'worker_global_semantics',
    fingerprint: "update tasks set status = 'failed', error = ?, updated_at = ? where id = ?",
    reason: 'worker 标记已 claim 的全局 task 失败' },
  { table: 'tasks', globalKind: 'worker_global_semantics',
    fingerprint: "update tasks set status = 'pending', retry_count = ?, available_at = ?, error = ?, updated_at = ? where id = ?",
    reason: 'worker 重排全局 task' },
  { table: 'tasks', globalKind: 'expired_cleanup',
    fingerprint: 'delete from tasks where id in (${placeholders})',
    reason: '删除终态 task 保留期扫描返回的 id 批' },
  { table: 'tasks', globalKind: 'worker_global_semantics',
    fingerprint: 'update tasks set status = \'pending\', claimed_by = null, claimed_at = null, available_at = ?, updated_at = ?, retry_count = retry_count + 1 where ${stalecondition} and retry_count < max_retries',
    reason: 'worker reaper 回收僵死 running task' },
  { table: 'tasks', globalKind: 'worker_global_semantics',
    fingerprint: "update tasks set status = 'failed', error = ?, claimed_by = null, claimed_at = null, updated_at = ? where ${stalecondition} and retry_count >= max_retries",
    reason: 'worker reaper 终结超重试的僵死 task' },
  { table: 'tasks', globalKind: 'admin_global_aggregation',
    fingerprint: 'select count(*) as count from tasks where status = ?',
    reason: '队列状态运维聚合指标（全局）' },

  /* ── life_simulations：worker 模拟生命周期 + 从 id 反查 tenant ── */
  { table: 'life_simulations', globalKind: 'worker_global_semantics',
    fingerprint: 'select * from life_simulations where id = ?',
    reason: 'executeTask worker 内联：tenant 已在 enqueue 校配额，按已出队 simulationId 执行' },
  { table: 'life_simulations', globalKind: 'worker_global_semantics',
    fingerprint: 'select * from life_simulations where base_simulation_id = ? order by created_at asc',
    reason: 'getVariants 的 bare 分支；唯一 route 调用方（life-simulation-viz）已传 tenantId 走 tenant 变体' },
  { table: 'life_simulations', globalKind: 'worker_global_semantics',
    fingerprint: 'update life_simulations set status = ?, error = ?, updated_at = ? where id = ?',
    reason: '模拟 worker 按已出队 simulation id 更新生命周期' },
  { table: 'life_simulations', globalKind: 'worker_global_semantics',
    fingerprint: 'update life_simulations set status = ?, error = ?, updated_at = ?, completed_at = ? where id = ?',
    reason: '模拟 worker 按 simulation id 完成' },
  { table: 'life_simulations', globalKind: 'worker_global_semantics',
    fingerprint: 'update life_simulations set progress_json = ?, updated_at = ? where id = ?',
    reason: '模拟 worker 按 simulation id 写进度' },
  { table: 'life_simulations', globalKind: 'worker_global_semantics',
    fingerprint: 'update life_simulations set summary_json = ?, updated_at = ? where id = ?',
    reason: '模拟 worker 按 simulation id 写摘要' },
  { table: 'life_simulations', globalKind: 'tenant_owner_resolution',
    fingerprint: 'select tenant_id from life_simulations where id = ?',
    reason: '协作流程从全局 simulation id 反查所属 tenant，再做 share 鉴权' },
];

/** 规范化 SQL 指纹：去 SQL 注释、折叠空白、小写、去首尾空白与尾分号。 */
function normalizeSql(sql: string): string {
  return sql
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/;\s*$/, '')
    .toLowerCase();
}

const ALLOWED_FINGERPRINTS: ReadonlySet<string> = new Set(
  ALLOWED_GLOBAL_SQL.map((e) => `${e.table}::${e.fingerprint.toLowerCase()}`),
);

function walkTs(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'test') continue;             // 跳过 src/test/ 整棵子树
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) walkTs(p, out);
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

/** 从源码抽取所有字符串/模板字面量（单引号、双引号、反引号）。 */
function extractStringLiterals(src: string): string[] {
  const literals: string[] = [];
  const re = /`(?:[^`\\]|\\.)*`|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    literals.push(m[0].slice(1, -1));           // 去掉外层引号
  }
  return literals;
}

/**
 * 判断字面量是否「在 SQL 关键字后直接引用了某 SAFE-EXEMPT 表名」。
 * 只匹配字面表名（FROM/JOIN/INTO/UPDATE/DELETE FROM <tbl>），动态 `${table}` 不匹配（无字面表名）。
 */
function tablesReferencedInSql(literal: string): string[] {
  const lower = literal.toLowerCase();
  const hits: string[] = [];
  for (const table of SAFE_EXEMPT_TABLES) {
    /* 表名前必须是 SQL 关键字（from/join/into/update + delete from），表名后是词边界。 */
    const re = new RegExp(`\\b(from|join|into|update)\\s+${table}\\b`, 'i');
    if (re.test(lower)) hits.push(table);
  }
  return hits;
}

describe('SAFE-EXEMPT 表裸 SQL 防回归 ratchet：必须带 tenant_id 或显式登记合法全局', () => {
  it('每条引用 SAFE-EXEMPT 表的 SQL 字面量要么含 tenant_id，要么在 allowlist', () => {
    const files = walkTs(SRC_ROOT);
    assert.ok(files.length > 0, 'sanity: 应扫描到源码文件');

    const violations: Array<{ file: string; table: string; sql: string }> = [];

    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      for (const literal of extractStringLiterals(src)) {
        const tables = tablesReferencedInSql(literal);
        if (tables.length === 0) continue;

        const norm = normalizeSql(literal);
        const hasTenant = /\btenant_id\b/.test(norm);

        for (const table of tables) {
          if (hasTenant) continue;                                 // 同串含 tenant_id → 安全
          if (ALLOWED_FINGERPRINTS.has(`${table}::${norm}`)) continue;  // 显式登记合法全局
          violations.push({
            file: file.replace(`${process.cwd()}/`, ''),
            table,
            sql: norm,
          });
        }
      }
    }

    assert.deepEqual(
      violations, [],
      `以下引用 SAFE-EXEMPT 表的 SQL 既不含 tenant_id 也未登记为合法全局——可能是忘带 tenant 谓词的跨租户泄漏面：\n` +
      violations.map((v) => `  [${v.table}] ${v.file}\n    ${v.sql}`).join('\n') +
      `\n\n若确为合法全局（worker/TTL/webhook/已验证 row id），请加入本测试的 ALLOWED_GLOBAL_SQL 并写明 globalKind 与理由；` +
      `否则给该 SQL 加 tenant_id 谓词。`,
    );
  });

  it('allowlist 自身无僵尸条目：每条指纹仍能在源码中找到对应 SQL', () => {
    const files = walkTs(SRC_ROOT);
    const presentFingerprints = new Set<string>();
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      for (const literal of extractStringLiterals(src)) {
        const tables = tablesReferencedInSql(literal);
        if (tables.length === 0) continue;
        const norm = normalizeSql(literal);
        for (const table of tables) presentFingerprints.add(`${table}::${norm}`);
      }
    }
    const stale = ALLOWED_GLOBAL_SQL.filter(
      (e) => !presentFingerprints.has(`${e.table}::${e.fingerprint.toLowerCase()}`),
    );
    assert.deepEqual(
      stale.map((e) => `${e.table}::${e.fingerprint}`), [],
      `以下 allowlist 条目在源码中已找不到对应 SQL（SQL 已改/已删）——请同步移除或更新指纹：\n` +
      stale.map((e) => `  [${e.table}] ${e.fingerprint}`).join('\n'),
    );
  });
});

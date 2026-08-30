#!/usr/bin/env node
/**
 * SQL 分层棘轮（审计 Warning B2-1）。
 *
 * 铁律：真 SQL 只允许出现在 `src/storage/executors/`（以及 storage 基础设施），
 * `src/` 其余各层应经 kernel 的 `{kind, params}` 描述符访问数据。
 * 违反的后果不是风格问题——分片重写、方言适配（PG 无 round(double precision,int)）、
 * 租户谓词注入、审计埋点这些统一实施都发生在 executor 边界；绕过它，
 * 这些保障就对该条 SQL 全部失效，且不会有任何报错。
 *
 * 为什么是棘轮而非一次性清零：当前有 12 个既有文件、40 处 SQL，逐个迁移到描述符
 * 是多日重构，且每次迁移都要动 kernel + executor + 调用方三处。棘轮先**冻结现状**——
 * 已知违规文件列在 BASELINE 里放行，但**新增文件一律拒绝**，使债务只减不增。
 * 迁移完一个文件就从 BASELINE 删一行；BASELINE 清空时可把本脚本升级为硬门。
 *
 * 纯 Node ESM，零依赖。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 受管辖的范围：**整个 `src/`**，除下方豁免层外都不该出现真 SQL。
 *
 * ⚠️ 审计 #428：此前只管辖 `src/server/routes` + `src/server/plugins` 两个目录，
 * 于是本门（连同 #411 修好的 per-file 计数）**存在一个纯机械的逃逸口**——
 * 把 SQL 从 `routes/` 挪进其余任意业务目录，就**静默退出了本门的管辖**，
 * 没有任何报错。实测未受管辖的 25 个文件里有 119 处真 SQL，
 * 且集中在最不该失去 executor 保障的层：`src/privacy/`（38 处，GDPR 导出/擦除）、
 * `src/data-plane/`（28 处，租户密钥库/事件账本）。
 *
 * 用**白名单式**（管辖 src/ 全部 + 列出豁免）而非枚举 13 个业务目录：
 * 枚举是黑名单，新增业务目录时又会重开同一个盲区。
 */
const GOVERNED_DIRS = ['src'];

/**
 * 豁免层：这些地方**本就该**写真 SQL。
 *
 * - `src/storage/`：executor 边界本身，真 SQL 的唯一合法归宿。
 * - `src/test/`：测试夹具需要直接建表/塞数据来构造场景。
 *
 * 匹配按路径前缀（`src/storage` 或 `src/storage/...`），不做子串匹配，
 * 以免 `src/storage-foo/` 被误豁免。
 */
const EXEMPT_PREFIXES = ['src/storage', 'src/test'];

/**
 * 既有违规文件（审计时的现状快照）。
 *
 * ⚠️ 只减不增：迁移完一个文件就删掉对应行。**禁止**为新文件往这里加行——
 * 那正是本棘轮要挡的事。若确有不可迁移的基础设施例外，须在此注明理由。
 */
const BASELINE = new Map([
  /* ── 业务层（审计 #428 扩管辖时冻结的现状）──
   * 这些是**扩范围前就已存在**的债务，不是新引入的。逐个迁移到描述符后删行。 */
  ['src/audit/audit-anchor-verifier.ts', 2],
  ['src/audit/audit-chain-anchor-service.ts', 9],
  ['src/billing/settlement-reconciliation-service.ts', 1],
  ['src/compliance/evidence-collectors.ts', 5],
  ['src/core/memory-facade.ts', 3],
  ['src/data-plane/audit-router.ts', 2],
  ['src/data-plane/persona-core-dual-write.ts', 5],
  ['src/data-plane/platform-key-resolver.ts', 3],
  ['src/data-plane/sqlite-event-ledger.ts', 9],
  ['src/data-plane/sqlite-projection-store.ts', 4],
  ['src/data-plane/storage-provider-resolver.ts', 1],
  ['src/data-plane/tenant-vault.ts', 4],
  ['src/enterprise/kms-key-audit.ts', 1],
  ['src/multi-tenant/tenant-database.ts', 7],
  ['src/observability/observability-outbox.ts', 1],
  ['src/observability/observability-worker-monitor.ts', 2],
  ['src/onboarding/onboarding-v2-service.ts', 14],
  ['src/privacy/conflict-inbox-store.ts', 5],
  ['src/privacy/export-job-store.ts', 4],
  ['src/privacy/import-token-store.ts', 9],
  ['src/privacy/legal-hold-service.ts', 7],
  ['src/privacy/privacy-service.ts', 13],
  ['src/queue/task-queue.ts', 1],
  ['src/safety/persona-drift-analyzer.ts', 4],
  ['src/server/app.ts', 3],
  /* ── 路由/插件层（原始基线）── */
  ['src/server/plugins/jwt-key-store.ts', 4],
  ['src/server/plugins/websocket.ts', 5],
  ['src/server/routes/admin-config.ts', 3],
  ['src/server/routes/admin-deployment.ts', 5],
  ['src/server/routes/analytics.ts', 1],
  ['src/server/routes/companion/me.ts', 1],
  ['src/server/routes/companion/recent-growth.ts', 1],
  ['src/server/routes/dashboards.ts', 6],
  ['src/server/routes/decisions.ts', 10],
  ['src/server/routes/health.ts', 2],
  ['src/server/routes/onboarding.ts', 4],
  ['src/server/routes/privacy.ts', 1],
]);

/**
 * 真 SQL 的信号。
 *
 * ⚠️ 审计 P3：原先只匹配 `.prepare<`（要求泛型参数），注释还声称那是
 * 「本仓库唯一的 SQL 入口写法」—— **不成立**。`onboarding-v2.ts` 用的是**裸**
 * `.prepare(` 加多行 `INSERT INTO persona_versions`，既不在 BASELINE 里，
 * 本门却打印「无新增真 SQL」并 exit 0 —— 那条 INSERT 列名全错、端点必 500，
 * 正是从这个缺口溜过去的。`db.exec('DELETE FROM ...')` 同样不可见。
 *
 * 现在覆盖：`.prepare<`、`.prepare(`，以及 **db 对象上**的 `.exec(`。
 *
 * ⚠️ 裸 `.exec(` 不能直接匹配 —— `RegExp.prototype.exec` 同名（实测把
 * `scim.ts` 的 `/regex/.exec(raw)` 误报成 SQL）。故要求接收者是 db 形态的
 * 标识符（db / tx / database / conn / resolver.dbForTenant(...) 等）。
 */
const SQL_MARKER = /\.prepare\s*[<(]|\b(?:db|tx|database|conn|connection|client)\w*\s*\.\s*exec\s*\(|\)\s*\.\s*exec\s*\(\s*['"`]/;

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, out);
    } else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** 路径是否落在豁免层（按 `/` 边界比较，避免 src/storage-foo 被误豁免）。 */
function isExempt(rel) {
  return EXEMPT_PREFIXES.some((p) => rel === p || rel.startsWith(p + '/'));
}

const offenders = [];
for (const govDir of GOVERNED_DIRS) {
  for (const file of walk(join(ROOT, govDir))) {
    const rel = relative(ROOT, file).split(sep).join('/');
    if (isExempt(rel)) continue;
    const src = readFileSync(file, 'utf8');
    if (!SQL_MARKER.test(src)) continue;
    /* 计数必须用**与检出同一个** marker：此前这里固定数 `.prepare<`，
     * 于是裸 `.prepare(` 的违规被检出后却打印「0 处」，读者会以为是误报。 */
    const count = (src.match(new RegExp(SQL_MARKER.source, 'g')) ?? []).length;
    offenders.push({ rel, count });
  }
}

const current = new Set(offenders.map((o) => o.rel));
/* ⚠️ 审计 #411：此前只比较**文件名集合**（`!BASELINE.has(o.rel)`），
 * `o.count` 被算出来却**只用于打印**，从不与任何 per-file 基线比较 ——
 * 12 个 BASELINE 文件因此是**无限额度的白名单**。
 *
 * 实测：往 `admin-config.ts` 追加一条 `db.prepare("DROP TABLE users")`，
 * 计数从 43→44（门看见了），却仍 exit 0 且打印「无新增真 SQL」这句
 * **明确的假陈述**。而 BASELINE 里恰恰是 admin-config / privacy / analytics
 * 这类高危路由。
 *
 * 改为 Map（文件→冻结处数）后：新文件**或**既有文件处数增加都算新增。 */
const added = offenders.filter((o) => (BASELINE.get(o.rel) ?? 0) < o.count);
/* 已迁移完但仍留在 BASELINE 的：提醒清理，避免棘轮松弛。 */
const stale = [...BASELINE.keys()].filter((f) => !current.has(f));
/* 处数**减少**是好事（迁移进行中），提示收紧基线以锁住成果。 */
const loosened = offenders.filter((o) => BASELINE.has(o.rel) && o.count < BASELINE.get(o.rel));

if (added.length > 0) {
  console.error('✗ SQL 分层棘轮：以下文件新引入了真 SQL\n');
  for (const o of added) {
    const frozen = BASELINE.get(o.rel);
    console.error(
      frozen === undefined
        ? `  ${o.rel}  （${o.count} 处真 SQL 入口，新文件）`
        : `  ${o.rel}  （${o.count} 处，冻结基线 ${frozen} 处 → 新增 ${o.count - frozen} 处）`,
    );
  }
  console.error(
    '\n真 SQL 只允许在 src/storage/executors/。请改为 kernel 的 { kind, params } 描述符：\n' +
    '  1. 在 packages/kernel/src/domain/<域>/ 定义 Query/Command 工厂；\n' +
    '  2. 在 src/storage/executors/ 注册执行器（真 SQL 写在这里）；\n' +
    '  3. 调用方经 tx.queryOne/queryMany/execute 调描述符。\n' +
    '绕过 executor 边界会让分片重写、方言适配、租户谓词、审计埋点对该条 SQL 全部失效。\n',
  );
  process.exit(1);
}

if (stale.length > 0) {
  console.error('✗ SQL 分层棘轮：以下文件已无真 SQL，请从 BASELINE 删除（保持棘轮收紧）\n');
  for (const f of stale) console.error(`  ${f}`);
  process.exit(1);
}

if (loosened.length > 0) {
  console.error('✗ SQL 分层棘轮：以下文件的真 SQL 已减少，请把基线收紧到实际值（锁住迁移成果）\n');
  for (const o of loosened) {
    console.error(`  ${o.rel}  ${BASELINE.get(o.rel)} → ${o.count}`);
  }
  process.exit(1);
}

const total = offenders.reduce((n, o) => n + o.count, 0);
console.log(
  `✓ SQL 分层棘轮：src/（豁免 ${EXEMPT_PREFIXES.join('、')}）无新增真 SQL` +
  `（既有 ${offenders.length} 文件 / ${total} 处，已冻结待迁移）。`,
);

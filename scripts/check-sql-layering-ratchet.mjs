#!/usr/bin/env node
/**
 * SQL 分层棘轮（审计 Warning B2-1）。
 *
 * 铁律：真 SQL 只允许出现在 `src/storage/executors/`（以及 storage 基础设施），
 * 路由/插件层应经 kernel 的 `{kind, params}` 描述符访问数据。
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

/** 受管辖的目录：这些层**不该**出现真 SQL。 */
const GOVERNED_DIRS = ['src/server/routes', 'src/server/plugins'];

/**
 * 既有违规文件（审计时的现状快照）。
 *
 * ⚠️ 只减不增：迁移完一个文件就删掉对应行。**禁止**为新文件往这里加行——
 * 那正是本棘轮要挡的事。若确有不可迁移的基础设施例外，须在此注明理由。
 */
const BASELINE = new Set([
  'src/server/plugins/jwt-key-store.ts',
  'src/server/plugins/websocket.ts',
  'src/server/routes/admin-config.ts',
  'src/server/routes/admin-deployment.ts',
  'src/server/routes/analytics.ts',
  'src/server/routes/companion/me.ts',
  'src/server/routes/companion/recent-growth.ts',
  'src/server/routes/dashboards.ts',
  'src/server/routes/decisions.ts',
  'src/server/routes/health.ts',
  'src/server/routes/onboarding.ts',
  'src/server/routes/privacy.ts',
]);

/** 真 SQL 的信号：`.prepare<` 是本仓库唯一的 SQL 入口写法。 */
const SQL_MARKER = /\.prepare\s*</;

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

const offenders = [];
for (const govDir of GOVERNED_DIRS) {
  for (const file of walk(join(ROOT, govDir))) {
    const rel = relative(ROOT, file).split(sep).join('/');
    const src = readFileSync(file, 'utf8');
    if (!SQL_MARKER.test(src)) continue;
    const count = (src.match(/\.prepare\s*</g) ?? []).length;
    offenders.push({ rel, count });
  }
}

const current = new Set(offenders.map((o) => o.rel));
const added = offenders.filter((o) => !BASELINE.has(o.rel));
/* 已迁移完但仍留在 BASELINE 的：提醒清理，避免棘轮松弛。 */
const stale = [...BASELINE].filter((f) => !current.has(f));

if (added.length > 0) {
  console.error('✗ SQL 分层棘轮：以下文件在路由/插件层新引入了真 SQL\n');
  for (const o of added) {
    console.error(`  ${o.rel}  （${o.count} 处 .prepare<）`);
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

const total = offenders.reduce((n, o) => n + o.count, 0);
console.log(
  `✓ SQL 分层棘轮：路由/插件层无新增真 SQL（既有 ${offenders.length} 文件 / ${total} 处，已冻结待迁移）。`,
);

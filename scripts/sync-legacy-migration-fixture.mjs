#!/usr/bin/env node
/**
 * 同步 legacy-migrations.ts parity 基线到 DSL 当前渲染输出。
 *
 * src/test/integration/fixtures/legacy-migrations.ts 是 schema-dsl parity 测试的「黄金基线」——
 * 手维护的每个迁移版本的原始 SQL，schema-dsl-integration 把它与 DSL 渲染(renderAllForTarget)的
 * SQL 在真实 PG 上跑出的 schema 做 Atlas 结构对比，并断言 version 列表逐一相等。
 *
 * 问题：新迁移持续加进 DSL，但本 fixture 是手维护的尾部追加——本会话 + per-persona/workforce/
 * perception 等累计加了 ~20 个迁移只进 DSL 没同步 fixture（PG 停 v094 / SQLite 停 v092），令
 * parity 测试在任何触碰 schema-dsl 路径的 PR 上失败（而 main 因 path 过滤一直没跑＝假绿）。
 *
 * 本脚本把 DSL 当前渲染的「fixture 缺失版本」追加进两个数组（PG + SQLite），格式与既有条目一致
 * （2 空格缩进 JSON 对象字面量）。DSL 是迁移的权威源，故追加其渲染输出即是正确基线。
 * 幂等：已存在的版本不重复追加。运行后 parity 测试应通过。
 *
 * 用法：先 `npx tsc -b tsconfig.src.json` 确保 dist 最新，再 `node scripts/sync-legacy-migration-fixture.mjs`。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = resolve(ROOT, 'src/test/integration/fixtures/legacy-migrations.ts');

const { renderAllForTarget } = await import(resolve(ROOT, 'dist/src/storage/dsl-migrations-runner.js'));

/** 把一个迁移条目渲染成与 fixture 既有格式逐字一致的 TS 对象字面量（2 空格基准缩进）。 */
function renderEntry(m) {
  const body = JSON.stringify({ version: m.version, description: m.description, sql: [...m.sql] }, null, 2);
  /* JSON.stringify 默认从第 0 列起；fixture 条目整体缩进 2 空格。逐行加 2 空格前缀。 */
  return body.split('\n').map(line => '  ' + line).join('\n');
}

/** 在 `arrayVar` 数组的 `] as const` 闭合前追加缺失版本条目。 */
function appendMissing(source, arrayVar, target) {
  /* 定位该数组的声明与闭合标记（两数组各有一个 `] as const satisfies ...`）。
   * PG 数组在 SQLite 数组之后，故按 arrayVar 声明位置切片定位其后的第一个闭合。 */
  const declIdx = source.indexOf(`export const ${arrayVar} = [`);
  if (declIdx === -1) throw new Error(`找不到数组声明 ${arrayVar}`);
  const closerRel = source.slice(declIdx).indexOf('\n] as const satisfies readonly LegacySqlMigration[];');
  if (closerRel === -1) throw new Error(`找不到 ${arrayVar} 的闭合标记`);
  const closerIdx = declIdx + closerRel; /* 指向闭合前的换行 */

  /* 幂等的关键：已存在版本从**当前 source 的该数组切片**解析（而非 dist import）——否则首次写完
   * 不重建 dist 再跑会拿旧 dist 误判缺失而重复追加（Codex 复审 Medium）。 */
  const slice = source.slice(declIdx, closerIdx);
  const haveVersions = new Set([...slice.matchAll(/"version":\s*"([^"]+)"/g)].map(m => m[1]));

  const dsl = renderAllForTarget(target);
  const missing = dsl.filter(m => !haveVersions.has(m.version));
  if (missing.length === 0) return { source, added: 0 };

  const block = missing.map(renderEntry).join(',\n');
  /* 既有最后一条以 `}` 结尾、无尾逗号；插入时先补一个 `,` 再接新块。 */
  const before = source.slice(0, closerIdx);
  const after = source.slice(closerIdx);
  return { source: `${before},\n${block}${after}`, added: missing.length };
}

let src = readFileSync(FIXTURE, 'utf8');
const pg = appendMissing(src, 'LEGACY_POSTGRES_MIGRATIONS', 'postgres');
src = pg.source;
const sq = appendMissing(src, 'LEGACY_SQLITE_MIGRATIONS', 'sqlite-sql');
src = sq.source;

if (pg.added + sq.added === 0) {
  console.log('legacy fixture 已与 DSL 同步，无需追加（幂等）。');
} else {
  writeFileSync(FIXTURE, src);
  console.log(`已同步 legacy fixture：PG +${pg.added} 条、SQLite +${sq.added} 条。`);
}

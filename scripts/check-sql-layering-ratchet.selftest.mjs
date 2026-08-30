#!/usr/bin/env node
/**
 * `check-sql-layering-ratchet` 的自测。
 *
 * 为什么必须有：这道门历史上坏过两次，且**两次都是静默假绿**——
 * 门自己失效却照常打印「无新增真 SQL」并 exit 0，比没有门更危险。
 *
 *  - 审计 #411：只比对**文件名集合**，`count` 算出来只用于打印。于是 BASELINE
 *    里的 12 个文件成了**无限额度白名单**，往 `admin-config.ts` 追加
 *    `db.prepare("DROP TABLE users")` 照样 exit 0。
 *  - 审计 #428：只管辖 `src/server/routes` + `src/server/plugins`。把 SQL 从
 *    routes 挪进其余任意业务目录就**静默退出管辖**，连同上面那条修复一起绕过。
 *
 * 两条都固化为下方用例。判据统一用**退出码**：门必须以 1 表示「发现违规」，
 * ≥2 视为基础设施错误（脚本崩了）而非「检出违规」——否则一个语法错误会被
 * 当成「门工作正常」。
 */
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const SCRIPT = new URL('./check-sql-layering-ratchet.mjs', import.meta.url).pathname;
const SRC = readFileSync(SCRIPT, 'utf8');

/**
 * 在临时根目录里跑一份门的副本。
 *
 * @param files   相对 `src/` 的文件表
 * @param baseline 覆写 BASELINE 的条目（[相对路径, 处数]）
 */
function runOn(files, baseline = []) {
  const root = mkdtempSync(join(tmpdir(), 'sql-ratchet-selftest-'));
  try {
    for (const [rel, body] of Object.entries(files)) {
      const full = join(root, 'src', rel);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, body);
    }
    mkdirSync(join(root, 'scripts'), { recursive: true });

    /* 把真实 BASELINE 换成用例给的那份，其余逻辑原样保留。 */
    const rows = baseline.map(([f, n]) => `  ['${f}', ${n}],`).join('\n');
    const patched = SRC.replace(
      /const BASELINE = new Map\(\[[\s\S]*?\n\]\);/,
      `const BASELINE = new Map([\n${rows}\n]);`,
    );
    if (patched === SRC) throw new Error('自测无法替换 BASELINE——门的结构变了，请更新本自测');
    writeFileSync(join(root, 'scripts/g.mjs'), patched);

    let code = 0;
    let out = '';
    try {
      out = execFileSync(process.execPath, [join(root, 'scripts/g.mjs')], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      code = e.status ?? -1;
      out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    }
    return { code, out };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const SQL = `export function q(db: { prepare: <T>(s: string) => { get(): T } }): unknown {
  return db.prepare<unknown>('SELECT * FROM users').get();
}
`;
const CLEAN = `export const answer = 42;\n`;

let failed = 0;
/** 期望门**检出违规**：只接受 1；≥2 是脚本崩了，不算检出。 */
function expectBlock(name, { code, out }) {
  if (code === 1) return;
  failed++;
  console.error(code >= 2 || code < 0
    ? `✖ ${name}：门自身出错（RC=${code}），这不算「检出违规」\n${out}`
    : `✖ ${name}：预期检出违规（RC=1），实际 RC=${code}\n${out}`);
}
function expectPass(name, { code, out }) {
  if (code === 0) return;
  failed++;
  console.error(`✖ ${name}：预期通过（RC=0），实际 RC=${code}\n${out}`);
}

/* ── 基本行为 ── */
expectPass('干净文件通过', runOn({ 'server/routes/a.ts': CLEAN }));
expectBlock('路由层新文件带 SQL → 拒绝', runOn({ 'server/routes/a.ts': SQL }));
expectPass('BASELINE 内、处数未涨 → 放行',
  runOn({ 'server/routes/a.ts': SQL }, [['src/server/routes/a.ts', 1]]));

/* ── 审计 #411 回归：per-file 计数 ── */
expectBlock('#411：BASELINE 内文件处数增加 → 拒绝（曾是无限额度白名单）',
  runOn({ 'server/routes/a.ts': SQL + SQL }, [['src/server/routes/a.ts', 1]]));
expectBlock('#411：BASELINE 条目已迁移完 → 提示清理（防棘轮松弛）',
  runOn({ 'server/routes/a.ts': CLEAN }, [['src/server/routes/a.ts', 1]]));
expectBlock('#411：处数减少 → 要求收紧基线（锁住迁移成果）',
  runOn({ 'server/routes/a.ts': SQL }, [['src/server/routes/a.ts', 2]]));

/* ── 审计 #428 回归：管辖范围 ──
 * 这三条是本次扩范围的核心判据。第一条若转绿，说明「把 SQL 挪出 routes/」
 * 的逃逸口又开了——那会连带废掉上面 #411 的全部修复。 */
expectBlock('#428：SQL 挪进业务目录（非 routes/plugins）→ 拒绝',
  runOn({ 'intelligence/probe.ts': SQL }));
expectBlock('#428：SQL 挪进 src/ 顶层 → 拒绝',
  runOn({ 'probe.ts': SQL }));
expectPass('#428：豁免层 src/storage 可写 SQL（不误伤 executor 边界）',
  runOn({ 'storage/executors/x.ts': SQL }));
expectPass('#428：豁免层 src/test 可写 SQL（测试夹具需直接建表）',
  runOn({ 'test/fixtures/x.ts': SQL }));
/* 豁免按路径**边界**匹配：`src/storage-foo/` 不是 `src/storage/`，不得被误豁免。 */
expectBlock('#428：src/storage-foo 不是豁免层（前缀匹配须按 / 边界）',
  runOn({ 'storage-foo/x.ts': SQL }));

/* ── marker 覆盖（审计 P3 的裸 .prepare( 与 db.exec）── */
expectBlock('裸 .prepare( 也算 SQL（不要求泛型参数）',
  runOn({ 'server/routes/a.ts': `export const f = (db: any) => db.prepare('INSERT INTO t VALUES (1)');\n` }));
expectBlock('db.exec(...) 也算 SQL',
  runOn({ 'server/routes/a.ts': `export const f = (db: any) => db.exec('DELETE FROM t');\n` }));
expectPass('RegExp.prototype.exec 不误报',
  runOn({ 'server/routes/a.ts': `export const f = (raw: string) => /ab+c/.exec(raw);\n` }));

if (failed > 0) {
  console.error(`\n✖ SQL 分层棘轮自测：${failed} 条失败——门本身不可信，先修门。`);
  process.exit(1);
}
console.log('✓ SQL 分层棘轮自测：14 条全过（含 #411 计数回归 + #428 管辖范围回归）。');

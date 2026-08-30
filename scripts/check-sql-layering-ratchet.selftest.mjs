#!/usr/bin/env node
/**
 * SQL 分层棘轮的**自测**（审计 #430）。
 *
 * 为什么必须有：审计 #430 发现 12 个门禁脚本只有 2 个有自测，而本轮
 * **出缺陷的三个门恰好全部无自测** —— 门自身逻辑退化（集合比较写反、
 * 计数没接上、管辖面被缩小）没有任何东西会发现，门永远打印 ✓。
 *
 * 本门的历史缺陷（#411）：BASELINE 只比较**文件名集合**，`o.count` 算了
 * 却只用于打印 ⇒ 12 个既有文件成了**无限额度白名单**。实测往
 * `admin-config.ts` 追加 `DROP TABLE users`：计数 43→44（门看见了）
 * 却仍 exit 0 并打印「无新增真 SQL」这句**假陈述**。
 *
 * 判据：对「应当被拦截」的样例，门必须**非零退出**；干净树必须零退出。
 * 样例写进真实受管辖目录后立即删除。
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, rmSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GATE = join(ROOT, 'scripts', 'check-sql-layering-ratchet.mjs');
/* 受管辖目录里的一个 BASELINE 文件 —— 用于「既有文件内追加」这一关键用例。 */
const BASELINE_FILE = join(ROOT, 'src/server/routes/admin-config.ts');
const PROBE_DIR = join(ROOT, 'src/server/routes/__ratchet_selftest__');
const PROBE_FILE = join(PROBE_DIR, 'probe.ts');

let failures = 0;

/** 跑门，返回退出码（0=通过）。 */
function runGate() {
  try {
    execFileSync('node', [GATE], { cwd: ROOT, stdio: 'pipe' });
    return 0;
  } catch (err) {
    return typeof err.status === 'number' ? err.status : 1;
  }
}

function check(name, expect, rc) {
  const ok = expect === 'block' ? rc !== 0 : rc === 0;
  if (ok) {
    console.log(`  ✓ ${name}（期望 ${expect === 'block' ? 'exit≠0' : 'exit=0'}，实得 ${rc}）`);
  } else {
    console.error(`  ✗ ${name}：期望 ${expect === 'block' ? 'exit≠0' : 'exit=0'}，实得 ${rc}`);
    failures += 1;
  }
}

console.log('SQL 分层棘轮自测：');

/* ① 干净树必须通过 —— 否则门是噪音，会被人绕过。 */
check('干净树（对照，应放行）', 'pass', runGate());

/* ② 受管辖目录下的**新文件**引入真 SQL → 必须拦截。 */
try {
  mkdirSync(PROBE_DIR, { recursive: true });
  writeFileSync(PROBE_FILE, "export const p = (db: any) => db.prepare('SELECT * FROM memories').all();\n");
  check('新文件引入真 SQL → 应拦截', 'block', runGate());
} finally {
  rmSync(PROBE_DIR, { recursive: true, force: true });
}

/* ③ ★核心★ BASELINE **文件内追加**真 SQL → 必须拦截。
 * 这正是 #411 的缺陷：只比文件名时此处放行，且打印「无新增真 SQL」。 */
if (existsSync(BASELINE_FILE)) {
  const original = readFileSync(BASELINE_FILE, 'utf8');
  try {
    writeFileSync(
      BASELINE_FILE,
      `${original}\nconst __ratchetSelftestProbe = (db: any) => db.prepare('SELECT 1 FROM tenants').all();\n`,
    );
    check('BASELINE 文件内追加真 SQL → 应拦截（#411 回归）', 'block', runGate());
  } finally {
    writeFileSync(BASELINE_FILE, original);
  }
} else {
  console.error(`  ✗ 前提缺失：${BASELINE_FILE} 不存在，无法验证「文件内追加」`);
  failures += 1;
}

/* ④ 还原后必须重新通过 —— 证明上一步的红是探针造成的，不是门坏了。 */
check('还原后重新放行（证明红来自探针）', 'pass', runGate());

if (failures > 0) {
  console.error(`\n✗ SQL 分层棘轮自测失败：${failures} 条不符合预期。门本身已失效，修好它再谈扫描结果。`);
  process.exit(1);
}
console.log('✓ SQL 分层棘轮自测：4/4 通过。');

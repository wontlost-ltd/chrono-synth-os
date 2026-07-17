#!/usr/bin/env node
/**
 * DB-访问点 ratchet（分片地基 Phase -1）。
 *
 * 防「新增拿 db 点未归类」漂移：全仓静扫每个「拿 db 的点」，断言它出现在
 * `src/storage/db-access-inventory.ts` 的 allowlist（按 file 归属）。任一未归类 → 退出 1。
 *
 * Codex 验收合同：不能只 grep 三串——须覆盖别名传播 + 构造器注入 + 长寿命 os 捕获。
 * 故扫描模式集含：`.getDatabase()`、`= db ?? `、`= xxx.db ?? `（如 config.db，别名传播非仅字面量 db）、
 * `this.os.getDatabase()`、`sharedDb`/`sharedTx` 捕获、`new .*Database(`、`buildAppServices(`。
 * 命中文件必须在 inventory 的 file 集合里。
 *
 * 纯 Node ESM，零依赖，直接读源码（无需构建），镜像 check-license-boundary.mjs。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');

/* 触发拿-db 的模式（Codex 合同：覆盖别名/构造器注入/长寿命捕获，非仅三串）。 */
const PATTERNS = [
  /\.getDatabase\(\)/,
  /=\s*db\s*\?\?\s*/,
  /=\s*[\w.]+\.db\s*\?\?\s*/, /* 别名传播：config.db ?? xxx（非仅裸 db） */
  /this\.os\.getDatabase\(\)/,
  /\bsharedDb\b\s*=/,
  /\bsharedTx\b\s*=/,
  /new\s+\w*Database\s*\(/,
  /buildAppServices\s*\(/,
];

/** 递归收集 src 下所有非 test/.d.ts 的 .ts 文件（repo 相对路径）。 */
function collectTsFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) { out.push(...collectTsFiles(p)); continue; }
    if (!name.endsWith('.ts')) continue;
    if (name.endsWith('.d.ts') || name.endsWith('.test.ts')) continue;
    if (p.includes(`${sep}test${sep}`)) continue;
    out.push(relative(ROOT, p));
  }
  return out;
}

/** 从 inventory 源文件解析出已归类的 file 集合（读源码文本，不 import 编译产物）。 */
function inventoryFiles() {
  const txt = readFileSync(join(SRC, 'storage/db-access-inventory.ts'), 'utf-8');
  const files = new Set();
  for (const m of txt.matchAll(/file:\s*'([^']+)'/g)) files.add(m[1]);
  return files;
}

function main() {
  const invFiles = inventoryFiles();
  const offenders = [];
  for (const file of collectTsFiles(SRC)) {
    /* inventory 文件自身 + resolver 不算拿点（它们是分片基建）。 */
    if (file.endsWith('storage/db-access-inventory.ts')) continue;
    if (file.endsWith('storage/tenant-db-resolver.ts')) continue;
    const txt = readFileSync(join(ROOT, file), 'utf-8');
    const hit = PATTERNS.some((re) => re.test(txt));
    if (hit && !invFiles.has(file)) offenders.push(file);
  }
  if (offenders.length > 0) {
    console.error('❌ DB-访问 ratchet：以下文件有拿-db 点但未在 db-access-inventory.ts 归类：');
    for (const f of offenders) console.error('   - ' + f);
    console.error('\n请在 src/storage/db-access-inventory.ts 把它按 8 类之一归类（见分片 spec）。');
    process.exit(1);
  }
  console.log(`✓ DB-访问 ratchet：${invFiles.size} 个已归类文件，无未归类拿点。`);
}

main();

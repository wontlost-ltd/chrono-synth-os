#!/usr/bin/env node
/**
 * DB-访问点主门（分片地基 Phase 0 · Plan 0 · Task 4）——**semantic-flow contract 归因门**。
 *
 * 两层网（Codex 第 9 轮）：
 *   ① **edge 级主门（evaluateGate，planned 级）**：类型驱动扫描器（db-sink-scanner.mjs）枚举全
 *      production DB-capability edge → classifyPropagation 归因 → evaluateGate 断言五条空集：
 *        unknownEdges / unregisteredSemanticSinks / uncoveredPropagationEdges /
 *        unreviewedUnresolvedCarriers / invalidInventoryGroups。任一非空 → 列诊断退出 1。
 *      这是 sink 级完整性的权威门（挡「新 sink 未登记 / edge 未归因 / unresolved 未审阅 / 覆盖漂移」）。
 *   ② **file 级 ratchet（保留作补充网）**：全仓静扫「拿 db 的点」正则，断言命中文件在 inventory 的
 *      `file` 集合里。挡「新文件引入顶层拿-db 点」（edge 门未覆盖的粗粒度信号，如直接
 *      `.getDatabase()`/`new Pool(` 而扫描器归因为 ephemeral 不产 must-register edge 的文件）。
 *
 * 纯 Node ESM，零依赖；edge 门调 db-sink-scanner.mjs（类型驱动，建 Program）——比正则精确。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  scanProductionDbCapabilityEdges,
  readInventory,
  evaluateGate,
  formatGateDiagnostics,
} from './db-sink-scanner.mjs';

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
  /new\s+Pool\s*\(/, /* 连接池构造——pg.Pool，分片 spec 点名的单实例物理证据 */
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

/** ① edge 级主门（evaluateGate，planned 级）——sink 级完整性权威门。 */
function runEdgeGate() {
  const edges = scanProductionDbCapabilityEdges();
  const inventory = readInventory();
  const result = evaluateGate(edges, inventory, { requiredLevel: 'planned' });
  if (!result.pass) {
    console.error('❌ DB-访问 edge 门（evaluateGate planned 级）未通过——以下五条须全空：');
    console.error(formatGateDiagnostics(result));
    console.error(
      '\n请在 src/storage/db-access-inventory.ts 补登记（semantic-flow contract：精确 coveredEdgeIds +' +
        ' expectedCount + disposition + reviewStatus=classified + proofObligation），绝不放宽门或加通配白名单。',
    );
    process.exit(1);
  }
  const flowContracts = inventory.filter((c) => Array.isArray(c.coveredEdgeIds)).length;
  console.log(
    `✓ DB-访问 edge 门（planned）：${edges.length} production edge，${flowContracts} 条 flow contract 精确覆盖，五条诊断全空。`,
  );
}

/** ② file 级 ratchet（补充网）——挡「新文件引入顶层拿-db 点」。 */
function runFileRatchet() {
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
    console.error('❌ DB-访问 file 级 ratchet（补充网）：以下文件有拿-db 点但未在 db-access-inventory.ts 归类：');
    for (const f of offenders) console.error('   - ' + f);
    console.error('\n请在 src/storage/db-access-inventory.ts 把它按 category/disposition 归类（见分片 spec）。');
    process.exit(1);
  }
  console.log(`✓ DB-访问 file 级 ratchet（补充网）：${invFiles.size} 个已归类文件，无未归类拿点。`);
}

function main() {
  runEdgeGate();
  runFileRatchet();
}

main();

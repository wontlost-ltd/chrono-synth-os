#!/usr/bin/env node
/**
 * 许可边界检查（ADR-0022：MIT 内核 + AGPL 服务端 双许可）。
 *
 * 防止 license 漂移：每个 workspace 包的 `license` 字段必须与 ADR-0022 的分类一致，
 * 且对应 LICENSE 文件必须存在、内容为正确的许可正本。任一不符 → 退出码 1。
 *
 * 边界（来自 docs/adr/0022-mit-kernel-agpl-enterprise.md）：
 *   - 可复用库 packages（kernel/contracts/data-plane/sync-engine/design-tokens/
 *     adapter-web|tauri|react-native/kernel-testkit/schema-dsl）→ MIT，各自带 MIT LICENSE。
 *   - 仓库根 + 服务端 src → AGPL-3.0-or-later，根带 AGPL LICENSE。
 *   - 消费级应用壳 apps（companion-web/desktop/mobile）→ AGPL 侧。
 *
 * 完整性保证：本脚本**从文件系统自动发现** packages 和 apps 的全集，断言
 * 「实际集合 == MIT 清单 ∪ AGPL 清单」——新增任何包若未显式分类即报错，无法绕过。
 *
 * 纯 Node ESM，零依赖，直接读源 package.json（无需构建）。
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** ADR-0022 分类（相对仓库根的目录） */
const MIT_PACKAGES = [
  'packages/kernel', 'packages/contracts', 'packages/data-plane',
  'packages/sync-engine', 'packages/design-tokens',
  'packages/adapter-web', 'packages/adapter-tauri', 'packages/adapter-react-native',
  'packages/kernel-testkit', 'packages/schema-dsl',
];
const AGPL_PACKAGE_DIRS = [
  'apps/companion-web', 'apps/desktop', 'apps/mobile',
];
const AGPL_ROOT = '.'; /* 仓库根 = 服务端 src，单独校验根 AGPL LICENSE */

/** MIT 正本基准：所有 MIT 包的 LICENSE 必须与 kernel 的 normalized 全文一致。 */
const MIT_BASELINE = 'packages/kernel/LICENSE';
/** MIT 基准自校验锚点：防基准文件本身被替换后所有 MIT 包同步“通过”。 */
const MIT_ANCHORS = [
  'MIT License',
  'Permission is hereby granted, free of charge, to any person obtaining a copy',
  'The above copyright notice and this permission notice shall be included in all',
  'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND',
];

/** AGPL-3.0 正本的跨全文锚点（首/中/尾 + §13），强校验防截断/伪造。 */
const AGPL_ANCHORS = [
  'GNU AFFERO GENERAL PUBLIC LICENSE',
  'Version 3, 19 November 2007',
  'Copyright (C) 2007 Free Software Foundation, Inc.',
  'Everyone is permitted to copy and distribute verbatim copies',
  'The GNU Affero General Public License is a free, copyleft license',
  'TERMS AND CONDITIONS',
  '0. Definitions.',
  '13. Remote Network Interaction; Use with the GNU General Public License.', /* AGPL 区别于 GPL 的核心条款 */
  'interacting with it remotely through a computer network', /* §13 正文 */
  'END OF TERMS AND CONDITIONS',
  'How to Apply These Terms to Your New Programs',
];
const AGPL_MIN_LINES = 600; /* 正本约 661 行；截断版无法满足 */

const errors = [];

function readPkg(dir) {
  const p = join(ROOT, dir, 'package.json');
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch (err) {
    errors.push(`${dir}/package.json 解析失败: ${err.message}`);
    return null;
  }
}

/** 列出某父目录下所有含 package.json 的子目录（相对仓库根）。 */
function discoverPackageDirs(parent) {
  const base = join(ROOT, parent);
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(base, e.name, 'package.json')))
    .map((e) => `${parent}/${e.name}`);
}

/** 完整性：实际发现的包全集必须恰好等于 MIT ∪ AGPL 分类清单。 */
function checkCoverage() {
  const discovered = [...discoverPackageDirs('packages'), ...discoverPackageDirs('apps')].sort();
  const classified = new Set([...MIT_PACKAGES, ...AGPL_PACKAGE_DIRS]);
  for (const d of discovered) {
    if (!classified.has(d)) {
      errors.push(`${d}: 未分类——新包必须在 check-license-boundary.mjs 显式归入 MIT 或 AGPL（ADR-0022）`);
    }
  }
  /* 反向：清单里列了但实际不存在的包（重命名/删除后忘了同步） */
  for (const d of classified) {
    if (!discovered.includes(d)) {
      errors.push(`${d}: 在分类清单中但实际不存在——清理 check-license-boundary.mjs`);
    }
  }
}

function normalize(text) {
  return text.replace(/\r\n/g, '\n').replace(/\s+$/g, '').trim();
}

function checkMit(dir, baselineText) {
  const pkg = readPkg(dir);
  if (!pkg) { errors.push(`${dir}: 缺少 package.json`); return; }
  if (pkg.license !== 'MIT') {
    errors.push(`${dir}: license 应为 "MIT"（ADR-0022 可复用库），实际 "${pkg.license ?? '(缺失)'}"`);
  }
  const lic = join(ROOT, dir, 'LICENSE');
  if (!existsSync(lic)) {
    errors.push(`${dir}: 缺少 LICENSE 文件（MIT 库必须各自携带）`);
    return;
  }
  /* 强校验：与 MIT 基准 normalized 全文一致（规范化换行/尾空白后），杜绝截断/篡改 */
  if (baselineText !== null && normalize(readFileSync(lic, 'utf8')) !== baselineText) {
    errors.push(`${dir}/LICENSE: 不是标准 MIT 正本（应与 ${MIT_BASELINE} 一致）`);
  }
}

function checkAgplPackage(dir) {
  const pkg = readPkg(dir);
  if (!pkg) { errors.push(`${dir}: 缺少 package.json`); return; }
  if (pkg.license !== 'AGPL-3.0-or-later') {
    errors.push(`${dir}: license 应为 "AGPL-3.0-or-later"（ADR-0022 服务端/应用壳），实际 "${pkg.license ?? '(缺失)'}"`);
  }
}

function checkRootAgpl() {
  const pkg = readPkg(AGPL_ROOT);
  if (pkg && pkg.license !== 'AGPL-3.0-or-later') {
    errors.push(`仓库根: license 应为 "AGPL-3.0-or-later"，实际 "${pkg.license ?? '(缺失)'}"`);
  }
  const lic = join(ROOT, 'LICENSE');
  if (!existsSync(lic)) {
    errors.push('仓库根: 缺少 LICENSE 文件（应为 AGPL-3.0 全文）');
    return;
  }
  const text = readFileSync(lic, 'utf8');
  const lineCount = text.split('\n').length;
  if (lineCount < AGPL_MIN_LINES) {
    errors.push(`根 LICENSE: 仅 ${lineCount} 行，疑似被截断（AGPL-3.0 正本约 661 行）`);
  }
  for (const anchor of AGPL_ANCHORS) {
    if (!text.includes(anchor)) {
      errors.push(`根 LICENSE: 缺少 AGPL-3.0 正本锚点 "${anchor}"（非完整正本）`);
    }
  }
}

/* 执行 */
checkCoverage();
const baselinePath = join(ROOT, MIT_BASELINE);
let baselineText = existsSync(baselinePath) ? normalize(readFileSync(baselinePath, 'utf8')) : null;
if (baselineText === null) {
  errors.push(`MIT 基准缺失: ${MIT_BASELINE}`);
} else {
  /* 基准自校验：基准文件本身必须是真 MIT 正本，否则它被替换后所有 MIT 包会同步“通过” */
  const missing = MIT_ANCHORS.filter((a) => !baselineText.includes(a));
  if (missing.length > 0) {
    errors.push(`MIT 基准 ${MIT_BASELINE} 不是标准 MIT 正本，缺锚点: ${missing.join(' / ')}`);
    baselineText = null; /* 基准不可信 → 不再用它做逐包比对，避免误判全员通过 */
  }
}
for (const d of MIT_PACKAGES) checkMit(d, baselineText);
for (const d of AGPL_PACKAGE_DIRS) checkAgplPackage(d);
checkRootAgpl();

if (errors.length > 0) {
  console.error('❌ 许可边界检查失败（ADR-0022）:');
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

console.log(
  `✓ 许可边界检查通过（ADR-0022）：${MIT_PACKAGES.length} 个 MIT 库（LICENSE 与基准全文一致）` +
  ` + ${AGPL_PACKAGE_DIRS.length} 个 AGPL 应用壳 + 根 AGPL-3.0 正本；包全集已自动发现并核对，无未分类包。`,
);

/**
 * API Schema 快照测试
 * 检测路由使用的 Zod schema 是否发生意外变更
 *
 * 更新快照：设置环境变量 UPDATE_SNAPSHOTS=1 后运行
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { toJSONSchema, type ZodTypeAny } from 'zod';
import * as apiSchemas from '../../server/schemas/api-schemas.js';
import * as visualizationSchemas from '../../server/schemas/visualization-schemas.js';

const routeDirectory = resolve(process.cwd(), 'src', 'server', 'routes');
const routeModuleFiles = readdirSync(routeDirectory)
  .filter((file) => file.endsWith('.ts'))
  .sort();

/* Plugins that register HTTP endpoints inline (rather than via dedicated
 * route modules). These ship their own zod schemas; we still want shape
 * changes to surface in the contract snapshot — otherwise admin surfaces
 * can drift unnoticed. The schema name extraction skips plugins that
 * don't use `*Schema.parse|safeParse` pattern. */
const pluginsDirectory = resolve(process.cwd(), 'src', 'server', 'plugins');
const pluginModuleFiles = ['jwt-auth.ts'];

type SchemaEntry = { name: string; hash: string };
type RouteModuleSnapshot = Record<string, SchemaEntry[]>;

const schemaRegistry = {
  ...apiSchemas,
  ...visualizationSchemas,
} as Record<string, ZodTypeAny>;

function extractSchemaNames(source: string): string[] {
  const matches = [...source.matchAll(/\b([A-Z][A-Za-z0-9_]*Schema)\.(?:parse|safeParse)\s*\(/g)];
  return [...new Set(matches.map((m) => m[1]))].sort();
}

function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, stableJson((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

function hashSchema(schema: ZodTypeAny): string {
  const normalized = stableJson(toJSONSchema(schema, { unrepresentable: 'any' }));
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

describe('Route Schema Snapshots', () => {
  it('keeps route schema hashes stable across builds', async () => {
    const routeModules = await Promise.all(
      routeModuleFiles.map(async (sourceFile) => {
        const baseName = sourceFile.replace(/\.ts$/, '');
        const imported = await import(`../../server/routes/${baseName}.js`);
        return { sourceFile, imported, sourcePath: resolve(routeDirectory, sourceFile), requireRegister: true };
      }),
    );
    const pluginModules = await Promise.all(
      pluginModuleFiles.map(async (sourceFile) => {
        const baseName = sourceFile.replace(/\.ts$/, '');
        const imported = await import(`../../server/plugins/${baseName}.js`);
        return { sourceFile: `plugins/${sourceFile}`, imported, sourcePath: resolve(pluginsDirectory, sourceFile), requireRegister: false };
      }),
    );

    const actual: RouteModuleSnapshot = Object.fromEntries(
      [...routeModules, ...pluginModules].map(({ sourceFile, imported, sourcePath, requireRegister }) => {
        if (requireRegister) {
          assert.ok(
            Object.entries(imported).some(
              ([name, value]) => name.startsWith('register') && typeof value === 'function',
            ),
            `${sourceFile} 应导出至少一个 register* 路由函数`,
          );
        }
        const schemaNames = extractSchemaNames(readFileSync(sourcePath, 'utf8'));
        const entries = schemaNames.map((name) => {
          const schema = schemaRegistry[name];
          assert.ok(schema, `未找到路由 ${sourceFile} 使用的 Zod schema: ${name}`);
          return { name, hash: hashSchema(schema) };
        });
        return [sourceFile, entries];
      }),
    );

    const snapshotPath = resolve(
      process.cwd(),
      'src',
      'test',
      'contract',
      '__snapshots__',
      'route-schema-snapshots.json',
    );

    if (process.env['UPDATE_SNAPSHOTS'] === '1') {
      writeFileSync(snapshotPath, JSON.stringify(actual, null, 2) + '\n', 'utf8');
      return;
    }

    assert.ok(
      existsSync(snapshotPath),
      '快照基线不存在。运行 UPDATE_SNAPSHOTS=1 npm run test:contract 生成基线。',
    );

    const expected = JSON.parse(readFileSync(snapshotPath, 'utf8')) as RouteModuleSnapshot;
    assert.deepEqual(actual, expected);
  });
});

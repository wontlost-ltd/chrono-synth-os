/**
 * db-access-inventory 完整性单元测（Plan 0 · Task 3）。
 *
 * 覆盖：
 *  - 每条目 `disposition`/`wiringStatus` 必填非空（升级 sink 级的核心契约——Codex 退回 #10）。
 *  - 已知 sink（A0 §3 第 1-7 类反向扫描已证实的清单）都在 inventory 里能找到对应条目。
 *  - `buildAppServices` 不再是错分类的 `explicit-per-request`（是长期持有 db 能力的 resolver 化候选）。
 *  - `known-limitation` 处置的条目必须有 note 说明「为何不可能错-shard」的理由（非空占位）。
 *
 * 本测试只验证 Task 3 的登记契约（字段必填 + 已知 sink 在册），不是 Task 4 的
 * 「无未登记 edge」硬门（那门由 scanProductionDbCapabilityEdges + collectUnregisteredEdges 把关）。
 *
 * 用 tsx 运行：npx tsx --test src/test/unit/db-access-inventory-completeness.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DB_ACCESS_INVENTORY, type DbAccessPoint } from '../../storage/db-access-inventory.js';

/** 已知必纳入的 sink 文件（spec §3-A0「已知必纳入的 sink」第 1-7 类，反向扫描已证实）。 */
const KNOWN_SINK_FILES = [
  'src/server/app-services.ts', // buildAppServices ~15 成员
  'src/queue/task-queue.ts', // TaskQueue
  'src/privacy/legal-hold-service.ts', // LegalHoldService
  'src/server/services/nudge-push-bridge.ts', // NudgePushBridge
  'src/main-observability-worker.ts', // 独立入口
  'src/billing/settlement-reconciliation-worker.ts', // 跨租户 worker
  'src/workers/dual-write-flush-worker.ts', // 跨租户 worker
  'src/perception/media/media-retention-worker.ts', // 跨租户 worker（GDPR 擦除）
  'src/persona-core/runtime-recovery-worker.ts', // 跨租户 worker
  'src/identity/auth-service.ts', // mixed-scope Auth
];

function findByFile(file: string): DbAccessPoint[] {
  return DB_ACCESS_INVENTORY.filter((p) => p.file === file || p.file.endsWith(`/${file}`));
}

test('inventory 非空', () => {
  assert.ok(DB_ACCESS_INVENTORY.length > 0, 'inventory 不应为空');
});

test('每条目 disposition 必填非空（union 六值之一）', () => {
  const allowed = new Set([
    'resolver',
    'coordinator',
    'mixed-scope',
    'per-shard-worker',
    'root-only',
    'known-limitation',
  ]);
  for (const point of DB_ACCESS_INVENTORY) {
    assert.ok(
      typeof point.disposition === 'string' && point.disposition.length > 0,
      `${point.id} 缺 disposition`,
    );
    assert.ok(
      allowed.has(point.disposition),
      `${point.id} disposition="${point.disposition}" 不在允许的六值集合内`,
    );
  }
});

test('每条目 wiringStatus 必填非空（Plan 0 阶段全应为 planned）', () => {
  const allowed = new Set(['planned', 'wired', 'verified']);
  for (const point of DB_ACCESS_INVENTORY) {
    assert.ok(
      typeof point.wiringStatus === 'string' && point.wiringStatus.length > 0,
      `${point.id} 缺 wiringStatus`,
    );
    assert.ok(
      allowed.has(point.wiringStatus),
      `${point.id} wiringStatus="${point.wiringStatus}" 不在允许集合内`,
    );
  }
});

test('每条目 id 非空且在全表内唯一（edge 级 id 不应重复）', () => {
  const seen = new Set<string>();
  for (const point of DB_ACCESS_INVENTORY) {
    assert.ok(point.id.length > 0, '存在空 id 条目');
    assert.ok(!seen.has(point.id), `id 重复: ${point.id}`);
    seen.add(point.id);
  }
});

for (const file of KNOWN_SINK_FILES) {
  test(`已知 sink 在册: ${file}`, () => {
    const matches = findByFile(file);
    assert.ok(matches.length > 0, `${file} 未在 db-access-inventory.ts 找到任何登记条目`);
  });
}

test('buildAppServices 不再错分类为 explicit-per-request', () => {
  const matches = DB_ACCESS_INVENTORY.filter((p) => p.id.includes('buildAppServices'));
  assert.ok(matches.length > 0, '未找到 buildAppServices 相关条目');
  for (const point of matches) {
    assert.notEqual(
      point.disposition,
      'explicit-per-request',
      `${point.id} 仍标 explicit-per-request——buildAppServices 成员是长期持有 db 能力的服务，应定性为 resolver（或其他六值之一）`,
    );
  }
});

test('known-limitation 条目 note 必须说明「不可能错-shard」的理由（非空占位）', () => {
  const limitations = DB_ACCESS_INVENTORY.filter((p) => p.disposition === 'known-limitation');
  for (const point of limitations) {
    assert.ok(
      typeof point.note === 'string' && point.note.trim().length > 0,
      `${point.id} disposition=known-limitation 但缺 note`,
    );
  }
});

test('Auth service 条目定性为 mixed-scope（同时含平台级定位 + 租户级写，spec §4.1）', () => {
  const authPoints = DB_ACCESS_INVENTORY.filter((p) => p.file.endsWith('identity/auth-service.ts'));
  assert.ok(authPoints.length > 0, '未找到 auth-service 条目');
  for (const point of authPoints) {
    assert.equal(point.disposition, 'mixed-scope', `${point.id} 应定性为 mixed-scope`);
  }
});

test('跨租户 worker（settlement/dual-write-flush/media-retention/runtime-recovery）定性为 per-shard-worker', () => {
  const workerFiles = [
    'billing/settlement-reconciliation-worker.ts',
    'workers/dual-write-flush-worker.ts',
    'perception/media/media-retention-worker.ts',
    'persona-core/runtime-recovery-worker.ts',
  ];
  for (const wf of workerFiles) {
    const matches = DB_ACCESS_INVENTORY.filter((p) => p.file.endsWith(wf));
    assert.ok(matches.length > 0, `${wf} 未在 inventory 找到条目`);
    for (const point of matches) {
      assert.equal(point.disposition, 'per-shard-worker', `${point.id} 应定性为 per-shard-worker`);
    }
  }
});

test('main-observability-worker 独立入口定性为 per-shard-worker（spec §5.1）', () => {
  const matches = DB_ACCESS_INVENTORY.filter((p) => p.file.endsWith('main-observability-worker.ts'));
  assert.ok(matches.length > 0, '未找到 main-observability-worker 条目');
  for (const point of matches) {
    assert.equal(point.disposition, 'per-shard-worker', `${point.id} 应定性为 per-shard-worker`);
  }
});

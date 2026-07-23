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

test('每条目 disposition 必填非空（union 九值之一——Codex 第 9 轮四态扩展）', () => {
  const allowed = new Set([
    'requires-resolver-rewire',
    'resolved-boundary-unproven',
    'coordinator',
    'root-only',
    'terminal-escape',
    'resolver',
    'mixed-scope',
    'per-shard-worker',
    'known-limitation',
  ]);
  for (const point of DB_ACCESS_INVENTORY) {
    assert.ok(
      typeof point.disposition === 'string' && point.disposition.length > 0,
      `${point.id} 缺 disposition`,
    );
    assert.ok(
      allowed.has(point.disposition),
      `${point.id} disposition="${point.disposition}" 不在允许的九值集合内`,
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

/* ============================================================================
 * Task 3 semantic-flow contract 层专项（Codex 第 9 轮聚合契约）。
 *
 * flow contract = 带 coveredEdgeIds 的条目（edge 级主门用）；legacy 条目无 coveredEdgeIds
 * （file 级 ratchet 补充网，不参与这些校验）。
 * ==========================================================================*/

/** 是否 semantic-flow contract（带 coveredEdgeIds）。 */
function isFlowContract(p: DbAccessPoint): boolean {
  return Array.isArray(p.coveredEdgeIds);
}

test('存在 semantic-flow contract 条目（Task 3 升级已落地，非只剩 legacy）', () => {
  const flows = DB_ACCESS_INVENTORY.filter(isFlowContract);
  assert.ok(flows.length > 50, `应有大量 flow contract（实际=${flows.length}），证 Task 3 升级已落地`);
});

test('每条目 provenanceStatus + reviewStatus 必填（多维状态模型）', () => {
  const prov = new Set(['resolved', 'unresolved']);
  const review = new Set(['classified', 'unreviewed']);
  for (const point of DB_ACCESS_INVENTORY) {
    assert.ok(prov.has(point.provenanceStatus), `${point.id} provenanceStatus="${point.provenanceStatus}" 非法`);
    assert.ok(review.has(point.reviewStatus), `${point.id} reviewStatus="${point.reviewStatus}" 非法`);
  }
});

test('禁「scanner 不知→planned→绿」退化：全表 reviewStatus 必须 classified（无 unreviewed）', () => {
  const unreviewed = DB_ACCESS_INVENTORY.filter((p) => p.reviewStatus !== 'classified');
  assert.deepEqual(
    unreviewed.map((p) => p.id),
    [],
    'Plan 0 全须 classified；任何 unreviewed 即门 condition ④ 会红（禁退化）',
  );
});

test('flow contract：expectedCount 精确 === coveredEdgeIds 数（fingerprint，禁通配）', () => {
  for (const point of DB_ACCESS_INVENTORY.filter(isFlowContract)) {
    const ids = point.coveredEdgeIds!;
    assert.equal(
      point.expectedCount,
      ids.length,
      `${point.id} expectedCount=${point.expectedCount} ≠ coveredEdgeIds 数 ${ids.length}`,
    );
    // 禁 owner::* 通配。
    const wildcard = ids.filter((cid) => cid.includes('*'));
    assert.deepEqual(wildcard, [], `${point.id} coveredEdgeIds 含通配（禁）: ${wildcard.join(', ')}`);
    // coveredEdgeIds 应是 edge 级 id（含 ::），非 legacy file 级 id。
    for (const cid of ids) {
      assert.ok(cid.includes('::'), `${point.id} coveredEdgeId 非 edge 级 id: ${cid}`);
    }
  }
});

test('coveredEdgeIds 全表无重复覆盖（一条 edge 至多被一个 flow contract 覆盖）', () => {
  const seen = new Map<string, string>();
  for (const point of DB_ACCESS_INVENTORY.filter(isFlowContract)) {
    for (const cid of point.coveredEdgeIds!) {
      const prev = seen.get(cid);
      assert.ok(!prev, `edge id ${cid} 被多个 flow contract 覆盖: ${prev} + ${point.id}`);
      seen.set(cid, point.id);
    }
  }
});

test('四态处置（requires-resolver-rewire / resolved-boundary-unproven）必有 proofObligation', () => {
  const needsProof = new Set(['requires-resolver-rewire', 'resolved-boundary-unproven', 'terminal-escape']);
  for (const point of DB_ACCESS_INVENTORY.filter((p) => needsProof.has(p.disposition))) {
    assert.ok(
      typeof point.proofObligation === 'string' && point.proofObligation.trim().length > 0,
      `${point.id} disposition=${point.disposition} 须有 proofObligation（后续证明义务）`,
    );
  }
});

test('四态覆盖：inventory 含 requires-resolver-rewire + resolved-boundary-unproven（628 unresolved 工作面）', () => {
  const dispositions = new Set(DB_ACCESS_INVENTORY.map((p) => p.disposition));
  assert.ok(dispositions.has('requires-resolver-rewire'), 'inventory 应含 requires-resolver-rewire（组合根/路由用 host db 造 carrier）');
  assert.ok(dispositions.has('resolved-boundary-unproven'), 'inventory 应含 resolved-boundary-unproven（OS 内核内部 layer 互传）');
});

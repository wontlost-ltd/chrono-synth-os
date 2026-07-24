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

/*
 * 分片 Phase 0 · Plan 1b · Task 10（收尾 · 逐 edge 校准的诚实性回归门）。
 *
 * 校准判据（Plan Global Constraint #3/#6）：
 *   verified = tenant-scoped service 真 resolver 化 + 被 2-shard 行为测（换 home / 删 predicate 两 mutation）覆盖；
 *   wired    = 构造点真接 resolver 但无直接 2-shard 行为覆盖；
 *   planned  = mixed-scope / coordinatorDb / seam / 大 carrier 未真下沉（Plan 1c 及后续）。
 *
 * 诚实性铁律：**绝不**因「Plan 1b 做完」就把整个 buildAppServices / 路由 carrier 标 wired。
 * 下面两组回归断言把 Task 1-8 的正确校准结果钉死——防止未来工作反向 downgrade tenant-scoped
 * service edge，或把携带 seam/coordinator/root-db 能力的 carrier edge 静默 mass-upgrade。
 */

/** Task 1-8 已 resolver 化 + 2-shard 双 mutation 行为测覆盖的 tenant-scoped service 定义 edge。 */
const TENANT_SCOPED_VERIFIED_EDGE_IDS = [
  'src/identity/identity-service.ts#IdentityService::flow::resolver',
  'src/identity/identity-service.ts#IdentityWriter::flow::terminal-escape',
  'src/identity/avatar-service.ts#AvatarService::flow::resolver',
  'src/identity/avatar-service.ts#AvatarWriter::flow::resolver',
  'src/identity/device-avatar-service.ts#DeviceAvatarService::flow::resolver',
  'src/identity/mobile-device-service.ts#MobileDeviceService::flow::resolver',
  'src/identity/collaboration-service.ts#CollaborationService::flow::resolver',
  'src/enterprise/organization-service.ts#OrganizationService::flow::terminal-escape',
  'src/enterprise/admin-control-plane-service.ts#AdminControlPlaneService::flow::resolver',
  'src/knowledge/knowledge-source-service.ts#KnowledgeSourceService::flow::resolver',
  'src/enterprise/tenant-enterprise-profile-service.ts#TenantEnterpriseProfileService::flow::resolver',
  'src/identity/user-profile-service.ts#UserProfileService::flow::resolver',
  'src/billing/api-key-service.ts#ApiKeyService::flow::resolver',
  'src/billing/api-key-service.ts#ApiKeyWriter::flow::resolver',
  'src/billing/api-key-service.ts#ApiKeyWriter::flow::requires-resolver-rewire',
] as const;

/**
 * 构造点/carrier edge：仍携带 seam-tx（MobileDeviceFacade 供 IdentityWriter/AvatarWriter）/
 * coordinatorDb（ScimTenantDirectory/UserEmailDirectory）/root-db（PrivacyService、avatars getTenantOS）/
 * pre-tenant 用户目录（NudgePushBridge deps.db 走 scimQueryUsers/NotificationPreferenceStore）。
 * 这些**不是纯 tenant-scoped resolver 载体**，Task 10 明确保持 planned（seam/coordinator 归 Plan 1c，
 * 大 carrier 下沉归后续 Plan）。任何一条被升为 wired/verified 即违反逐 edge 诚实性判据。
 */
const CARRIER_MUST_STAY_PLANNED_EDGE_IDS = [
  'src/server/app-services.ts#AppServices::flow::resolver',
  'src/server/app-services.ts#buildAppServices::flow::requires-resolver-rewire',
  'src/server/app-services.ts#buildAppServices::flow::terminal-escape',
  'src/identity/mobile-device-facade.ts#MobileDeviceFacade::flow::resolver',
  'src/identity/mobile-device-facade.ts#MobileDeviceFacade.identityWriter::flow::seam',
  'src/identity/mobile-device-facade.ts#MobileDeviceFacade.avatarWriter::flow::seam',
  'src/identity/avatar-autorun-facade.ts#AvatarAutorunFacade::flow::resolver',
  'src/identity/avatar-autorun-facade.ts#AvatarAutorunFacade::flow::requires-resolver-rewire',
  'src/server/services/nudge-push-bridge.ts#NudgePushBridge::flow::resolver',
  'src/server/routes/avatars.ts#registerAvatarRoutes::flow::resolver',
  'src/server/routes/avatars.ts#getTenantOS::flow::requires-resolver-rewire',
  /* Plan 1c Task 9 诚实性保留：这两条 mixed-scope edge **无** auth-mixed-scope-sharding.test.ts 2-shard
   * 覆盖——`SsoUserService.identityWriter::flow::mixed-scope` 是 identityWriter helper 返回 IdentityWriter
   * carrier（provenance=unresolved-carrier）；`deleteUser::flow::mixed-scope` 无 2-shard deleteUser 门。
   * 故保持 planned（升级须先补 2-shard 行为门 + 证明 provenance）。同组已下沉 + 有 2-shard 覆盖的
   * createUser/provisionShardUser/ensureSubscription/findOrCreate* 等已在 Task 9 升 verified（见下清单）。 */
  'src/identity/sso-user-service.ts#SsoUserService.identityWriter::flow::mixed-scope',
  'src/enterprise/scim-provisioning-service.ts#ScimProvisioningService.deleteUser::flow::mixed-scope',
  /* Plan 1c Task 9 诚实性保留：register flow-level + cleanup edge 仍 provenance=unresolved（组合根/静态
   * cleanup 路径 tx provenance 未证明）、无专门 2-shard 门，故保持 planned（register 的 shardDb/
   * syncPlanToQuota **子** edge 已下沉 + 有 2-shard 覆盖，见下清单；flow-level 聚合 edge 不随之升级）。 */
  'src/identity/auth-service.ts#AuthService.register::flow::mixed-scope',
  'src/identity/auth-service.ts#AuthService.cleanupExpired::flow::mixed-scope',
  'src/identity/auth-service.ts#AuthService.cleanupExpiredTokens::flow::mixed-scope',
  'src/privacy/privacy-service.ts#PrivacyService::flow::resolver',
  'src/privacy/privacy-service.ts#PrivacyService.exportData::flow::requires-resolver-rewire',
  'src/privacy/privacy-service.ts#PrivacyService.getOS::flow::requires-resolver-rewire',
] as const;

/**
 * 分片 Phase 0 · Plan 1c Task 9 —— Auth/SSO/SCIM/registerAuth 的 mixed-scope（+ 关联 terminal-escape）
 * edge：**真经协调库目录（directory.resolveByEmail / reservePasswordlessTenant）定位 email→tenant +
 * `resolver.dbForTenant(tenantId)` 写 shard，且被 `auth-mixed-scope-sharding.test.ts` 2-shard
 * FakeMultiShardResolver 行为门覆盖**（跨 shard 注册不串 / 他租户拒 / 目录=定位器 shard=权威）→ 逐 edge
 * 从 planned/wired 升 verified。诚实性铁律（对齐 Plan 1b Task 10 + Global Constraint #3/#6）：仅这些
 * **真下沉 + 有 2-shard 覆盖**的升 verified；deleteUser / cleanup / register-flow-level /
 * identityWriter-mixed-scope（无门或 provenance 未证）仍在 CARRIER_MUST_STAY_PLANNED 保持 planned。
 * id 变更须同步本清单（fingerprint 校验）。
 */
const MIXED_SCOPE_VERIFIED_EDGE_IDS = [
  /* AuthService register 状态机子 edge（测 ①① register 落点 / ⑨ Stripe 事务外，2-shard）。 */
  'src/identity/auth-service.ts#AuthService.register.shardDb::flow::mixed-scope',
  'src/identity/auth-service.ts#AuthService.register.syncPlanToQuota::flow::mixed-scope',
  /* SSO/OIDC 用户创建 + 既有用户订阅/身份写（测 findOrCreateForSso/Oidc 2-shard 落对 shard、跨租户拒）。 */
  'src/identity/sso-user-service.ts#SsoUserService.provisionShardUser::flow::mixed-scope',
  'src/identity/sso-user-service.ts#SsoUserService.ensureSubscription::flow::mixed-scope',
  'src/identity/sso-user-service.ts#SsoUserService.findOrCreateForOidc::flow::mixed-scope',
  'src/identity/sso-user-service.ts#SsoUserService.findOrCreateForSso::flow::mixed-scope',
  'src/identity/sso-user-service.ts#SsoUserService.identityWriter::flow::terminal-escape',
  /* SCIM createUser（测 SCIM createUser 新 email 落对 shard、他租户拒、幂等，2-shard）。 */
  'src/enterprise/scim-provisioning-service.ts#ScimProvisioningService.createUser::flow::mixed-scope',
  /* registerAuth preHandler api_key hash→tenant 目录定位 + shard 验 is_revoked（测 K1/K2/K2b，2-shard）。 */
  'src/server/plugins/auth.ts#registerAuth::flow::terminal-escape',
] as const;

test('Task 10 校准：tenant-scoped service 定义 edge 全为 verified（Task 1-8 结果不回退）', () => {
  for (const id of TENANT_SCOPED_VERIFIED_EDGE_IDS) {
    const point = DB_ACCESS_INVENTORY.find((p) => p.id === id);
    assert.ok(point, `verified 契约 edge 缺失（id 变更须同步本清单）: ${id}`);
    assert.equal(
      point!.wiringStatus,
      'verified',
      `${id} 应保持 verified（Task 1-8 resolver 化 + 2-shard 双 mutation 覆盖），实际=${point!.wiringStatus}`,
    );
  }
});

test('Task 10 诚实性：携带 seam/coordinator/root-db 能力的 carrier edge 必须保持 planned（禁 mass-upgrade）', () => {
  for (const id of CARRIER_MUST_STAY_PLANNED_EDGE_IDS) {
    const point = DB_ACCESS_INVENTORY.find((p) => p.id === id);
    assert.ok(point, `planned 契约 carrier edge 缺失（id 变更须同步本清单）: ${id}`);
    assert.equal(
      point!.wiringStatus,
      'planned',
      `${id} 必须保持 planned（仍携带 seam-tx/coordinatorDb/root-db，非纯 tenant-scoped resolver 载体；` +
        `升级须先真下沉 + 2-shard 覆盖），实际=${point!.wiringStatus}`,
    );
  }
});

test('Task 9 校准：mixed-scope edge 真下沉 + 有 auth-mixed-scope-sharding 2-shard 覆盖 → verified（provenance=resolved）', () => {
  for (const id of MIXED_SCOPE_VERIFIED_EDGE_IDS) {
    const point = DB_ACCESS_INVENTORY.find((p) => p.id === id);
    assert.ok(point, `verified mixed-scope edge 缺失（id 变更须同步本清单）: ${id}`);
    assert.equal(
      point!.wiringStatus,
      'verified',
      `${id} 应为 verified（Plan 1c 真经 directory + dbForTenant + auth-mixed-scope-sharding.test.ts 2-shard 覆盖），实际=${point!.wiringStatus}`,
    );
    /* 诚实性：只有 provenance 已证的 carrier 才允许 verified（unresolved 不得升）。 */
    assert.equal(
      point!.provenanceStatus,
      'resolved',
      `${id} verified 前提须 provenanceStatus=resolved（carrier 来源已证），实际=${point!.provenanceStatus}`,
    );
  }
});

test('Task 9 诚实性互斥：verified mixed-scope 清单与 CARRIER_MUST_STAY_PLANNED 无交集（同一 edge 不能既 verified 又 planned）', () => {
  const planned = new Set<string>(CARRIER_MUST_STAY_PLANNED_EDGE_IDS);
  const overlap = MIXED_SCOPE_VERIFIED_EDGE_IDS.filter((id) => planned.has(id));
  assert.deepEqual(overlap, [], `verified 与 planned 清单交集非空（诚实性违规）: ${overlap.join(', ')}`);
});

/*
 * 分片 Phase 0 · Plan 2 · Task 6（route 内联直查下沉 dbForTenant · 逐 edge 校准的诚实性回归门）。
 *
 * 校准判据（Plan Global Constraint #3/#6，与 Plan 1b Task 10 同）：
 *   verified = tenant-scoped 直查真下沉 resolver.dbForTenant + 被 2-shard 行为测（落对 shard / host 无）覆盖；
 *   wired    = 构造点真接 resolver 但**该 edge**无直接 2-shard 行为覆盖（如 per-shard-worker 的 keyer::db
 *              终点逃逸——db 身份进 WeakMap 仅派生标签，逃逸终点仍待 Plan 3 验证在正确 shard）；
 *   planned  = 未真下沉 / 逃逸未证。
 *
 * 诚实性铁律：**绝不 mass-upgrade**。Task 6 只把**产出可 must-register edge 且有 2-shard 覆盖**的
 * 一条升 verified（admin-deployment vault rotate 的 tenantDb 捕获进事务闭包——route-direct-query-sharding.test.ts
 * 2-shard 覆盖）。decisions/onboarding 的 dbForTenant(tenantId) 直查是**ephemeral（用后即弃，不产
 * must-register edge）**——scanner 不为其产 flow contract，故无「route 直查 edge」可升（下沉本身由行为测钉死，
 * 见 route-direct-query-sharding.test.ts）。onboarding-v2 的 persona_versions 直查已下沉，但目标表列与迁移
 * schema 不匹配（persona_id/version/name 等列迁移未建——pre-existing 缺陷，非本 task 修），该端点在当前
 * schema 下 INSERT 必抛、无法端到端 2-shard 覆盖，故**保持 planned**（诚实：无行为覆盖不升）。
 * 六 worker/timer/metrics 的 per-shard-worker edge 覆盖的是残留逃逸终点（keyer::db / SqliteEventLedger::db），
 * 其 proofObligation 明标「待 Plan 3 验证逃逸终点仍在正确 shard」——fan-out 本身虽有 2-shard 测，但**该 edge**
 * 的逃逸终点未证，故**保持 wired 不升 verified**（Task 1-5 的正确校准，Task 6 不反向 mass-upgrade）。
 */

/** Task 6 真下沉 + 2-shard 行为覆盖 → verified 的 route 直查 edge（唯一一条，产 must-register capture edge）。 */
const ROUTE_DIRECT_QUERY_VERIFIED_FLOW_IDS = [
  'src/server/routes/admin-deployment.ts#rotate::flow::terminal-escape',
] as const;

/**
 * Task 6 诚实性保留 planned/wired 的 route/worker edge：
 *  - onboarding-v2 route（persona_versions 直查已下沉但目标表列缺失，无法端到端 2-shard 覆盖）→ planned；
 *  - decisions/onboarding registerXRoutes flow（仅余 deps.db 遗留声明绑定 edge，非 resolver 直查）→ planned；
 *  - 六 worker/timer/metrics 的 per-shard-worker edge（覆盖残留逃逸终点，Plan 3 才证）→ 保持 wired。
 * 任何一条被静默升 verified 即违反逐 edge 诚实性判据。
 */
const TASK6_MUST_STAY_UNVERIFIED = [
  { id: 'src/server/routes/onboarding-v2.ts#registerOnboardingV2Routes::flow::terminal-escape', want: 'planned' },
  { id: 'src/server/routes/decisions.ts#registerDecisionRoutes::flow::terminal-escape', want: 'planned' },
  { id: 'src/server/routes/onboarding.ts#registerOnboardingRoutes::flow::terminal-escape', want: 'planned' },
  { id: 'src/perception/media/media-retention-worker.ts#MediaRetentionWorker::flow::per-shard-worker', want: 'wired' },
  { id: 'src/workers/dual-write-flush-worker.ts#DualWriteFlushWorker::flow::per-shard-worker', want: 'wired' },
  { id: 'src/billing/settlement-reconciliation-worker.ts#SettlementReconciliationWorker::flow::per-shard-worker', want: 'wired' },
  { id: 'src/persona-core/runtime-recovery-worker.ts#RuntimeRecoveryWorker::flow::per-shard-worker', want: 'wired' },
  { id: 'src/agent/tool-invocations-retention-worker.ts#ToolInvocationsRetentionWorker::flow::per-shard-worker', want: 'wired' },
  { id: 'src/server/app.ts#runDataRetentionOnce::flow::per-shard-worker', want: 'wired' },
  { id: 'src/observability/shard-aggregate.ts#aggregateShards::flow::per-shard-worker', want: 'wired' },
] as const;

test('Task 6 校准：admin-deployment vault rotate tenantDb 直查真下沉 + 2-shard 覆盖 → verified（provenance=resolved）', () => {
  for (const id of ROUTE_DIRECT_QUERY_VERIFIED_FLOW_IDS) {
    const point = DB_ACCESS_INVENTORY.find((p) => p.id === id);
    assert.ok(point, `verified route 直查 edge 缺失（id 变更须同步本清单）: ${id}`);
    assert.equal(
      point!.wiringStatus,
      'verified',
      `${id} 应为 verified（resolver.dbForTenant 直查 + route-direct-query-sharding.test.ts 2-shard 覆盖），实际=${point!.wiringStatus}`,
    );
    assert.equal(
      point!.provenanceStatus,
      'resolved',
      `${id} verified 前提须 provenanceStatus=resolved，实际=${point!.provenanceStatus}`,
    );
  }
});

test('Task 6 诚实性：onboarding-v2/route carrier/per-shard-worker escape edge 保持 planned/wired（禁 mass-upgrade）', () => {
  for (const { id, want } of TASK6_MUST_STAY_UNVERIFIED) {
    const point = DB_ACCESS_INVENTORY.find((p) => p.id === id);
    assert.ok(point, `诚实性契约 edge 缺失（id 变更须同步本清单）: ${id}`);
    assert.notEqual(
      point!.wiringStatus,
      'verified',
      `${id} 必须保持非-verified（${want}）——onboarding-v2 无端到端 2-shard 覆盖 / route deps.db 遗留声明 / ` +
        `per-shard-worker 覆盖残留逃逸终点待 Plan 3；升 verified 违反逐 edge 诚实性判据，实际=${point!.wiringStatus}`,
    );
    assert.equal(
      point!.wiringStatus,
      want,
      `${id} 应保持 ${want}，实际=${point!.wiringStatus}`,
    );
  }
});

test('Task 6 诚实性互斥：verified route 清单与 must-stay-unverified 清单无交集', () => {
  const unverified = new Set<string>(TASK6_MUST_STAY_UNVERIFIED.map((x) => x.id));
  const overlap = ROUTE_DIRECT_QUERY_VERIFIED_FLOW_IDS.filter((id) => unverified.has(id));
  assert.deepEqual(overlap, [], `verified 与 must-stay-unverified 清单交集非空（诚实性违规）: ${overlap.join(', ')}`);
});

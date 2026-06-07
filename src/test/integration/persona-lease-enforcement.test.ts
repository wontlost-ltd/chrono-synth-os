/**
 * ADR-0047 + ADR-0048：per-persona 锁在两个真实消费方生效（集成）。
 *
 * compile mutex：另一持有者占着 persona 的 compile 锁时，DistillationService.approve
 *   不应执行编译——工件留在 approved 待重试，核心不被写（快照未触发）。
 * earning lease：另一持有者占着 persona 的 earning 锁时，runEarningCycle 直接跳过
 *   （返回空结果，不读 exposure、不申请）。
 *
 * 用真实 DB + 真实 PersonaLeaseStore + 真实 DistilledArtifactStore，仅对编译器/
 * 快照/marketplace 用最小桩，隔离验证「锁」这一关。
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import type { IDatabase } from '../../storage/database.js';
import { PersonaLeaseStore } from '../../storage/persona-lease-store.js';
import { DistilledArtifactStore } from '../../storage/distilled-artifact-store.js';
import { DistillationService, type SnapshotGuard } from '../../intelligence/distillation-service.js';
import type { ArtifactCompiler, CompileOutcome } from '../../intelligence/artifact-compiler.js';
import { PersonaEarningService } from '../../intelligence/persona-earning-service.js';
import type { PersonaCoreService } from '../../persona-core/persona-core-service.js';
import type { DecisionEngine } from '../../intelligence/decision-engine.js';
import type { ToolInvocationPipeline } from '../../agent/tool-invocation-pipeline.js';
import { EventBus } from '../../events/event-bus.js';
import { TestClock, SilentLogger } from '../../utils/index.js';
import { GLOBAL_LEASE_PERSONA_ID } from '@chrono/kernel';
import { SqliteDatabase } from '../../storage/database.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const TENANT = 'default';
const PERSONA = 'persona_lease_it';

describe('PersonaLease enforcement in real consumers (ADR-0047/0048)', () => {
  let db: IDatabase;
  let leases: PersonaLeaseStore;

  beforeEach(() => {
    db = createMemoryDatabase();
    runDslSqliteMigrations(db);
    leases = new PersonaLeaseStore(db, TENANT);
  });

  /* ── compile mutex ── */

  it('compile 锁被占用 → approve 不编译，工件留 approved，快照未触发', () => {
    const store = new DistilledArtifactStore(db, TENANT);
    /* 落一个 candidate（合法 value_shift） */
    store.insert(PERSONA, {
      id: 'dart-lease', kind: 'value_shift', source: 'reflection',
      payload: { valueId: 'v1', currentWeight: 0.5, suggestedWeight: 0.51, delta: 0.01, patternAgrees: true },
      confidence: 0.9,
      evidence: [{ type: 'pattern', id: 'e1', score: 0.8 }, { type: 'memory', id: 'm1', score: 0.6 }],
      status: 'candidate', createdAt: 1000,
    });

    let snapshotTaken = false;
    let compiled = false;
    const guard: SnapshotGuard = { snapshot: () => { snapshotTaken = true; return 'snap'; }, rollback: () => true };
    const compiler = { compile: (): CompileOutcome => { compiled = true; return { ok: true, applied: 'x' }; } } as unknown as ArtifactCompiler;

    const svc = new DistillationService({
      store, compiler, snapshotGuard: guard,
      bus: new EventBus(), clock: new TestClock(1000), logger: new SilentLogger(),
      tenantId: TENANT, leaseStore: leases,
    });

    /* 另一实例先占住【全局】compile 锁（compile 走全局快照，锁是租户级而非 per-persona） */
    const held = leases.acquire(GLOBAL_LEASE_PERSONA_ID, 'compile', 1000, 60_000);
    assert.ok(held, 'precondition: hold the global compile lease');

    const r = svc.approve(PERSONA, 'dart-lease');
    assert.equal(r.ok, false, 'approve should not complete compile while global lease held');
    assert.match(r.ok ? '' : r.reason, /lease busy/i, 'reason should indicate lease busy, not compile failure');
    assert.equal(snapshotTaken, false, 'snapshot must NOT be taken when compile lease unavailable');
    assert.equal(compiled, false, 'compiler must NOT run when compile lease unavailable');
    /* 工件已 candidate→approved（approve 自身推进），但未到 compiled；留待重试 */
    assert.equal(store.getById(PERSONA, 'dart-lease')?.status, 'approved');
  });

  it('compile 锁释放后 → approve 正常编译到 compiled', () => {
    const store = new DistilledArtifactStore(db, TENANT);
    store.insert(PERSONA, {
      id: 'dart-ok', kind: 'value_shift', source: 'reflection',
      payload: { valueId: 'v1', currentWeight: 0.5, suggestedWeight: 0.51, delta: 0.01, patternAgrees: true },
      confidence: 0.9,
      evidence: [{ type: 'pattern', id: 'e1', score: 0.8 }, { type: 'memory', id: 'm1', score: 0.6 }],
      status: 'candidate', createdAt: 1000,
    });
    const guard: SnapshotGuard = { snapshot: () => 'snap', rollback: () => true };
    const compiler = { compile: (): CompileOutcome => ({ ok: true, applied: 'x' }) } as unknown as ArtifactCompiler;
    const svc = new DistillationService({
      store, compiler, snapshotGuard: guard,
      bus: new EventBus(), clock: new TestClock(1000), logger: new SilentLogger(),
      tenantId: TENANT, leaseStore: leases,
    });

    /* 无人占锁 → 正常编译；并且编译期间全局 compile 锁应被本服务持有再释放 */
    const r = svc.approve(PERSONA, 'dart-ok');
    assert.equal(r.ok, true);
    assert.equal(store.getById(PERSONA, 'dart-ok')?.status, 'compiled');
    /* 编译结束全局锁已释放：可立即再获取 */
    assert.ok(leases.acquire(GLOBAL_LEASE_PERSONA_ID, 'compile', 2000, 60_000), 'global compile lease released after compile');
  });

  it('跨 persona 全局互斥：persona B 占住全局 compile 锁 → persona A 的 approve 被挡（防全局快照覆盖）', () => {
    const store = new DistilledArtifactStore(db, TENANT);
    const personaA = 'persona_A';
    store.insert(personaA, {
      id: 'dart-A', kind: 'value_shift', source: 'reflection',
      payload: { valueId: 'v1', currentWeight: 0.5, suggestedWeight: 0.51, delta: 0.01, patternAgrees: true },
      confidence: 0.9,
      evidence: [{ type: 'pattern', id: 'e1', score: 0.8 }, { type: 'memory', id: 'm1', score: 0.6 }],
      status: 'candidate', createdAt: 1000,
    });
    let snapshotTaken = false;
    const guard: SnapshotGuard = { snapshot: () => { snapshotTaken = true; return 'snap'; }, rollback: () => true };
    const compiler = { compile: (): CompileOutcome => ({ ok: true, applied: 'x' }) } as unknown as ArtifactCompiler;
    const svc = new DistillationService({
      store, compiler, snapshotGuard: guard,
      bus: new EventBus(), clock: new TestClock(1000), logger: new SilentLogger(),
      tenantId: TENANT, leaseStore: leases,
    });

    /* persona B 的编译正占着全局锁（用 GLOBAL sentinel，模拟另一 persona 正在编译） */
    const heldByB = leases.acquire(GLOBAL_LEASE_PERSONA_ID, 'compile', 1000, 60_000);
    assert.ok(heldByB);

    /* persona A 的 approve 必须被同一把全局锁挡住——这正是 per-persona 锁会漏掉、
     * 而全局锁修复的核心场景（防 A/B 并发覆盖 system-global 快照） */
    const r = svc.approve(personaA, 'dart-A');
    assert.equal(r.ok, false);
    assert.equal(snapshotTaken, false, 'A must not snapshot while B holds the global compile lease');
    assert.equal(store.getById(personaA, 'dart-A')?.status, 'approved');
  });

  it('lease_busy 重试路径：锁释放后再次 approve（工件已 approved）→ 成功编译到 compiled', () => {
    const store = new DistilledArtifactStore(db, TENANT);
    store.insert(PERSONA, {
      id: 'dart-retry', kind: 'value_shift', source: 'reflection',
      payload: { valueId: 'v1', currentWeight: 0.5, suggestedWeight: 0.51, delta: 0.01, patternAgrees: true },
      confidence: 0.9,
      evidence: [{ type: 'pattern', id: 'e1', score: 0.8 }, { type: 'memory', id: 'm1', score: 0.6 }],
      status: 'candidate', createdAt: 1000,
    });
    const guard: SnapshotGuard = { snapshot: () => 'snap', rollback: () => true };
    const compiler = { compile: (): CompileOutcome => ({ ok: true, applied: 'x' }) } as unknown as ArtifactCompiler;
    const svc = new DistillationService({
      store, compiler, snapshotGuard: guard,
      bus: new EventBus(), clock: new TestClock(1000), logger: new SilentLogger(),
      tenantId: TENANT, leaseStore: leases,
    });

    /* 第一次：全局锁被占 → approve 失败，工件留 approved（lease_busy） */
    const blocker = leases.acquire(GLOBAL_LEASE_PERSONA_ID, 'compile', 1000, 60_000);
    assert.ok(blocker);
    const first = svc.approve(PERSONA, 'dart-retry');
    assert.equal(first.ok, false);
    assert.match(first.ok ? '' : first.reason, /lease busy/i);
    assert.equal(store.getById(PERSONA, 'dart-retry')?.status, 'approved', 'left approved for retry');

    /* 释放锁后再次 approve（工件已 approved）→ 走重试路径直接编译成功 */
    assert.ok(leases.release(blocker!));
    const retry = svc.approve(PERSONA, 'dart-retry');
    assert.equal(retry.ok, true, 'retry after lock release must compile');
    assert.equal(store.getById(PERSONA, 'dart-retry')?.status, 'compiled');
  });

  /* ── earning lease ── */

  it('earning 锁被占用 → runEarningCycle 跳过（空结果，不读 exposure/不申请）', async () => {
    let listOpenCalled = false;
    const personaCore = {
      getPersonaDetail: () => ({ status: 'active', reputation: 0.8 }),
      listMarketplaceTasks: () => { listOpenCalled = true; return []; },
    } as unknown as PersonaCoreService;
    const decisionEngine = { evaluate: async () => ({ recommendedAlternative: '跳过任务' }) } as unknown as DecisionEngine;
    let pipelineInvoked = false;
    const pipeline = { invoke: async () => { pipelineInvoked = true; return { ok: true }; } } as unknown as ToolInvocationPipeline;

    const svc = new PersonaEarningService({
      personaCore, decisionEngine, pipeline,
      bus: new EventBus(), clock: new TestClock(5000), logger: new SilentLogger(),
      leaseStore: leases,
    });

    /* 另一实例占住 earning 锁 */
    const held = leases.acquire(PERSONA, 'earning', 5000, 120_000);
    assert.ok(held, 'precondition: hold the earning lease');

    const result = await svc.runEarningCycle({ tenantId: TENANT, personaId: PERSONA, ownerUserId: 'u_owner' });
    assert.equal(result.applied, 0);
    assert.equal(result.scanned, 0);
    assert.equal(listOpenCalled, false, 'must not even list open tasks when earning lease unavailable');
    assert.equal(pipelineInvoked, false, 'must not apply when earning lease unavailable');
  });

  it('earning 锁可用 → runEarningCycle 正常执行（读任务）并在结束后释放锁', async () => {
    let listOpenCalled = false;
    const personaCore = {
      getPersonaDetail: () => ({ status: 'active', reputation: 0.8 }),
      listMarketplaceTasks: () => { listOpenCalled = true; return []; },
    } as unknown as PersonaCoreService;
    const decisionEngine = { evaluate: async () => ({ recommendedAlternative: '跳过任务' }) } as unknown as DecisionEngine;
    const pipeline = { invoke: async () => ({ ok: true }) } as unknown as ToolInvocationPipeline;

    const svc = new PersonaEarningService({
      personaCore, decisionEngine, pipeline,
      bus: new EventBus(), clock: new TestClock(5000), logger: new SilentLogger(),
      leaseStore: leases,
    });

    const result = await svc.runEarningCycle({ tenantId: TENANT, personaId: PERSONA, ownerUserId: 'u_owner' });
    assert.equal(listOpenCalled, true, 'cycle ran (listed open tasks)');
    assert.equal(result.applied, 0); /* 无开放任务 */
    /* 周期结束 earning 锁已释放 */
    assert.ok(leases.acquire(PERSONA, 'earning', 6000, 120_000), 'earning lease released after cycle');
  });
});

/**
 * 真实双连接并发：两个独立 SqliteDatabase 连接同一文件 DB，同时抢占同一把已过期的锁，
 * 断言恰好一个 rowsAffected=1（DB 行锁/唯一主键保证 CAS 原子性，非应用层假并发）。
 * 这是 Codex 复审要求的「真实双连接」用例，证明 acquire 的互斥不是 mock 出来的。
 */
describe('PersonaLease CAS atomicity under two real DB connections (SQLite file)', () => {
  let dbPath: string;
  let connA: SqliteDatabase;
  let connB: SqliteDatabase;

  beforeEach(() => {
    dbPath = join(tmpdir(), `persona-lease-cas-${randomUUID()}.sqlite`);
    /* 用一个连接建表（跑全量 DSL 迁移），随后两个连接共享该文件 */
    const setup = new SqliteDatabase(dbPath);
    runDslSqliteMigrations(setup);
    setup.close();
    connA = new SqliteDatabase(dbPath);
    connB = new SqliteDatabase(dbPath);
  });

  afterEach(() => {
    connA.close();
    connB.close();
    rmSync(dbPath, { force: true });
    rmSync(`${dbPath}-journal`, { force: true });
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
  });

  it('两个连接抢同一已过期锁：恰好一个成功', () => {
    const storeA = new PersonaLeaseStore(connA, TENANT);
    const storeB = new PersonaLeaseStore(connB, TENANT);

    /* 先由 A 放一把会过期的锁 */
    const t0 = 1_000_000;
    assert.ok(storeA.acquire(PERSONA, 'earning', t0, 10_000));

    /* 过期后，A 和 B 在同一时刻各自尝试抢占 */
    const now = t0 + 20_000;
    const a = storeA.acquire(PERSONA, 'earning', now, 60_000);
    const b = storeB.acquire(PERSONA, 'earning', now, 60_000);

    /* 恰好一个拿到（另一个 CAS 的 WHERE expires_at<=now 在第一个已写入后不再命中） */
    const winners = [a, b].filter((h) => h !== null);
    assert.equal(winners.length, 1, `exactly one connection must win, got ${winners.length}`);
  });

  it('两个连接抢初始空锁（首次 acquire）：恰好一个成功，另一个因唯一主键冲突失败', () => {
    const storeA = new PersonaLeaseStore(connA, TENANT);
    const storeB = new PersonaLeaseStore(connB, TENANT);
    const now = 2_000_000;
    /* 无既有行：第一个 INSERT 成功；第二个撞主键 (tenant,persona,purpose)，
     * ON CONFLICT DO UPDATE 的 WHERE expires_at<=now 对刚插入的未过期行不命中 → 0 行 */
    const a = storeA.acquire(PERSONA, 'compile', now, 60_000);
    const b = storeB.acquire(PERSONA, 'compile', now, 60_000);
    const winners = [a, b].filter((h) => h !== null);
    assert.equal(winners.length, 1, `exactly one connection must win the fresh lock, got ${winners.length}`);
  });
});

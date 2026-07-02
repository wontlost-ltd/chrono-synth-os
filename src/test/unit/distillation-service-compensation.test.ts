/**
 * ADR-0047：DistillationService 编译后补偿路径单元测试。
 * 用 mock store/compiler/snapshotGuard 隔离验证：编译已应用但工件状态推进失败
 * （返回 false 或抛异常）时，必须回滚核心写 + 标记终态，不留 approved 悬挂。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../../events/event-bus.js';
import { TestClock, SilentLogger } from '../../utils/index.js';
import { DistillationService, NEEDS_REPAIR_REASON_PREFIX, type SnapshotGuard } from '../../intelligence/distillation-service.js';
import type { ArtifactCompiler, CompileOutcome } from '../../intelligence/artifact-compiler.js';
import type { DistilledArtifactStore } from '../../storage/distilled-artifact-store.js';
import { DEFAULT_DISTILLATION_POLICY, type DistilledArtifact, type ArtifactStatus } from '@chrono/kernel';

const VALID_PAYLOAD = { valueId: 'v1', currentWeight: 0.5, suggestedWeight: 0.51, delta: 0.01, patternAgrees: true };

function makeCandidate(): DistilledArtifact {
  return {
    id: 'dart-x', kind: 'value_shift', source: 'reflection',
    payload: VALID_PAYLOAD, confidence: 0.9,
    evidence: [{ type: 'pattern', id: 'e1', score: 0.8 }, { type: 'memory', id: 'm1', score: 0.6 }],
    status: 'candidate', createdAt: 1000,
  };
}

/** 可编排的 mock store：记录 setStatus 调用，可让某次 compiled 推进抛错/返回 false */
class MockStore {
  artifact: DistilledArtifact = makeCandidate();
  setStatusCalls: Array<{ to: ArtifactStatus; from: ArtifactStatus }> = [];
  compiledBehavior: 'ok' | 'false' | 'throw' = 'ok';

  insert(): void { /* no-op */ }
  getById(): DistilledArtifact { return this.artifact; }
  listByPersona(): DistilledArtifact[] { return [this.artifact]; }
  listByStatus(): DistilledArtifact[] { return this.artifact.status === 'candidate' ? [this.artifact] : []; }

  setStatus(_personaId: string, _id: string, from: ArtifactStatus, to: ArtifactStatus, reason?: string | null): boolean {
    this.setStatusCalls.push({ from, to });
    if (to === 'compiled') {
      if (this.compiledBehavior === 'throw') throw new Error('simulated DB lock on compiled advance');
      if (this.compiledBehavior === 'false') return false;
    }
    /* CAS：仅当当前状态匹配 from 才推进（贴近真实 store 语义，供 F3 自转移 approved→approved 写 reason 测试）。 */
    if (this.artifact.status !== from) return false;
    this.artifact = { ...this.artifact, status: to, ...(reason != null ? { reason } : {}) };
    return true;
  }
}

function buildService(store: MockStore, compileOutcome: CompileOutcome, guard: SnapshotGuard) {
  /* 签名与真实 compile(personaId, artifact) 对齐，防未来签名漂移被 mock 掩盖 */
  const compiler = { compile: (_personaId: string, _artifact: DistilledArtifact) => compileOutcome } as unknown as ArtifactCompiler;
  return new DistillationService({
    store: store as unknown as DistilledArtifactStore,
    compiler,
    snapshotGuard: guard,
    bus: new EventBus(),
    clock: new TestClock(1000),
    logger: new SilentLogger(),
  });
}

describe('DistillationService compile compensation (ADR-0047)', () => {
  const okOutcome: CompileOutcome = { ok: true, applied: 'value v1 weight=0.51' };

  it('compiled 推进抛异常 → 回滚 + 标记 rejected（不留 approved 悬挂）', () => {
    const store = new MockStore();
    store.compiledBehavior = 'throw';
    let rolledBack = false;
    const guard: SnapshotGuard = { snapshot: () => 'snap-1', rollback: () => { rolledBack = true; return true; } };
    const svc = buildService(store, okOutcome, guard);

    const r = svc.approve('p1', 'dart-x');
    assert.equal(r.ok, false);
    assert.ok(rolledBack, '编译后异常必须触发回滚');
    /* 最终标记为 rejected，不是 approved 悬挂 */
    assert.equal(store.artifact.status, 'rejected');
    assert.ok(store.setStatusCalls.some((c) => c.to === 'rejected'));
  });

  it('compiled 推进返回 false（并发）→ 回滚 + 标记 rejected', () => {
    const store = new MockStore();
    store.compiledBehavior = 'false';
    let rolledBack = false;
    const guard: SnapshotGuard = { snapshot: () => 'snap-1', rollback: () => { rolledBack = true; return true; } };
    const svc = buildService(store, okOutcome, guard);

    const r = svc.approve('p1', 'dart-x');
    assert.equal(r.ok, false);
    assert.ok(rolledBack);
    assert.equal(store.artifact.status, 'rejected');
  });

  it('编译失败 → 回滚 + rejected，不发 compiled', () => {
    const store = new MockStore();
    let rolledBack = false;
    const guard: SnapshotGuard = { snapshot: () => 'snap-1', rollback: () => { rolledBack = true; return true; } };
    const svc = buildService(store, { ok: false, reason: 'value not found' }, guard);

    const r = svc.approve('p1', 'dart-x');
    assert.equal(r.ok, false);
    assert.ok(rolledBack);
    assert.equal(store.artifact.status, 'rejected');
  });

  it('正常路径 → compiled，无回滚', () => {
    const store = new MockStore();
    let rolledBack = false;
    const guard: SnapshotGuard = { snapshot: () => 'snap-1', rollback: () => { rolledBack = true; return true; } };
    const svc = buildService(store, okOutcome, guard);

    const r = svc.approve('p1', 'dart-x');
    assert.equal(r.ok, true);
    assert.equal(rolledBack, false);
    assert.equal(store.artifact.status, 'compiled');
  });

  it('补偿时回滚抛异常/失败 → 不冒泡，且**绝不**标 rejected（保留 approved 作待修信号，F3）', () => {
    /* 全维评审 F3：回滚失败 = 核心可能已脏。若此时仍标 rejected，会造成「假了结」掩盖核心不一致
     * （比悬挂 approved 更危险，巡检看不到）。修复后契约=回滚失败 → 保留 approved，不 reject。 */
    const store = new MockStore();
    store.compiledBehavior = 'throw';
    const guard: SnapshotGuard = { snapshot: () => 'snap-1', rollback: () => { throw new Error('rollback also failed'); } };
    const svc = buildService(store, okOutcome, guard);
    /* 不应抛出——补偿是 best-effort，吞掉并记录 */
    const r = svc.approve('p1', 'dart-x');
    assert.equal(r.ok, false);
    /* 回滚失败 → **不**标 rejected，工件保留 approved 作为可见待修信号。 */
    assert.ok(!store.setStatusCalls.some((c) => c.to === 'rejected'), '回滚失败时绝不标 rejected');
    assert.equal(store.artifact.status, 'approved', '回滚失败 → 保留 approved 待人工/巡检修复');
  });

  it('补偿时回滚成功 → 才标 rejected 收尾（回滚成功是标终态的前提，F3）', () => {
    const store = new MockStore();
    store.compiledBehavior = 'throw';
    let rolledBack = false;
    const guard: SnapshotGuard = { snapshot: () => 'snap-1', rollback: () => { rolledBack = true; return true; } };
    const svc = buildService(store, okOutcome, guard);
    const r = svc.approve('p1', 'dart-x');
    assert.equal(r.ok, false);
    assert.ok(rolledBack, '回滚成功');
    /* 回滚成功 → 标 rejected 收尾（核心已复原，安全）。 */
    assert.ok(store.setStatusCalls.some((c) => c.to === 'rejected'), '回滚成功后标 rejected');
    assert.equal(store.artifact.status, 'rejected');
  });

  it('★F3 待修守卫★：回滚失败 → 工件打 NEEDS_REPAIR 标记（仍 approved），且 approve() 拒绝重编译', () => {
    /* debt 收口：回滚失败的 approved 工件核心可能已脏，须与「干净可重试 approved」区分——用 reason 前缀标记，
     * approve() 见标记即拒绝重编译（避免在可能不一致的核心上二次编译加剧污染）。 */
    const store = new MockStore();
    store.compiledBehavior = 'throw';            /* 编译后状态推进抛错 → 触发补偿 */
    const guard: SnapshotGuard = { snapshot: () => 'snap-1', rollback: () => false }; /* 回滚失败 */
    const svc = buildService(store, okOutcome, guard);

    const first = svc.approve('p1', 'dart-x');
    assert.equal(first.ok, false);
    /* 工件仍 approved（未标 rejected），且 reason 带 NEEDS_REPAIR 前缀。 */
    assert.equal(store.artifact.status, 'approved', '回滚失败保留 approved');
    assert.ok(store.artifact.reason?.startsWith(NEEDS_REPAIR_REASON_PREFIX), 'reason 带待修标记');
    assert.ok(!store.setStatusCalls.some((c) => c.to === 'rejected'), '回滚失败不标 rejected');

    /* 再次 approve（模拟人工/巡检误触重试）→ 被待修守卫拒绝，不重编译。 */
    store.compiledBehavior = 'ok';               /* 即便这次编译能成，也不该走到 */
    const retry = svc.approve('p1', 'dart-x');
    assert.equal(retry.ok, false, 'NEEDS_REPAIR 工件拒绝重编译');
    if (!retry.ok) assert.match(retry.reason, /needs repair/i);
    assert.notEqual(store.artifact.status, 'compiled', '待修工件绝不被重编译进核心');
  });
});

/* ── 不确定性预算 TOCTOU 回归（功能评审 Codex 确认 High）：预算权威判定必须在 compile 锁**内**。
 *    旧实现在锁外读 count 再抢锁编译——多实例各读 count<预算、各自过关、各自编译，绕过上限。
 *    这里用可编排的 lease/store mock 断言：① 预算 count 的**权威判定发生在持锁期间**；
 *    ② 两实例共享 store+lease、预算=1 时只有一个 auto-compile，第二个降级 pending。 ── */
describe('DistillationService 不确定性预算 TOCTOU（锁内权威判定）', () => {
  const okOutcome: CompileOutcome = { ok: true, applied: 'value v weight+' };

  /** 记录 acquire/release/countAutoCompiledSince 调用顺序的可编排 mock。 */
  class SharedLease {
    held = false;
    events: string[] = [];
    countCalls: Array<{ atHeld: boolean }> = [];
    acquire(): { token: string } | null {
      if (this.held) { this.events.push('acquire-fail'); return null; }
      this.held = true; this.events.push('acquire'); return { token: 't' };
    }
    release(): void { this.held = false; this.events.push('release'); }
  }

  /** 多工件 store：countAutoCompiledSince 反映已 compiled(auto) 的工件数（供锁内复核）。 */
  class BudgetStore {
    arts = new Map<string, DistilledArtifact>();
    constructor(private readonly lease: SharedLease) {}
    insert(_p: string, a: DistilledArtifact): void { this.arts.set(a.id, { ...a }); }
    getById(_p: string, id: string): DistilledArtifact | undefined { return this.arts.get(id); }
    listByPersona(): DistilledArtifact[] { return [...this.arts.values()]; }
    listByStatus(_p: string, s: ArtifactStatus): DistilledArtifact[] { return [...this.arts.values()].filter((a) => a.status === s); }
    setStatus(_p: string, id: string, from: ArtifactStatus, to: ArtifactStatus, _r: string | null, at: number | null): boolean {
      const a = this.arts.get(id);
      if (!a || a.status !== from) return false;
      this.arts.set(id, { ...a, status: to, ...(at != null ? { compiledAt: at } : {}) });
      return true;
    }
    countAutoCompiledSince(): number {
      /* 记录本次 count 判定时锁是否被持有——权威判定必须在持锁期间。 */
      this.lease.countCalls.push({ atHeld: this.lease.held });
      return [...this.arts.values()].filter((a) => a.status === 'compiled').length;
    }
  }

  function candidate(id: string, valueId: string): DistilledArtifact {
    return {
      id, kind: 'value_shift', source: 'reflection',
      payload: { valueId, currentWeight: 0.5, suggestedWeight: 0.51, delta: 0.01, patternAgrees: true },
      confidence: 0.9,
      evidence: [{ type: 'pattern', id: 'e1', score: 0.8 }, { type: 'memory', id: 'm1', score: 0.6 }],
      status: 'candidate', createdAt: 1000,
    };
  }

  function build(lease: SharedLease, store: BudgetStore) {
    const compiler = { compile: (_p: string, _a: DistilledArtifact) => okOutcome } as unknown as ArtifactCompiler;
    const guard: SnapshotGuard = { snapshot: () => 'snap', rollback: () => true };
    return new DistillationService({
      store: store as unknown as DistilledArtifactStore,
      compiler, snapshotGuard: guard,
      bus: new EventBus(), clock: new TestClock(1000), logger: new SilentLogger(),
      /* 用默认 policy 全量阈值（valueShift/memoryEdge 门），仅收紧预算到 1——否则缺阈值门恒不 auto。 */
      policy: { ...DEFAULT_DISTILLATION_POLICY, unverifiedGrowthBudgetPerWindow: 1 },
      leaseStore: { acquire: () => lease.acquire(), release: () => lease.release() } as never,
    });
  }

  it('预算 count 的权威判定发生在持锁期间（非锁外）', () => {
    const lease = new SharedLease();
    const store = new BudgetStore(lease);
    const svc = build(lease, store);
    const r = svc.ingest('default', {
      kind: 'value_shift', source: 'reflection',
      payload: { valueId: 'v1', currentWeight: 0.5, suggestedWeight: 0.51, delta: 0.01, patternAgrees: true },
      confidence: 0.9, evidence: [{ type: 'pattern', id: 'e1', score: 0.8 }, { type: 'memory', id: 'm1', score: 0.6 }],
    });
    assert.equal(r.status, 'compiled', '预算内第 1 条应编译');
    /* 至少有一次 count 判定发生在持锁期间——这是权威判定（锁外快速短路可有可无）。 */
    assert.ok(lease.countCalls.some((c) => c.atHeld), '预算权威判定必须在 compile 锁内');
  });

  it('两实例共享 store+lease、预算=1 → 只有一个 auto-compile，第二个降级 pending（无绕过）', () => {
    const lease = new SharedLease();
    const store = new BudgetStore(lease);
    /* 两个独立 service 实例，共享同一 store + 同一 lease（模拟两个应用进程）。 */
    const svcA = build(lease, store);
    const svcB = build(lease, store);
    /* 两工件都先落库为 candidate（共享 store），模拟并发到达。 */
    store.insert('default', candidate('dart-a', 'va'));
    store.insert('default', candidate('dart-b', 'vb'));
    /* A 先编译（拿锁→锁内复核 count=0<1→编译→count=1）；B 再编译（锁内复核 count=1≥1→降级）。 */
    const outA = svcA.ingest('default', {
      kind: 'value_shift', source: 'reflection',
      payload: { valueId: 'vc', currentWeight: 0.5, suggestedWeight: 0.51, delta: 0.01, patternAgrees: true },
      confidence: 0.9, evidence: [{ type: 'pattern', id: 'e1', score: 0.8 }, { type: 'memory', id: 'm1', score: 0.6 }],
    });
    const outB = svcB.ingest('default', {
      kind: 'value_shift', source: 'reflection',
      payload: { valueId: 'vd', currentWeight: 0.5, suggestedWeight: 0.51, delta: 0.01, patternAgrees: true },
      confidence: 0.9, evidence: [{ type: 'pattern', id: 'e1', score: 0.8 }, { type: 'memory', id: 'm1', score: 0.6 }],
    });
    const statuses = [outA.status, outB.status].sort();
    assert.deepEqual(statuses, ['compiled', 'pending'], '预算=1：恰好一个 compiled 一个降级 pending，无绕过');
    /* 最终 store 里 compiled(auto) 数不超过预算 1。 */
    const autoCompiled = [...store.arts.values()].filter((a) => a.status === 'compiled').length;
    assert.equal(autoCompiled, 1, '实际落库的 auto-compiled 数不得超过预算上限');
  });

  it('lease_busy 契约：拿不到锁 → 工件仍留 candidate（不谎报 approved，Codex 复审）', () => {
    /* TOCTOU 修复后 candidate→approved 推进移进锁内；拿不到锁的路径未进锁，工件必须仍是 candidate。
     * 回归旧 bug：旧代码在锁外先 approved 再抢锁，lease_busy 时返回 approved 是准确的；移进锁内后若仍返回
     * approved 就成了谎报（DB 实为 candidate）。本测锁定修复后的诚实契约。 */
    const lease = new SharedLease();
    const store = new BudgetStore(lease);
    const svc = build(lease, store);
    /* 预先占死锁（模拟另一实例/persona 正在编译）→ 本次 acquire 必失败。 */
    assert.ok(lease.acquire(), '预占锁');
    const r = svc.ingest('default', {
      kind: 'value_shift', source: 'reflection',
      payload: { valueId: 'v9', currentWeight: 0.5, suggestedWeight: 0.51, delta: 0.01, patternAgrees: true },
      confidence: 0.9, evidence: [{ type: 'pattern', id: 'e1', score: 0.8 }, { type: 'memory', id: 'm1', score: 0.6 }],
    });
    assert.equal(r.status, 'pending', 'lease 被占 → pending（非失败）');
    if (r.status !== 'pending') return;
    /* 返回的工件状态必须是 candidate（诚实反映 DB），不是谎报的 approved。 */
    assert.equal(r.artifact.status, 'candidate', 'lease_busy 返回工件必须仍是 candidate');
    /* DB 里该工件确实仍是 candidate（未被推进到 approved）。 */
    assert.equal(store.getById('default', r.artifact.id)?.status, 'candidate', 'DB 实际状态仍是 candidate');
  });
});

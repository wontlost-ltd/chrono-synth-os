/**
 * ADR-0047：DistillationService 编译后补偿路径单元测试。
 * 用 mock store/compiler/snapshotGuard 隔离验证：编译已应用但工件状态推进失败
 * （返回 false 或抛异常）时，必须回滚核心写 + 标记终态，不留 approved 悬挂。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../../events/event-bus.js';
import { TestClock, SilentLogger } from '../../utils/index.js';
import { DistillationService, type SnapshotGuard } from '../../intelligence/distillation-service.js';
import type { ArtifactCompiler, CompileOutcome } from '../../intelligence/artifact-compiler.js';
import type { DistilledArtifactStore } from '../../storage/distilled-artifact-store.js';
import type { DistilledArtifact, ArtifactStatus } from '@chrono/kernel';

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

  setStatus(_personaId: string, _id: string, from: ArtifactStatus, to: ArtifactStatus): boolean {
    this.setStatusCalls.push({ from, to });
    if (to === 'compiled') {
      if (this.compiledBehavior === 'throw') throw new Error('simulated DB lock on compiled advance');
      if (this.compiledBehavior === 'false') return false;
    }
    this.artifact = { ...this.artifact, status: to };
    return true;
  }
}

function buildService(store: MockStore, compileOutcome: CompileOutcome, guard: SnapshotGuard) {
  const compiler = { compile: () => compileOutcome } as unknown as ArtifactCompiler;
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

  it('补偿时回滚自身抛异常也不冒泡（best-effort，记录后继续）', () => {
    const store = new MockStore();
    store.compiledBehavior = 'throw';
    const guard: SnapshotGuard = { snapshot: () => 'snap-1', rollback: () => { throw new Error('rollback also failed'); } };
    const svc = buildService(store, okOutcome, guard);
    /* 不应抛出——补偿是 best-effort，吞掉并记录 */
    const r = svc.approve('p1', 'dart-x');
    assert.equal(r.ok, false);
  });
});

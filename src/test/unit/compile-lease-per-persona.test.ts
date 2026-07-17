/**
 * #4：编译锁收窄到 per-persona。同 persona 互斥、跨 persona 并行（收益证明）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryDatabase, runDslSqliteMigrations } from '../../storage/index.js';
import { DistillationService } from '../../intelligence/distillation-service.js';
import { DistilledArtifactStore } from '../../storage/distilled-artifact-store.js';
import { PersonaLeaseStore } from '../../storage/persona-lease-store.js';
import { EventBus } from '../../events/event-bus.js';
import { TestClock } from '../../utils/clock.js';
import { SilentLogger } from '../../utils/logger.js';
import type { ArtifactCompiler } from '../../intelligence/artifact-compiler.js';
import type { SnapshotGuard } from '../../intelligence/distillation-service.js';
import type { CompileOutcome } from '../../intelligence/artifact-compiler.js';
import type { IDatabase } from '../../storage/database.js';

const TENANT = 't1';
function candidate(id: string) {
  return {
    id, kind: 'value_shift' as const, source: 'reflection' as const,
    payload: { valueId: 'v1', currentWeight: 0.5, suggestedWeight: 0.51, delta: 0.01, patternAgrees: true },
    confidence: 0.9,
    evidence: [{ type: 'pattern' as const, id: 'e1', score: 0.8 }, { type: 'memory' as const, id: 'm1', score: 0.6 }],
    status: 'candidate' as const, createdAt: 1000,
  };
}
function mkSvc(db: IDatabase, leases: PersonaLeaseStore) {
  const store = new DistilledArtifactStore(db, TENANT);
  const guard: SnapshotGuard = { snapshot: () => 'snap', rollback: () => true };
  const compiler = { compile: (): CompileOutcome => ({ ok: true, applied: 'x' }) } as unknown as ArtifactCompiler;
  const svc = new DistillationService({
    store, compiler, snapshotGuard: guard,
    bus: new EventBus(), clock: new TestClock(1000), logger: new SilentLogger(),
    tenantId: TENANT, leaseStore: leases,
  });
  return { store, svc };
}

describe('#4 编译锁 per-persona', () => {
  it('跨 persona 不再互相 busy：B 持自己的锁时，A 仍能编译（收益证明）', () => {
    const db = createMemoryDatabase(); runDslSqliteMigrations(db);
    const leases = new PersonaLeaseStore(db, TENANT);
    const { store, svc } = mkSvc(db, leases);
    store.insert('persona_A', candidate('dart-A'));
    /* B 占住**自己 persona 的** compile 锁（per-persona key）。 */
    const heldByB = leases.acquire('persona_B', 'compile', 1000, 60_000);
    assert.ok(heldByB);
    /* A 的 approve 不应被 B 的锁挡住——收窄后跨 persona 并行。 */
    const r = svc.approve('persona_A', 'dart-A');
    assert.equal(r.ok, true, 'A 应能编译（不被 B 的 per-persona 锁阻挡）');
    assert.equal(store.getById('persona_A', 'dart-A')?.status, 'compiled');
  });

  it('同 persona 互斥：A 持锁时，A 的另一次 approve 被挡（lease_busy）', () => {
    const db = createMemoryDatabase(); runDslSqliteMigrations(db);
    const leases = new PersonaLeaseStore(db, TENANT);
    const { store, svc } = mkSvc(db, leases);
    store.insert('persona_A', candidate('dart-A'));
    /* A 自己的 compile 锁被占（模拟同 persona 另一编译进行中）。 */
    const heldByA = leases.acquire('persona_A', 'compile', 1000, 60_000);
    assert.ok(heldByA);
    const r = svc.approve('persona_A', 'dart-A');
    assert.equal(r.ok, false, '同 persona 编译应互斥');
    assert.equal(store.getById('persona_A', 'dart-A')?.status, 'approved');
  });
});

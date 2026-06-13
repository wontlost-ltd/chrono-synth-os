/**
 * 端侧自治（ADR-0052 Edge 路线）— 让 zero-LLM 人格内核在非 Node runtime 端侧运行。
 *
 * Edge-P2（本阶段）：端侧确定性 host adapter（零 node:*）+ kernel 运行证明 + golden replay。
 * 后续：Edge-P3 持久化 + 同步边界；Edge-P4 离线成长队列；Edge-P5 媒体 GDPR；Edge-P6 固件裁剪规格。
 */

export { DeterministicClock, DeterministicRandom } from './host/deterministic-host.js';
export { InMemoryValueUnitOfWork } from './host/in-memory-value-uow.js';
export { runValueClosedLoop, type RuntimeProofResult } from './kernel-runtime-proof.js';

/* Edge-P3：端侧持久化 + 同步边界。 */
export { type EdgePersistence, InMemoryPersistence } from './sync/persistence.js';
export { SyncOutbox, classifyOpKind, type OutboxEntry, type ChangeClass } from './sync/outbox.js';
export {
  resolveConflict, resolveConflictsByTarget, toChangeRef, type ChangeRef, type Resolution,
} from './sync/conflict.js';

/**
 * 端侧自治（ADR-0052 Edge 路线）— 让 zero-LLM 人格内核在非 Node runtime 端侧运行。详见 README.md。
 *
 * 已实现：Edge-P2 host adapter + kernel 运行证明（host/）；Edge-P3 持久化 + 同步边界（sync/）；
 * Edge-P4 离线成长队列 + teacher job（growth/）。Edge-P5 媒体 GDPR 在 src/perception/media；
 * Edge-P6 固件裁剪是规格（ADR-0053）。未实现（部署/独立工程）：真 Web Worker harness、真对象存储
 * driver、真 MCU firmware——见 README「已知边界 / 登记债」。
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

/* Edge-P4：离线成长队列 + teacher job 编排。 */
export {
  GrowthJobQueue, type GrowthJob, type GrowthJobKind, type GrowthJobStatus,
} from './growth/growth-queue.js';
export {
  TeacherJobRunner, type TeacherFn, type TeacherOutcome, type RunSummary,
} from './growth/teacher-job-runner.js';

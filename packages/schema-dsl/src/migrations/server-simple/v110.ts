import { defineMigration, type Migration } from '../../index.js';

/**
 * 数字员工按职能进修 L8a（ADR-0057 D0.8）——挂起任务的唤醒重跑防死循环字段。
 *
 * 给 org_tasks 加两列，支撑「学完唤醒重跑」闭环的可靠性（红线 20）：
 *   - resume_attempt_count（整数，默认 0）：唤醒-复检-仍缺-再挂起的尝试计数。超上限 → 不再唤醒（停在
 *     blocked，留 SLA 兜底），防多能力误唤醒/死循环。
 *   - last_wake_event_id（可空 text）：上次处理的唤醒事件标识（learningRequestId），用于**幂等去重**——
 *     EventBus 可能重复投递同一 capability-learned，同事件不重复推进尝试计数/重复唤醒。
 *
 * 注意：**不**加 blocked_on_capabilities 列——挂起任务的「还缺哪些能力」是**派生量**（GapDetector(任务
 * requiredCapabilities, persona 已学能力)），存它会与真实已学状态漂移（好品味：消除可漂移的冗余存储）。
 *
 * 两列均可空/有默认 → 旧任务安全（resume_attempt_count 默认 0、last_wake_event_id NULL=从未唤醒）。
 * Alias：SQLite v110 / Postgres v112（紧跟 L7 capability_index sqlite v109 / pg v111）。
 */
export const v110_org_tasks_resume_guard: Migration = defineMigration({
  kind: 'schema',
  id: '110-org-tasks-resume-guard',
  aliases: { postgres: 'v112', 'sqlite-sql': 'v110' },
  description: 'Job-function learning L8a (ADR-0057 D0.8): org_tasks resume_attempt_count + last_wake_event_id (wake idempotency + anti-loop guard)',
  operations: [
    { kind: 'add-column', table: 'org_tasks', ifNotExists: true, safeIfTableExists: true, column: { name: 'resume_attempt_count', type: 'integer', nullable: false, default: 0 } },
    { kind: 'add-column', table: 'org_tasks', ifNotExists: true, safeIfTableExists: true, column: { name: 'last_wake_event_id', type: 'text' } },
  ],
});

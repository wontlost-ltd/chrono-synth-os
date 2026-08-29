import { defineRaw, rawSql } from '../../dsl/raw.js';
import type { RawMigration } from '../../types.js';

/**
 * 任务挂起原因列——给 org_tasks 加 blocked_reason，让 L8c 对账器能分辨
 * 「因能力缺口挂起」与「因工具故障挂起」（审计 #408）。
 *
 * 为什么需要：L8c 对账器的候选集判据是
 * `JOIN learning_requests lr ON lr.triggered_by_task_id = t.id AND t.status='blocked'`
 * —— 即「这个任务**历史上曾经**登记过学习请求」，而不是「**这次** blocked 是
 * 学习缺口造成的」。代码注释与测试都声称守住了「非学习 blocked 绝不纳入」，
 * 但任务走过一次完整生命周期后：
 *   缺能力 → blocked（写 learning_request）→ 学会 → 唤醒 delegated
 *   → 执行 → 工具失败 → blocked
 * `learning_request` 行**仍在**，JOIN 依旧命中。
 *
 * 实测后果：上游工具返回 500 导致 blocked 后，对账器 10 分钟内扫到该任务、
 * 复检发现能力已学齐 → **唤醒**，把 `result_summary` 从
 * 「执行被拦截/失败：failed（upstream 500）」覆盖成「已学齐所需能力，唤醒重跑」——
 * **真实故障诊断信息被销毁**，运维看到的是「能力已学齐」而根因是上游 500。
 * 且 persona 之后每学会一个**无关**能力都会让幂等指纹变化、再次唤醒，
 * 触顶 `resumeAttemptCount`(3) 前**一个非幂等工具会被额外真实执行 2 次**。
 *
 * 列语义：
 *   - `blocked_reason` 可空。NULL = 未标注（既有行 / 非 blocked 状态）。
 *     取值 `capability_gap`（能力缺口，L8c 应纳入）/ `execution_failure`
 *     （工具失败/执行异常，L8c **绝不**纳入）。
 *   - 不加 CHECK 约束：SQLite 加 CHECK 需重建表，会触发「RENAME 占用索引名致
 *     CREATE INDEX IF NOT EXISTS 静默 no-op、DROP _old 连带删掉索引」的已知坑
 *     （参 v122/v126/v127）。取值由写入侧（worker-execution-service）保证，
 *     读取侧只做等值比较，非法值等价于「不纳入」——fail-safe 方向正确。
 *
 * 手法：纯加列，**不重建表**。
 *
 * 向后兼容：新列可空。既有 blocked 行 `blocked_reason IS NULL` ——
 * L8c 查询用 `blocked_reason = 'capability_gap'` 会把它们排除在外。
 * 这是**保守**方向：宁可少唤醒（人工可介入），也不要误唤醒覆盖故障原因。
 * 迁移后新产生的能力缺口挂起会正常标注并被纳入。
 * 回滚：PG DROP COLUMN；SQLite 列可保留（无害）。
 *
 * Alias：SQLite v130 / Postgres v132（紧跟 v129 approval-single-use / Postgres v131）。
 */
export const v130_task_blocked_reason: RawMigration = defineRaw({
  id: 'task-blocked-reason',
  version: 'v130',
  aliases: { postgres: 'v132', 'sqlite-sql': 'v130' },
  description: 'Org tasks: add blocked_reason so the L8c reconciler can tell capability gaps from tool failures',
  reason: 'L8c 对账器判据是「曾登记过学习请求」而非「本次因能力缺口 blocked」：任务走完一轮生命周期后 learning_request 行仍在，JOIN 依旧命中 —— 工具失败导致的 blocked 会被当成学习挂起唤醒，把 result_summary 从「执行被拦截/失败：upstream 500」覆盖成「已学齐所需能力」，真实故障诊断信息被销毁；且每学会一个无关能力就再唤醒一次，触顶 resumeAttemptCount 前非幂等工具被额外真实执行 2 次。加可空 blocked_reason（capability_gap / execution_failure），查询侧据此过滤；纯加列不重建表',
  postgres: rawSql([
    `ALTER TABLE org_tasks ADD COLUMN IF NOT EXISTS blocked_reason TEXT`,
  ]),
  sqlite: rawSql([
    /* ⚠️ `safe:if-table-exists` 标记必需：legacy-migrations 测试模拟部分 schema，
     * 那里 org_tasks 尚未建表，裸 ALTER 会抛 `no such table`。 */
    `/* safe:if-table-exists:org_tasks */ ALTER TABLE org_tasks ADD COLUMN blocked_reason TEXT`,
  ]),
});

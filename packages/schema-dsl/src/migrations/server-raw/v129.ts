import { defineRaw, rawSql } from '../../dsl/raw.js';
import type { RawMigration } from '../../types.js';

/**
 * 执行审批的**一次性消费锚 + 参数绑定**——给 org_approvals 加 consumed_at + arguments_hash。
 *
 * 为什么需要（审计 #407）：`isExecutionApprovalCleared` 是**纯读校验**，
 * 从不消费审批。批准后 `status` 永远停在 `approved`，没有「已使用」标记、
 * 没有次数上限、**也没有与本次执行参数绑定**。只要任务回到 `delegated`
 * （pipeline pending_confirmation 退回 / L8a 唤醒 / 改派），同一个 approvalId
 * 就能再次放行。
 *
 * 实测：一次人类批准放行了 **2 次**真实高风险工具调用，且第二次用的是
 * **完全不同的参数** —— 人类看着 `{amount: 10}` 点的批准，可以用来执行
 * `{amount: 999999}`。审批的 `status` 全程停在 `approved`，从未被消费。
 *
 * 对照：同仓 `ConfirmationTokenStore`（confirmation-token-store.ts:81-106）
 * **早已是正确形状** —— 一次性 CAS 消费 + `input_hash` 绑定。缺陷在于审批层
 * 没有对等保护，两道门强度不对称。
 *
 * 列语义：
 *   - `consumed_at` 可空。NULL = 未被消费（既有行天然兼容）。执行门以
 *     `UPDATE ... WHERE status='approved' AND consumed_at IS NULL` 做 CAS 消费，
 *     据 rowsAffected 判定 —— 并发下只有一次能成功，杜绝复用。
 *   - `arguments_hash` 可空。NULL = 该审批未绑定参数（既有行 / 不需要绑定的场景）。
 *     非空时执行门必须校验本次编译后参数的 hash 与之一致，否则「批准 $10
 *     执行 $999999」依然成立。
 *
 * 为什么不加唯一索引：消费性由 `consumed_at IS NULL` 谓词在 UPDATE 里保证，
 * 不需要额外唯一约束；加索引反而要处理 NULL 语义。
 *
 * 手法：纯加列，**不重建表** —— 故不触发 SQLite 重建表时
 * 「RENAME 占用索引名致 CREATE INDEX IF NOT EXISTS 静默 no-op、DROP _old
 * 连带删掉唯一索引」的已知坑（参 v122/v126/v127 注释）。
 *
 * 向后兼容：两列均可空，既有写路径（不传）仍合法。既有 approved 行
 * `consumed_at IS NULL`，第一次执行会正常消费掉，不会因迁移而失效。
 * 回滚：PG DROP COLUMN；SQLite 列可保留（无害）。
 *
 * Alias：SQLite v129 / Postgres v131（紧跟 v128 wallet-payout-idempotency / Postgres v130）。
 */
export const v129_approval_single_use: RawMigration = defineRaw({
  id: 'approval-single-use',
  version: 'v129',
  aliases: { postgres: 'v131', 'sqlite-sql': 'v129' },
  description: 'Execution approval: org_approvals adds consumed_at + arguments_hash (single-use + parameter binding)',
  reason: '执行审批可无限复用且不绑定参数：isExecutionApprovalCleared 是纯读校验，批准后 status 永远停在 approved，无「已使用」标记、无次数上限、无参数绑定。任务回到 delegated 后同一 approvalId 可再次放行——实测一次人类批准放行 2 次真实高风险工具调用，第二次用完全不同的参数（批准 {amount:10} 执行 {amount:999999}）。同仓 ConfirmationTokenStore 早已是一次性 CAS 消费 + input_hash 绑定，审批层无对等保护。加可空 consumed_at（执行门 CAS 消费）+ arguments_hash（参数绑定）；纯加列不重建表',
  postgres: rawSql([
    `ALTER TABLE org_approvals ADD COLUMN IF NOT EXISTS consumed_at BIGINT`,
    `ALTER TABLE org_approvals ADD COLUMN IF NOT EXISTS arguments_hash TEXT`,
  ]),
  sqlite: rawSql([
    /* ⚠️ `safe:if-table-exists` 标记必需：legacy-migrations 测试模拟「从 v047 起步」的
     * 部分 schema，那里 org_approvals 尚未建表，裸 ALTER 会抛 `no such table`。
     * SQLite runner 认这个标记跳过不存在的表；PG 侧无需——它跑的是完整 schema。 */
    /* SQLite 无 ADD COLUMN IF NOT EXISTS；版本号全新不会重复执行，直接加列。 */
    `/* safe:if-table-exists:org_approvals */ ALTER TABLE org_approvals ADD COLUMN consumed_at INTEGER`,
    `/* safe:if-table-exists:org_approvals */ ALTER TABLE org_approvals ADD COLUMN arguments_hash TEXT`,
  ]),
});

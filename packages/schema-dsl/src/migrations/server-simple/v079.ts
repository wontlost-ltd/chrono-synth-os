import { defineMigration, type Migration } from '../../index.js';

/**
 * GA §8 #1 — KMS 锚定失败 evidence 表 (audit_chain_anchor_failures)。
 *
 * 现状：audit-chain-anchor-service 在 KMS 签名失败时只写 error log 即
 * `continue`，无法在不读日志的情况下知道某租户的链尾没有及时被锚定，
 * 也无法在恢复检查时分辨"漏锚"与"没尝试过"。
 *
 * 引入 evidence 表：
 *   - 每次 KMS 失败写一行（含 tenant/seq 窗口 + tailHash + 错误摘要 +
 *     attempt_at）；
 *   - 锚定成功后由调度器读最近的失败行做关联清算（recoveredAt 标记）；
 *   - 监控面读 `WHERE recovered_at IS NULL` 计 fresh failures，再驱动告警。
 *
 * 字段决策：
 *   - attempted_at 用 ISO-8601 文本，与 audit_chain_anchors.signed_at 对齐；
 *   - error_code 给一个稳定枚举值（timeout / refused / network / internal），
 *     便于 dashboard 分类；error_message 是自由文本细节；
 *   - recovered_at 可空：当下一次成功锚定覆盖该窗口时写入当时的时间戳，
 *     用作"该失败已自愈"的证据；
 *   - UNIQUE(tenant_id, attempted_at) 让短时间内连续失败仍能逐条记录，
 *     不会被幂等抑制（attempt_at 由调用方填入 clock.now()，纳秒级足够）。
 *
 * Alias：SQLite v079 / Postgres v081（紧跟 v078 jwt_signing_keys）。
 */
export const v079_audit_chain_anchor_failures: Migration = defineMigration({
  kind: 'schema',
  id: '079-audit-chain-anchor-failures',
  aliases: { postgres: 'v081', 'sqlite-sql': 'v079' },
  description: 'GA §8 #1: persist KMS anchor failures as evidence rows',
  operations: [
    {
      kind: 'create-table',
      table: {
        name: 'audit_chain_anchor_failures',
        ifNotExists: true,
        columns: [
          { name: 'id', type: 'text', primaryKey: true },
          { name: 'tenant_id', type: 'text', nullable: false },
          { name: 'from_seq', type: 'bigint', nullable: false },
          { name: 'to_seq', type: 'bigint', nullable: false },
          { name: 'tail_hash', type: 'text', nullable: false },
          { name: 'error_code', type: 'text', nullable: false },
          { name: 'error_message', type: 'text', nullable: false },
          { name: 'attempted_at', type: 'text', nullable: false },
          { name: 'recovered_at', type: 'text' },
        ],
      },
    },
    {
      kind: 'create-index',
      index: {
        name: 'idx_audit_chain_anchor_failures_open',
        table: 'audit_chain_anchor_failures',
        columns: ['tenant_id', 'recovered_at'],
        ifNotExists: true,
      },
    },
    {
      kind: 'create-index',
      index: {
        name: 'idx_audit_chain_anchor_failures_attempted',
        table: 'audit_chain_anchor_failures',
        columns: ['attempted_at'],
        ifNotExists: true,
      },
    },
  ],
});

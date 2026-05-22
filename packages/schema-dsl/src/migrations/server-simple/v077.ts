import { defineMigration, type Migration } from '../../index.js';

/**
 * P0-E v2 — KMS 锚定的审计链尾签名 (audit_chain_anchors)。
 *
 * 现状：audit_log 内部用 SHA-256 哈希链检测逐行篡改，但拿到数据库
 * 写权限的攻击者可以一次性重写整段历史，得到一份"自洽但伪造"的链。
 * 周期性把链尾哈希提交给外部 KMS 签名后落地，就形成了链外信任锚：
 * 还原 / 备份检查时只需验证锚（KMS pubkey）+ 链尾哈希就能识别篡改。
 *
 * 字段决策：
 *   - signed_at 用 ISO-8601 文本，保持 SQLite/Postgres 字典序 == 时间序；
 *   - signature 存 base64，便于跨 dialect 用 TEXT 列承载；
 *   - UNIQUE(tenant_id, to_seq, tail_hash) 让定时任务多次触发同一窗口
 *     时幂等：哈希一致即跳过插入；
 *   - (tenant_id, to_seq DESC) 索引服务于"读最新锚"的高频访问。
 *
 * Alias：SQLite v077 / Postgres v079。
 */
export const v077_audit_chain_anchors: Migration = defineMigration({
  kind: 'schema',
  id: '077-audit-chain-anchors',
  aliases: { postgres: 'v079', 'sqlite-sql': 'v077' },
  description: 'P0-E v2: KMS-signed audit chain tail anchors',
  operations: [
    {
      kind: 'create-table',
      table: {
        name: 'audit_chain_anchors',
        ifNotExists: true,
        columns: [
          { name: 'id', type: 'text', primaryKey: true },
          { name: 'tenant_id', type: 'text', nullable: false },
          { name: 'from_seq', type: 'bigint', nullable: false },
          { name: 'to_seq', type: 'bigint', nullable: false },
          { name: 'tail_hash', type: 'text', nullable: false },
          { name: 'signature', type: 'text', nullable: false },
          { name: 'key_id', type: 'text', nullable: false },
          { name: 'alg', type: 'text', nullable: false },
          { name: 'signed_at', type: 'text', nullable: false },
        ],
      },
    },
    {
      kind: 'create-index',
      index: {
        name: 'idx_audit_chain_anchors_unique_tail',
        table: 'audit_chain_anchors',
        columns: ['tenant_id', 'to_seq', 'tail_hash'],
        unique: true,
        ifNotExists: true,
      },
    },
    {
      kind: 'create-index',
      index: {
        name: 'idx_audit_chain_anchors_latest',
        table: 'audit_chain_anchors',
        columns: ['tenant_id', 'to_seq'],
        ifNotExists: true,
      },
    },
  ],
});

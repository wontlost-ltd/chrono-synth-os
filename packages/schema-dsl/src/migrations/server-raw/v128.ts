import { defineRaw, rawSql } from '../../dsl/raw.js';
import type { RawMigration } from '../../types.js';

/**
 * 钱包提现的**领域幂等锚**——给 wallet_payout_requests 加 idempotency_key + 唯一索引。
 *
 * 为什么需要：`requestWalletPayout` 只收 (walletId, amountMinor)，**没有任何幂等键**。
 * 客户端重试、或 HTTP `Idempotency-Key` 过期（默认 TTL 24h）后重放同一笔提现，
 * 会各自扣一次钱。实测：余额 1000 的钱包连发两次 10000 分的提现请求 →
 * 两条 wallet_payout_requests、余额 **1000 → 800**。
 *
 * 为什么 HTTP 层的幂等插件不够：它把 claim 与业务写入放在**两个**事务里。
 * claim 建立后进程崩溃、或 TTL 到期清理后重试，业务侧没有任何东西能识别
 * 「这笔提现已经处理过」。金融幂等必须锚在**领域数据**上，由数据库唯一约束兜底
 * —— 这正是同域 `wallet_settlements.assignment_id UNIQUE` 已经在做的事
 * （v036 列级 unique），提现这条是漏网。
 *
 * 列语义：
 *   - `idempotency_key` 可空。NULL = 未提供幂等键（既有行天然兼容，且旧调用方仍可用）。
 *     非空时按 (tenant_id, idempotency_key) 全局唯一 —— 重复提交在**数据库层**被拒。
 *   - 用**部分索引**（PG `WHERE ... IS NOT NULL` / SQLite 同语法）：NULL 行不参与唯一性，
 *     否则多条 NULL 在 PG 下虽可共存、在语义上却会误导读者以为「不传 key 也受保护」。
 *
 * 手法：纯加列 + 建索引，**不重建表** —— 故不触发 SQLite 重建表时
 * 「RENAME 占用索引名致 CREATE INDEX IF NOT EXISTS 静默 no-op、DROP _old
 * 连带删掉唯一索引」的已知坑（参 v122/v126/v127 注释）。
 *
 * 向后兼容：新列可空，既有写路径（不传该列）仍合法；不传 key 时行为与今天完全一致
 * （即仍可重复提交）—— 幂等是**调用方选择加入**的能力，本迁移只提供锚点。
 * 回滚：PG DROP INDEX + DROP COLUMN；SQLite DROP INDEX（列可保留，无害）。
 *
 * Alias：SQLite v128 / Postgres v130（紧跟 v127 github-installation-suspended / Postgres v129）。
 */
export const v128_wallet_payout_idempotency: RawMigration = defineRaw({
  id: 'wallet-payout-idempotency',
  version: 'v128',
  aliases: { postgres: 'v130', 'sqlite-sql': 'v128' },
  description: 'Wallet payout: wallet_payout_requests adds idempotency_key + unique index',
  reason: '提现无领域幂等锚：requestWalletPayout 只收 (walletId, amountMinor)，客户端重试或 HTTP 幂等键 TTL 过期后重放会各扣一次钱（实测余额 1000→800）。HTTP 幂等插件把 claim 与业务写入放在两个事务，崩溃/过期后无从识别；金融幂等必须锚在领域数据上由唯一约束兜底（同域 wallet_settlements.assignment_id 已如此）。加可空 idempotency_key + (tenant_id, key) 部分唯一索引；纯加列不重建表',
  postgres: rawSql([
    `ALTER TABLE wallet_payout_requests ADD COLUMN IF NOT EXISTS idempotency_key TEXT`,
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_wallet_payout_idempotency
       ON wallet_payout_requests (tenant_id, idempotency_key)
       WHERE idempotency_key IS NOT NULL`,
  ]),
  sqlite: rawSql([
    /* ⚠️ `safe:if-table-exists` 标记必需：legacy-migrations 测试模拟「从 v047 起步」的
     * 部分 schema，那里 wallet_payout_requests 尚未建表，裸 ALTER 会抛
     * `no such table`（实测踩到）。SQLite runner 认这个标记跳过不存在的表；
     * PG 侧无需——它跑的是完整 schema。同款用法见 runner 里 v063/v072 的处理。 */
    /* SQLite 无 ADD COLUMN IF NOT EXISTS；版本号全新不会重复执行，直接加列。 */
    `/* safe:if-table-exists:wallet_payout_requests */ ALTER TABLE wallet_payout_requests ADD COLUMN idempotency_key TEXT`,
    /* SQLite 3.8+ 支持部分索引，语法与 PG 一致。 */
    `/* safe:if-table-exists:wallet_payout_requests */ CREATE UNIQUE INDEX IF NOT EXISTS uq_wallet_payout_idempotency
       ON wallet_payout_requests (tenant_id, idempotency_key)
       WHERE idempotency_key IS NOT NULL`,
  ]),
});

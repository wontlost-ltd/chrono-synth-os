import { defineMigration, type Migration } from '../../index.js';

/**
 * 数字组织金库 S1（org wallet）——给数字员工组织一个组织级账户，让它能作为独立经济主体从任务市场接工单赚钱。
 *
 * 背景：marketplace 的报酬此前只结算给**单个 persona 钱包**（persona_wallets）。要让「组织从市场接工单→分给
 * 员工做→报酬归组织」成立，组织必须有自己的金库。本迁移落 org_wallets（组织级余额账户），结算账本（流水/
 * 结算记录）在 S3 迁移补齐。
 *
 * 隔离维度 (tenant_id, org_id) 双键 UNIQUE——同租户多个组织各有独立金库（与 org_goals/org_tasks 同构）。
 * 含 tenant_id → TenantDatabase 自动隔离；GDPR A 类（业务派生余额，无敏感凭证列）。
 * Alias：SQLite v111 / Postgres v113（紧跟 v110 org_tasks resume-guard / pg v112）。
 */
export const v111_org_wallet: Migration = defineMigration({
  kind: 'schema',
  id: '111-org-wallet',
  aliases: { postgres: 'v113', 'sqlite-sql': 'v111' },
  description: 'Digital workforce: org_wallets (organization-level treasury so an org can earn from the task marketplace)',
  operations: [
    {
      kind: 'create-table',
      table: {
        name: 'org_wallets',
        ifNotExists: true,
        columns: [
          { name: 'id', type: 'text', primaryKey: true },
          { name: 'tenant_id', type: 'text', nullable: false, default: 'default' },
          { name: 'org_id', type: 'text', nullable: false },
          /* 余额（minor 单位以分计；与 persona_wallets 的 balance 同语义，real 存储）。 */
          { name: 'balance', type: 'real', nullable: false, default: 0 },
          { name: 'currency', type: 'text', nullable: false, default: 'CRED' },
          /* active/frozen——冻结时禁出账（结算/提现守卫用）。 */
          { name: 'status', type: 'text', nullable: false, default: 'active' },
          /* 最近一次结算时间（审计/对账）。 */
          { name: 'last_settled_at', type: 'bigint', nullable: true },
          { name: 'created_at', type: 'bigint', nullable: false },
          { name: 'updated_at', type: 'bigint', nullable: false },
        ],
      },
    },
    /* (tenant, org) 唯一——每个组织恰好一个金库（getOrCreate 幂等的 DB 级保证）。 */
    { kind: 'create-index', index: { name: 'uq_org_wallets_org', table: 'org_wallets', columns: ['tenant_id', 'org_id'], unique: true, ifNotExists: true } },
    /* 工单溯源（S2）：org_goals 加 source_marketplace_task_id——目标若由市场工单接来则记其 id（nullable，
     * 内部直接下发的目标为 null）。让「市场工单→组织目标→分解委派」全链可审计追溯到源工单。 */
    { kind: 'add-column', table: 'org_goals', ifNotExists: true, safeIfTableExists: true, column: { name: 'source_marketplace_task_id', type: 'text', nullable: true } },

    /* 结算记录（S3）：组织从市场工单赚的钱的结算账本。org 结算是**两方分账**（平台抽成 + 组织净留存），
     * 不照搬 persona 版的三方（无 persona reserve——金库就是组织自己的钱）。
     * UNIQUE(tenant, source_marketplace_task_id) 防同一工单重复结算（幂等键）。 */
    {
      kind: 'create-table',
      table: {
        name: 'org_wallet_settlements',
        ifNotExists: true,
        columns: [
          { name: 'id', type: 'text', primaryKey: true },
          { name: 'tenant_id', type: 'text', nullable: false, default: 'default' },
          { name: 'org_id', type: 'text', nullable: false },
          { name: 'wallet_id', type: 'text', nullable: false },
          /* 溯源 + 幂等键：结算对应的市场工单 id。 */
          { name: 'source_marketplace_task_id', type: 'text', nullable: false },
          /* 该工单接来的组织目标 id（审计：报酬对应哪个被分解执行的目标）。 */
          { name: 'goal_id', type: 'text', nullable: true },
          { name: 'total_amount_minor', type: 'bigint', nullable: false },
          { name: 'currency', type: 'text', nullable: false },
          /* 平台抽成比例（%）；组织净留存 = total - platform。 */
          { name: 'platform_pct', type: 'integer', nullable: false },
          { name: 'platform_amount_minor', type: 'bigint', nullable: false },
          { name: 'org_amount_minor', type: 'bigint', nullable: false },
          { name: 'created_at', type: 'bigint', nullable: false },
        ],
      },
    },
    /* 幂等：同一工单只结算一次（DB 级保证，并发兜底）。 */
    { kind: 'create-index', index: { name: 'uq_org_wallet_settlements_source', table: 'org_wallet_settlements', columns: ['tenant_id', 'source_marketplace_task_id'], unique: true, ifNotExists: true } },

    /* 流水（S3）：组织金库每笔账的明细。两种类型：task_payment（工单报酬入账，+total）/
     * platform_fee（平台抽成，-platform）。净额（=org 留存）即入金库余额。refund 备未来。 */
    {
      kind: 'create-table',
      table: {
        name: 'org_wallet_transactions',
        ifNotExists: true,
        columns: [
          { name: 'id', type: 'text', primaryKey: true },
          { name: 'tenant_id', type: 'text', nullable: false, default: 'default' },
          { name: 'wallet_id', type: 'text', nullable: false },
          { name: 'transaction_type', type: 'text', nullable: false },
          { name: 'amount_minor', type: 'bigint', nullable: false },
          { name: 'currency', type: 'text', nullable: false },
          { name: 'reference_type', type: 'text', nullable: true },
          { name: 'reference_id', type: 'text', nullable: true },
          { name: 'created_at', type: 'bigint', nullable: false },
        ],
      },
    },
    /* 按金库列流水（对账/审计）。 */
    { kind: 'create-index', index: { name: 'idx_org_wallet_tx_wallet', table: 'org_wallet_transactions', columns: ['tenant_id', 'wallet_id', 'created_at'], ifNotExists: true } },
  ],
});

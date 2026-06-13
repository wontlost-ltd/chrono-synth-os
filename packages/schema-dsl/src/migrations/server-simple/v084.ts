import { defineMigration, type Migration } from '../../index.js';

/**
 * BYOK — 租户自带 LLM provider 密钥的加密存储（llm_provider_credentials）。
 *
 * onboarding 选 provider 时填的 api key 原先被丢弃（用户得在 Settings 重填）。本表持久化它：
 * key 列**只存密文**（FieldEncryption AES-GCM，版本化），明文绝不落库；ModelRouter 构造时
 * 优先取本租户的 per-tenant key，缺失则回退全局 config（向后兼容）。
 *
 * 字段决策：
 *   - 复合主键 (tenant_id, provider)：一个租户每个 provider 一条 active 凭据，upsert 覆盖更新
 *     （不留版本史——api key 是 secret 不是审计资产，最新有效即可，旧值应被覆盖而非留存）；
 *   - api_key_encrypted 非空：FieldEncryption 密文（明文绝不落库）；
 *   - created_by 记录是谁设的（审计）；created_at/updated_at 为 epoch ms（ADR-0029）。
 *
 * 含 tenant_id → 进 TenantDatabase 自动隔离 + privacy 导出/擦除（key 列**脱敏不导出**，B 类凭据）。
 *
 * Alias：SQLite v084 / Postgres v086（紧跟 v083 persona_rules / Postgres v085）。
 */
export const v084_llm_provider_credentials: Migration = defineMigration({
  kind: 'schema',
  id: '084-llm-provider-credentials',
  aliases: { postgres: 'v086', 'sqlite-sql': 'v084' },
  description: 'BYOK: encrypted per-tenant LLM provider API keys (llm_provider_credentials)',
  operations: [
    {
      kind: 'create-table',
      table: {
        name: 'llm_provider_credentials',
        ifNotExists: true,
        columns: [
          { name: 'tenant_id', type: 'text', nullable: false, default: 'default' },
          { name: 'provider', type: 'text', nullable: false },
          /* 只存密文（FieldEncryption）。明文 api key 绝不落库。 */
          { name: 'api_key_encrypted', type: 'text', nullable: false },
          { name: 'created_by', type: 'text' },
          { name: 'created_at', type: 'bigint', nullable: false },
          { name: 'updated_at', type: 'bigint', nullable: false },
        ],
        /* 一个租户每个 provider 一条 active 凭据；upsert 覆盖更新（不留版本史）。 */
        constraints: [
          { kind: 'primary-key', columns: ['tenant_id', 'provider'] },
        ],
      },
    },
  ],
});

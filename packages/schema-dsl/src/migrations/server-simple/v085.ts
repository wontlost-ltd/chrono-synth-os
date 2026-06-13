import { defineMigration, type Migration } from '../../index.js';

/**
 * BYOK 后续 — 租户级 active LLM provider 偏好（tenant_llm_settings）。
 *
 * BYOK（v084）让租户能按 (tenant, provider) 存多个加密 key，但运行时**用哪个 provider**
 * 仍硬取全局 config.intelligence.provider。本表让租户选自己的 active provider（及可选覆盖
 * model/embedding_model/base_url）；ModelRouter 构造时先解析本租户有效配置（无 row → 完全
 * 回退全局 config，行为不变=向后兼容）。
 *
 * 字段决策：
 *   - tenant_id 单列主键：active provider 偏好是租户级单选（非 per-credential），一租户一行；
 *   - active_provider 非空：openai/anthropic/ollama/mock 之一（应用层校验枚举）；
 *   - model/embedding_model/base_url 可空：NULL = 沿用全局 config 或 provider 默认（仅覆盖非空项）；
 *   - **不存 fallbacks**：降级链（ADR-0047 D2）是平台级策略，不是租户配置项——租户只选 active
 *     provider，fallbacks 继续用全局 config.intelligence.fallbacks（避免租户配降级链的语义复杂度）；
 *   - updated_by 审计；created_at/updated_at 为 epoch ms（ADR-0029）。
 *
 * 偏好是**非 secret 配置**（与 llm_provider_credentials 密钥表生命周期/校验/审计不同，且
 * ollama/mock 无需 key），故独立成表而非塞进凭据表。
 *
 * 含 tenant_id 且无 worker/webhook 全局语义 → 进 TenantDatabase 自动隔离 + privacy 标准
 * 导出/擦除（A 类，非 secret 无需脱敏）。
 *
 * Alias：SQLite v085 / Postgres v087（紧跟 v084 llm_provider_credentials / Postgres v086）。
 */
export const v085_tenant_llm_settings: Migration = defineMigration({
  kind: 'schema',
  id: '085-tenant-llm-settings',
  aliases: { postgres: 'v087', 'sqlite-sql': 'v085' },
  description: 'BYOK: per-tenant active LLM provider preference (tenant_llm_settings)',
  operations: [
    {
      kind: 'create-table',
      table: {
        name: 'tenant_llm_settings',
        ifNotExists: true,
        columns: [
          { name: 'tenant_id', type: 'text', nullable: false, default: 'default' },
          /* openai/anthropic/ollama/mock 之一（应用层校验）。 */
          { name: 'active_provider', type: 'text', nullable: false },
          /* 可空覆盖项：NULL = 沿用全局 config / provider 默认。 */
          { name: 'model', type: 'text' },
          { name: 'embedding_model', type: 'text' },
          { name: 'base_url', type: 'text' },
          { name: 'updated_by', type: 'text' },
          { name: 'created_at', type: 'bigint', nullable: false },
          { name: 'updated_at', type: 'bigint', nullable: false },
        ],
        /* 租户级单选偏好：一租户一行，upsert 覆盖。 */
        constraints: [
          { kind: 'primary-key', columns: ['tenant_id'] },
        ],
      },
    },
  ],
});

import { defineMigration, type Migration } from '../../index.js';

/**
 * ADR-0047 — 规则库专用持久化 (persona_rules)。
 *
 * rule 蒸馏工件编译成决策规则库，作为 rule-engine 中 constraint penalty 的同类机制参与排序。
 * 同一 rule_id 保留版本史，决策消费端只读取每个 rule_id 的最高版本。
 *
 * Alias：SQLite v083 / Postgres v085（紧跟 v082 response_templates / Postgres v084）。
 */
export const v083_persona_rules: Migration = defineMigration({
  kind: 'schema',
  id: '083-persona-rules',
  aliases: { postgres: 'v085', 'sqlite-sql': 'v083' },
  description: 'ADR-0047: durable versioned persona rules for rule-engine adjustments',
  operations: [
    {
      kind: 'create-table',
      table: {
        name: 'persona_rules',
        ifNotExists: true,
        columns: [
          { name: 'tenant_id', type: 'text', nullable: false, default: 'default' },
          { name: 'persona_id', type: 'text', nullable: false },
          { name: 'rule_id', type: 'text', nullable: false },
          { name: 'condition', type: 'text', nullable: false },
          { name: 'action', type: 'text', nullable: false },
          { name: 'weight', type: 'real', nullable: false },
          { name: 'description', type: 'text' },
          { name: 'artifact_id', type: 'text' },
          { name: 'version', type: 'integer', nullable: false, default: 1 },
          { name: 'created_at', type: 'bigint', nullable: false },
          { name: 'updated_at', type: 'bigint', nullable: false },
        ],
        constraints: [
          { kind: 'primary-key', columns: ['tenant_id', 'persona_id', 'rule_id', 'version'] },
          { kind: 'check', expression: "action IN ('prefer', 'avoid')" },
          { kind: 'check', expression: 'weight >= 0 AND weight <= 1' },
        ],
      },
    },
    {
      kind: 'create-index',
      index: {
        name: 'idx_persona_rules_rule',
        table: 'persona_rules',
        columns: ['tenant_id', 'persona_id', 'rule_id', 'version'],
        ifNotExists: true,
      },
    },
  ],
});

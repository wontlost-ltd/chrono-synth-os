import { defineMigration, type Migration } from '../../index.js';

export const v005_personality_os: Migration = defineMigration({
  kind: 'schema',
  id: 'personality-os',
  aliases: { postgres: 'v005', 'sqlite-sql': 'v005' },
  description: 'P-OS v0.1 人格模型',
  operations: [
    { kind: 'create-table', table: { name: 'survival_anchors', ifNotExists: true, columns: [
      { name: 'id', type: 'text', primaryKey: true },
      { name: 'label', type: 'text', nullable: false },
      { name: 'kind', type: 'text', nullable: false, check: "kind IN ('constraint', 'threshold', 'must_have')" },
      { name: 'value_json', type: 'text', nullable: false },
      { name: 'severity', type: 'integer', nullable: false, check: 'severity >= 1 AND severity <= 5' },
      { name: 'created_at', type: 'bigint', nullable: false },
      { name: 'updated_at', type: 'bigint', nullable: false },
    ] } },
    { kind: 'create-index', index: { name: 'idx_survival_anchors_kind', table: 'survival_anchors', columns: ['kind'], ifNotExists: true } },
    { kind: 'create-index', index: { name: 'idx_survival_anchors_severity', table: 'survival_anchors', columns: ['severity'], ifNotExists: true } },
    { kind: 'create-table', table: { name: 'decision_style', ifNotExists: true, columns: [
      { name: 'id', type: 'integer', primaryKey: true, check: 'id = 1' },
      { name: 'style_json', type: 'text', nullable: false },
      { name: 'updated_at', type: 'bigint', nullable: false },
    ] } },
    { kind: 'create-table', table: { name: 'cognitive_model', ifNotExists: true, columns: [
      { name: 'id', type: 'integer', primaryKey: true, check: 'id = 1' },
      { name: 'model_json', type: 'text', nullable: false },
      { name: 'updated_at', type: 'bigint', nullable: false },
    ] } },
  ],
});

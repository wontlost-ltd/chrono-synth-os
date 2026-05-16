import { defineMigration, type Migration } from '../../index.js';

export const v061_migration: Migration = defineMigration({
  kind: 'schema',
  id: '061',
  aliases: { postgres: 'v061', 'sqlite-sql': 'v061' },
  description: "AI 安全治理：人格漂移分析日志",
  operations: [
  {
    kind: "create-table",
    table: {
      name: "drift_analysis_log",
      ifNotExists: true,
      columns: [
        {
          name: "id",
          type: "text",
          primaryKey: true
        },
        {
          name: "tenant_id",
          type: "text",
          nullable: false
        },
        {
          name: "baseline_snapshot_id",
          type: "text"
        },
        {
          name: "analyzed_at",
          type: "bigint",
          nullable: false
        },
        {
          name: "overall_drift_score",
          type: "real",
          nullable: false
        },
        {
          name: "alert_level",
          type: "text",
          nullable: false,
          default: "ok"
        },
        {
          name: "value_drifts_json",
          type: "text",
          nullable: false,
          default: "[]"
        }
      ]
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_drift_analysis_log_tenant",
      table: "drift_analysis_log",
      columns: [
        "tenant_id",
        "analyzed_at DESC"
      ],
      unique: false,
      ifNotExists: true
    }
  }
],
});

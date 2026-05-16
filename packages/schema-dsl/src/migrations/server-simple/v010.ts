import { defineMigration, type Migration } from '../../index.js';

export const v010_update_gate: Migration = defineMigration({
  kind: 'schema',
  id: 'update-gate',
  aliases: { postgres: 'v010', 'sqlite-sql': 'v010' },
  description: '更新闸门 pending_updates',
  operations: [
    { kind: 'create-table', table: { name: 'pending_updates', ifNotExists: true, columns: [
      { name: 'id', type: 'text', primaryKey: true },
      { name: 'tenant_id', type: 'text', nullable: false, default: 'default' },
      { name: 'layer', type: 'text', nullable: false, check: "layer IN ('L0', 'L1')" },
      { name: 'trigger_type', type: 'text', nullable: false },
      { name: 'target_id', type: 'text', nullable: false },
      { name: 'current_value', type: 'text' },
      { name: 'proposed_value', type: 'text' },
      { name: 'delta', type: 'real', nullable: false, default: 0 },
      { name: 'reason', type: 'text' },
      { name: 'created_at', type: 'bigint', nullable: false },
      { name: 'status', type: 'text', nullable: false, default: 'pending', check: "status IN ('pending', 'approved', 'rejected')" },
    ] } },
    { kind: 'create-index', index: { name: 'idx_pending_updates_status', table: 'pending_updates', columns: ['status'], ifNotExists: true } },
    { kind: 'create-index', index: { name: 'idx_pending_updates_tenant', table: 'pending_updates', columns: ['tenant_id'], ifNotExists: true } },
  ],
});

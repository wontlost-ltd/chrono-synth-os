export type DataPlaneAuthorityMode =
  | 'tables_primary'
  | 'dual_write'
  | 'ledger_primary'
  | 'rollback_tables';

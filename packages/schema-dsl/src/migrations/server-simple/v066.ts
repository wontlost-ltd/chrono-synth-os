import { defineMigration, type Migration } from '../../index.js';

export const v066_migration: Migration = defineMigration({
  kind: 'schema',
  id: '066',
  aliases: { postgres: 'v066', 'sqlite-sql': 'v066' },
  description: "P1-D：subscriptions 增加 trial_end / grace_period_ends_at / cancel_at_period_end / last_invoice_id",
  operations: [
  {
    kind: "add-column",
    table: "subscriptions",
    ifNotExists: true,
    safeIfTableExists: true,
    column: {
      name: "trial_end",
      type: "bigint"
    }
  },
  {
    kind: "add-column",
    table: "subscriptions",
    ifNotExists: true,
    safeIfTableExists: true,
    column: {
      name: "grace_period_ends_at",
      type: "bigint"
    }
  },
  {
    kind: "add-column",
    table: "subscriptions",
    ifNotExists: true,
    safeIfTableExists: true,
    column: {
      name: "cancel_at_period_end",
      type: "integer",
      nullable: false,
      default: 0
    }
  },
  {
    kind: "add-column",
    table: "subscriptions",
    ifNotExists: true,
    safeIfTableExists: true,
    column: {
      name: "last_invoice_id",
      type: "text"
    }
  }
],
});

import { defineMigration, type Migration } from '../../index.js';

export const v046_migration: Migration = defineMigration({
  kind: 'schema',
  id: '046',
  aliases: { postgres: 'v046', 'sqlite-sql': 'v046' },
  description: "企业集成：tenant enterprise profile / oidc / scim / dedicated deployment",
  operations: [
  {
    kind: "create-table",
    table: {
      name: "tenant_enterprise_profiles",
      ifNotExists: true,
      columns: [
        {
          name: "tenant_id",
          type: "text",
          primaryKey: true
        },
        {
          name: "deployment_mode",
          type: "text",
          nullable: false,
          default: "shared_cluster",
          check: "deployment_mode IN ('shared_cluster', 'dedicated_db')"
        },
        {
          name: "database_isolation_mode",
          type: "text",
          nullable: false,
          default: "shared",
          check: "database_isolation_mode IN ('shared', 'dedicated')"
        },
        {
          name: "kafka_namespace",
          type: "text",
          nullable: false,
          default: ""
        },
        {
          name: "encryption_mode",
          type: "text",
          nullable: false,
          default: "platform_managed",
          check: "encryption_mode IN ('platform_managed', 'tenant_dedicated')"
        },
        {
          name: "kms_key_ref",
          type: "text"
        },
        {
          name: "scim_token_hash",
          type: "text"
        },
        {
          name: "oidc_enabled",
          type: "integer",
          nullable: false,
          default: 0
        },
        {
          name: "oidc_issuer_url",
          type: "text",
          nullable: false,
          default: ""
        },
        {
          name: "oidc_client_id",
          type: "text",
          nullable: false,
          default: ""
        },
        {
          name: "oidc_client_secret_encrypted",
          type: "text",
          nullable: false,
          default: ""
        },
        {
          name: "oidc_audience",
          type: "text",
          nullable: false,
          default: ""
        },
        {
          name: "oidc_scope",
          type: "text",
          nullable: false,
          default: "openid profile email"
        },
        {
          name: "oidc_email_claim",
          type: "text",
          nullable: false,
          default: "email"
        },
        {
          name: "oidc_name_claim",
          type: "text",
          nullable: false,
          default: "name"
        },
        {
          name: "created_at",
          type: "bigint",
          nullable: false
        },
        {
          name: "updated_at",
          type: "bigint",
          nullable: false
        }
      ]
    }
  },
  {
    kind: "create-index",
    index: {
      name: "idx_tenant_enterprise_profiles_scim_hash",
      table: "tenant_enterprise_profiles",
      columns: [
        "scim_token_hash"
      ],
      unique: true,
      ifNotExists: true
    }
  }
],
});

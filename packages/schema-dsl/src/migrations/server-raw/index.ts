import type { RawMigration } from '../../types.js';
import { v007_tenant_id } from './v007.js';
import { v027_identities_avatars_backfill } from './v027.js';
import { v030_check_rewrite } from './v030.js';
import { v034_lifecycle_status_backfill } from './v034.js';
import { v040_audit_log_backfill } from './v040.js';
import { v041_runtime_sessions_rebuild } from './v041.js';
import { v047_identity_avatar_rebuild } from './v047.js';
import { v052_event_ledger_authority_seed } from './v052.js';
import { v071_pg_pgvector } from './v071_pg.js';
import { v072_pg_drop_embedding_json } from './v072_pg_disabled.js';
import { v088_distilled_artifacts_perception_source } from './v088.js';

export { v007_tenant_id } from './v007.js';
export { v027_identities_avatars_backfill } from './v027.js';
export { v030_check_rewrite } from './v030.js';
export { v034_lifecycle_status_backfill } from './v034.js';
export { v040_audit_log_backfill } from './v040.js';
export { v041_runtime_sessions_rebuild } from './v041.js';
export { v047_identity_avatar_rebuild } from './v047.js';
export { v052_event_ledger_authority_seed } from './v052.js';
export { v071_pg_pgvector } from './v071_pg.js';
export { v072_pg_drop_embedding_json } from './v072_pg_disabled.js';
export { v088_distilled_artifacts_perception_source } from './v088.js';

export const RAW_MIGRATIONS: readonly RawMigration[] = [
  v007_tenant_id,
  v027_identities_avatars_backfill,
  v030_check_rewrite,
  v034_lifecycle_status_backfill,
  v040_audit_log_backfill,
  v041_runtime_sessions_rebuild,
  v047_identity_avatar_rebuild,
  v052_event_ledger_authority_seed,
  v071_pg_pgvector,
  v088_distilled_artifacts_perception_source,
];

export const DISABLED_MIGRATIONS: readonly RawMigration[] = [
  v072_pg_drop_embedding_json,
];

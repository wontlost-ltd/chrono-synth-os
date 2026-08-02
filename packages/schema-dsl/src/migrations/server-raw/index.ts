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
import { v106_persona_id_core_isolation } from './v106.js';
import { v107_persona_character_pk } from './v107.js';
import { v119_github_integration } from './v119.js';
import { v120_github_learn_state } from './v120.js';
import { v121_github_reply_drafts } from './v121.js';
import { v122_github_draft_published } from './v122.js';
import { v124_tenant_bootstrap_backfill } from './v124.js';
import { v125_github_digest_discussion_key } from './v125.js';
import { v126_github_learn_state_org_rotation } from './v126.js';

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
export { v106_persona_id_core_isolation } from './v106.js';
export { v107_persona_character_pk } from './v107.js';
export { v119_github_integration } from './v119.js';
export { v120_github_learn_state } from './v120.js';
export { v121_github_reply_drafts } from './v121.js';
export { v122_github_draft_published } from './v122.js';
export { v124_tenant_bootstrap_backfill } from './v124.js';
export { v125_github_digest_discussion_key } from './v125.js';
export { v126_github_learn_state_org_rotation } from './v126.js';

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
  v106_persona_id_core_isolation,
  v107_persona_character_pk,
  v119_github_integration,
  v120_github_learn_state,
  v121_github_reply_drafts,
  v122_github_draft_published,
  v124_tenant_bootstrap_backfill,
  v125_github_digest_discussion_key,
  v126_github_learn_state_org_rotation,
];

export const DISABLED_MIGRATIONS: readonly RawMigration[] = [
  v072_pg_drop_embedding_json,
];

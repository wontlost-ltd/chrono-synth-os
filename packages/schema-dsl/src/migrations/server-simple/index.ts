export { v001_initial_schema } from './v001.js';
export { v002_audit_log } from './v002.js';
export { v003_audit_api_key } from './v003.js';
export { v004_cognitive_memory } from './v004.js';
export { v005_personality_os } from './v005.js';
export { v006_memory_embeddings } from './v006.js';
export { v008_task_queue } from './v008.js';
export { v009_core_values_tuning } from './v009.js';
export { v010_update_gate } from './v010.js';
export { v011_migration } from './v011.js';
export { v012_migration } from './v012.js';
export { v013_migration } from './v013.js';
export { v014_migration } from './v014.js';
export { v015_migration } from './v015.js';
export { v016_migration } from './v016.js';
export { v017_migration } from './v017.js';
export { v018_migration } from './v018.js';
export { v019_migration } from './v019.js';
export { v020_migration } from './v020.js';
export { v021_migration } from './v021.js';
export { v022_migration } from './v022.js';
export { v023_migration } from './v023.js';
export { v024_migration } from './v024.js';
export { v025_migration } from './v025.js';
export { v026_migration } from './v026.js';
export { v028_migration } from './v028.js';
export { v029_migration } from './v029.js';
export { v031_migration } from './v031.js';
export { v032_migration } from './v032.js';
export { v033_migration } from './v033.js';
export { v035_migration } from './v035.js';
export { v036_migration } from './v036.js';
export { v037_migration } from './v037.js';
export { v038_migration } from './v038.js';
export { v039_migration } from './v039.js';
export { v042_migration } from './v042.js';
export { v043_migration } from './v043.js';
export { v044_migration } from './v044.js';
export { v045_migration } from './v045.js';
export { v046_migration } from './v046.js';
export { v048_migration } from './v048.js';
export { v049_migration } from './v049.js';
export { v050_migration } from './v050.js';
export { v051_migration } from './v051.js';
export { v053_migration } from './v053.js';
export { v054_migration } from './v054.js';
export { v055_migration } from './v055.js';
export { v056_migration } from './v056.js';
export { v057_migration } from './v057.js';
export { v058_migration } from './v058.js';
export { v059_migration } from './v059.js';
export { v060_migration } from './v060.js';
export { v061_migration } from './v061.js';
export { v062_migration } from './v062.js';
export { v063_migration } from './v063.js';
export { v064_migration } from './v064.js';
export { v065_migration } from './v065.js';
export { v066_migration } from './v066.js';
export { v067_migration } from './v067.js';
export { v068_migration } from './v068.js';
export { v069_migration } from './v069.js';
export { v070_migration } from './v070.js';
export { v071_migration } from './v071.js';
export { v072_migration } from './v072.js';
export { v073_audit_hash_chain } from './v073.js';
export { v074_soc2_evidence } from './v074.js';
export { v075_legal_holds } from './v075.js';
export { v076_break_glass_jti_consumptions } from './v076.js';
export { v077_audit_chain_anchors } from './v077.js';
export { v078_jwt_signing_keys } from './v078.js';
export { v079_audit_chain_anchor_failures } from './v079.js';
export { v080_distilled_artifacts } from './v080.js';
export { v081_persona_leases } from './v081.js';
export { v082_response_templates } from './v082.js';
export { v083_persona_rules } from './v083.js';
export { v084_llm_provider_credentials } from './v084.js';
export { v085_tenant_llm_settings } from './v085.js';
export { v086_perception_media_refs } from './v086.js';
export { v087_perception_events } from './v087.js';
export { v089_distilled_compiled_via } from './v089.js';
export { v090_persona_governance_policy } from './v090.js';
export { v091_proactive_messages } from './v091.js';
export { v092_notification_preferences } from './v092.js';
export { v093_companion_identity } from './v093.js';
export { v094_memory_translations } from './v094.js';
export { v095_companion_mood } from './v095.js';
export { v096_companion_relationship } from './v096.js';
export { v097_digital_workforce } from './v097.js';
export { v098_workforce_task_contract } from './v098.js';
export { v099_workforce_collaboration } from './v099.js';
export { v100_workforce_handoff } from './v100.js';
export { v101_worker_collaboration_memory } from './v101.js';
export { v102_org_approvals } from './v102.js';
export { v103_org_escalations } from './v103.js';
export { v104_org_tasks_due_at } from './v104.js';
export { v105_org_goals_playbook_version } from './v105.js';

import type { Migration } from '../../index.js';
import { v001_initial_schema } from './v001.js';
import { v002_audit_log } from './v002.js';
import { v003_audit_api_key } from './v003.js';
import { v004_cognitive_memory } from './v004.js';
import { v005_personality_os } from './v005.js';
import { v006_memory_embeddings } from './v006.js';
import { v008_task_queue } from './v008.js';
import { v009_core_values_tuning } from './v009.js';
import { v010_update_gate } from './v010.js';
import { v011_migration } from './v011.js';
import { v012_migration } from './v012.js';
import { v013_migration } from './v013.js';
import { v014_migration } from './v014.js';
import { v015_migration } from './v015.js';
import { v016_migration } from './v016.js';
import { v017_migration } from './v017.js';
import { v018_migration } from './v018.js';
import { v019_migration } from './v019.js';
import { v020_migration } from './v020.js';
import { v021_migration } from './v021.js';
import { v022_migration } from './v022.js';
import { v023_migration } from './v023.js';
import { v024_migration } from './v024.js';
import { v025_migration } from './v025.js';
import { v026_migration } from './v026.js';
import { v028_migration } from './v028.js';
import { v029_migration } from './v029.js';
import { v031_migration } from './v031.js';
import { v032_migration } from './v032.js';
import { v033_migration } from './v033.js';
import { v035_migration } from './v035.js';
import { v036_migration } from './v036.js';
import { v037_migration } from './v037.js';
import { v038_migration } from './v038.js';
import { v039_migration } from './v039.js';
import { v042_migration } from './v042.js';
import { v043_migration } from './v043.js';
import { v044_migration } from './v044.js';
import { v045_migration } from './v045.js';
import { v046_migration } from './v046.js';
import { v048_migration } from './v048.js';
import { v049_migration } from './v049.js';
import { v050_migration } from './v050.js';
import { v051_migration } from './v051.js';
import { v053_migration } from './v053.js';
import { v054_migration } from './v054.js';
import { v055_migration } from './v055.js';
import { v056_migration } from './v056.js';
import { v057_migration } from './v057.js';
import { v058_migration } from './v058.js';
import { v059_migration } from './v059.js';
import { v060_migration } from './v060.js';
import { v061_migration } from './v061.js';
import { v062_migration } from './v062.js';
import { v063_migration } from './v063.js';
import { v064_migration } from './v064.js';
import { v065_migration } from './v065.js';
import { v066_migration } from './v066.js';
import { v067_migration } from './v067.js';
import { v068_migration } from './v068.js';
import { v069_migration } from './v069.js';
import { v070_migration } from './v070.js';
import { v071_migration } from './v071.js';
import { v072_migration } from './v072.js';
import { v073_audit_hash_chain } from './v073.js';
import { v074_soc2_evidence } from './v074.js';
import { v075_legal_holds } from './v075.js';
import { v076_break_glass_jti_consumptions } from './v076.js';
import { v077_audit_chain_anchors } from './v077.js';
import { v078_jwt_signing_keys } from './v078.js';
import { v079_audit_chain_anchor_failures } from './v079.js';
import { v080_distilled_artifacts } from './v080.js';
import { v081_persona_leases } from './v081.js';
import { v082_response_templates } from './v082.js';
import { v083_persona_rules } from './v083.js';
import { v084_llm_provider_credentials } from './v084.js';
import { v085_tenant_llm_settings } from './v085.js';
import { v086_perception_media_refs } from './v086.js';
import { v087_perception_events } from './v087.js';
import { v089_distilled_compiled_via } from './v089.js';
import { v090_persona_governance_policy } from './v090.js';
import { v091_proactive_messages } from './v091.js';
import { v092_notification_preferences } from './v092.js';
import { v093_companion_identity } from './v093.js';
import { v094_memory_translations } from './v094.js';
import { v095_companion_mood } from './v095.js';
import { v096_companion_relationship } from './v096.js';
import { v097_digital_workforce } from './v097.js';
import { v098_workforce_task_contract } from './v098.js';
import { v099_workforce_collaboration } from './v099.js';
import { v100_workforce_handoff } from './v100.js';
import { v101_worker_collaboration_memory } from './v101.js';
import { v102_org_approvals } from './v102.js';
import { v103_org_escalations } from './v103.js';
import { v104_org_tasks_due_at } from './v104.js';
import { v105_org_goals_playbook_version } from './v105.js';

export const SERVER_SIMPLE_MIGRATIONS: readonly Migration[] = [
  v001_initial_schema,
  v002_audit_log,
  v003_audit_api_key,
  v004_cognitive_memory,
  v005_personality_os,
  v006_memory_embeddings,
  v008_task_queue,
  v009_core_values_tuning,
  v010_update_gate,
  v011_migration,
  v012_migration,
  v013_migration,
  v014_migration,
  v015_migration,
  v016_migration,
  v017_migration,
  v018_migration,
  v019_migration,
  v020_migration,
  v021_migration,
  v022_migration,
  v023_migration,
  v024_migration,
  v025_migration,
  v026_migration,
  v028_migration,
  v029_migration,
  v031_migration,
  v032_migration,
  v033_migration,
  v035_migration,
  v036_migration,
  v037_migration,
  v038_migration,
  v039_migration,
  v042_migration,
  v043_migration,
  v044_migration,
  v045_migration,
  v046_migration,
  v048_migration,
  v049_migration,
  v050_migration,
  v051_migration,
  v053_migration,
  v054_migration,
  v055_migration,
  v056_migration,
  v057_migration,
  v058_migration,
  v059_migration,
  v060_migration,
  v061_migration,
  v062_migration,
  v063_migration,
  v064_migration,
  v065_migration,
  v066_migration,
  v067_migration,
  v068_migration,
  v069_migration,
  v070_migration,
  v071_migration,
  v072_migration,
  v073_audit_hash_chain,
  v074_soc2_evidence,
  v075_legal_holds,
  v076_break_glass_jti_consumptions,
  v077_audit_chain_anchors,
  v078_jwt_signing_keys,
  v079_audit_chain_anchor_failures,
  v080_distilled_artifacts,
  v081_persona_leases,
  v082_response_templates,
  v083_persona_rules,
  v084_llm_provider_credentials,
  v085_tenant_llm_settings,
  v086_perception_media_refs,
  v087_perception_events,
  v089_distilled_compiled_via,
  v090_persona_governance_policy,
  v091_proactive_messages,
  v092_notification_preferences,
  v093_companion_identity,
  v094_memory_translations,
  v095_companion_mood,
  v096_companion_relationship,
  v097_digital_workforce,
  v098_workforce_task_contract,
  v099_workforce_collaboration,
  v100_workforce_handoff,
  v101_worker_collaboration_memory,
  v102_org_approvals,
  v103_org_escalations,
  v104_org_tasks_due_at,
  v105_org_goals_playbook_version,
];

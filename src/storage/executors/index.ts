import { registerValueExecutors } from './value-executors.js';
import { registerAnchorExecutors } from './anchor-executors.js';
import { registerNarrativeExecutors } from './narrative-executors.js';
import { registerDecisionStyleExecutors } from './decision-style-executors.js';
import { registerCognitiveModelExecutors } from './cognitive-model-executors.js';
import { registerMemoryExecutors } from './memory-executors.js';
import { registerTaskQueueExecutors } from './task-queue-executors.js';
import { registerAutorunExecutors } from './autorun-executors.js';
import { registerSettlementExecutors } from './settlement-executors.js';
import { registerObservabilityOutboxExecutors } from './observability-outbox-executors.js';
import { registerDlqExecutors } from './dlq-executors.js';
import { registerUsageExecutors } from './usage-executors.js';
import { registerBillingOutboxExecutors } from './billing-outbox-executors.js';
import { registerLifeSimExecutors } from './life-sim-executors.js';
import { registerConfigStoreExecutors } from './config-store-executors.js';
import { registerBillingServiceExecutors } from './billing-service-executors.js';
import { registerAuditLogExecutors } from './audit-log-executors.js';
import { registerComplianceEvidenceExecutors } from './compliance-evidence-executors.js';
import { registerAvatarExecutors } from './avatar-executors.js';
import { registerQuotaExecutors } from './quota-executors.js';
import { registerIdentityExecutors } from './identity-executors.js';
import { registerUserProfileExecutors } from './user-profile-executors.js';
import { registerSnapshotExecutors } from './snapshot-executors.js';
import { registerUpdateGateExecutors } from './update-gate-executors.js';
import { registerDistilledArtifactExecutors } from './distilled-artifact-executors.js';
import { registerConflictExecutors } from './conflict-executors.js';
import { registerAddOnExecutors } from './add-on-executors.js';
import { registerEntitlementExecutors } from './entitlement-executors.js';
import { registerSubscriptionQueryExecutors } from './subscription-query-executors.js';
import { registerApiKeyExecutors } from './api-key-executors.js';
import { registerStripeWebhookExecutors } from './stripe-webhook-executors.js';
import { registerAuthExecutors } from './auth-executors.js';
import { registerCollaborationExecutors } from './collaboration-executors.js';
import { registerMobileDeviceExecutors } from './mobile-device-executors.js';
import { registerDeviceAvatarExecutors } from './device-avatar-executors.js';
import { registerAvatarSnapshotExecutors } from './avatar-snapshot-executors.js';
import { registerOrganizationExecutors } from './organization-executors.js';
import { registerScimExecutors } from './scim-executors.js';
import { registerAdminControlPlaneExecutors } from './admin-control-plane-executors.js';
import { registerTenantProfileExecutors } from './tenant-profile-executors.js';
import { registerPersonaEngineExecutors } from './persona-engine-executors.js';
import { registerCognitiveMemoryExecutors } from './cognitive-memory-executors.js';
import { registerPersonaCoreExecutors } from './persona-core-executors.js';
import { registerKnowledgeSourceExecutors } from './knowledge-source-executors.js';
import { registerMetricsQueryExecutors } from './metrics-query-executors.js';
import { registerIdempotencyExecutors } from './idempotency-executors.js';
import { registerLlmUsageExecutors } from './llm-usage-executors.js';
import { registerEmbeddingExecutors } from './embedding-executors.js';
import { registerEmbeddingPgExecutors } from './embedding-pg-executors.js';
import { registerKafkaNamespaceExecutors } from './kafka-namespace-executors.js';
import { registerKnowledgeRetrieverExecutors } from './knowledge-retriever-executors.js';
import { registerConfirmationTokenExecutors } from './confirmation-token-executors.js';
import { registerConversationMessageExecutors } from './conversation-message-executors.js';
import { registerPersonaTemplateExecutors } from './persona-template-executors.js';
import { registerBulkImportExecutors } from './bulk-import-executors.js';
import { registerToolPermissionExecutors } from './tool-permission-executors.js';
import { registerUserOauthTokenExecutors } from './user-oauth-token-executors.js';
import { registerBreakGlassExecutors } from './break-glass-executors.js';
import { registerPersonaLeaseExecutors } from './persona-lease-executors.js';
import { registerResponseTemplateExecutors } from './response-template-executors.js';
import { registerRuleExecutors } from './rule-executors.js';
import { registerLlmCredentialExecutors } from './llm-credential-executors.js';
import { registerTenantLlmSettingsExecutors } from './tenant-llm-settings-executors.js';
import { registerPerceptionMediaExecutors } from './perception-media-executors.js';
import { registerPerceptionEventExecutors } from './perception-event-executors.js';
import {
  VALUE_QUERY_BY_ID, ANCHOR_QUERY_BY_ID,
  NARRATIVE_QUERY_GET, DECISION_STYLE_QUERY_GET, COGNITIVE_MODEL_QUERY_GET,
  MEM_QUERY_BY_ID, TASK_QUERY_BY_ID, AUTORUN_QUERY_CONFIG,
  SETTLE_QUERY_SETTLEMENTS_BY_TENANT, OBS_QUERY_PENDING_EVENTS,
  DLQ_QUERY_BY_TENANT, USAGE_QUERY_GET, BOUTBOX_QUERY_PENDING,
  LSIM_QUERY_BY_ID, CFG_QUERY_ALL, BSVC_QUERY_LIST_PLANS, AUDIT_QUERY_BY_ID,
  EVIDENCE_QUERY_BY_ID,
  AVT_QUERY_BY_ID, QUOTA_QUERY_LIMIT,
  IDENT_QUERY_BY_USER, UPROF_QUERY_BY_ID,
  SNAP_QUERY_BY_ID, UGATE_QUERY_BY_ID, DISTILL_QUERY_BY_ID, CONFLICT_QUERY_UNRESOLVED,
  ADDON_QUERY_BY_CODE, ENTL_QUERY_PLAN_ID,
  SUBQ_QUERY_LATEST_PLAN, APIKEY_QUERY_LIST,
  SWHS_QUERY_LATEST_SUBSCRIPTION, AUTH_QUERY_USER_BY_EMAIL,
  COLLAB_QUERY_SIMULATION_TENANT, MDEV_QUERY_BY_UID,
  DAVT_QUERY_ACTIVE, ASNAP_QUERY_AUTORUN_CONFIG,
  ORG_QUERY_LIST_BY_USER, SCIM_QUERY_USERS,
  ACP_QUERY_PERSONA_COUNT, TPROF_QUERY_BY_TENANT, PENG_QUERY_BY_ID,
  PCMEM_QUERY_NODE_BY_ID, PCORE_QUERY_SUMMARIES_BY_OWNER,
  KSRC_QUERY_BY_ID, MTRX_QUERY_QUEUE_COUNT, IDEM_QUERY_EXISTING,
  LLM_QUERY_MONTHLY_SUMMARY, EMB_QUERY_BY_MODEL, EMB_QUERY_NEAREST_PG,
  KAFKA_QUERY_TENANT_NAMESPACE,
  KRTV_QUERY_BY_PERSONA,
  CTOKEN_QUERY_BY_ID,
  CMSG_QUERY_COUNT_BY_SESSION,
  PTPL_QUERY_LIST,
  BIMP_QUERY_BY_TENANT_AND_ID,
  TPERM_QUERY_BY_PERSONA_TOOL,
  UOAUTH_QUERY_BY_USER_PROVIDER_SCOPE,
  BG_CMD_INSERT_CONSUMPTION,
  PERSONA_LEASE_QUERY_GET,
  RT_QUERY_LATEST_BY_INTENT,
  RULE_QUERY_ACTIVE_BY_PERSONA,
  LLMCRED_QUERY_BY_TENANT_PROVIDER,
  TENANT_LLM_SETTINGS_QUERY_BY_TENANT,
  MEDIA_REF_QUERY_BY_ID,
  PERCEPTION_EVENT_QUERY_BY_TENANT,
} from '@chrono/kernel';
import { resolveQueryExecutor, resolveCommandExecutor, clearRegistries } from '../legacy-sync-bridge.js';

export function registerCoreSelfExecutors(): void {
  if (!resolveQueryExecutor(VALUE_QUERY_BY_ID)) registerValueExecutors();
  if (!resolveQueryExecutor(ANCHOR_QUERY_BY_ID)) registerAnchorExecutors();
  if (!resolveQueryExecutor(NARRATIVE_QUERY_GET)) registerNarrativeExecutors();
  if (!resolveQueryExecutor(DECISION_STYLE_QUERY_GET)) registerDecisionStyleExecutors();
  if (!resolveQueryExecutor(COGNITIVE_MODEL_QUERY_GET)) registerCognitiveModelExecutors();
  if (!resolveQueryExecutor(MEM_QUERY_BY_ID)) registerMemoryExecutors();
  if (!resolveQueryExecutor(TASK_QUERY_BY_ID)) registerTaskQueueExecutors();
  if (!resolveQueryExecutor(AUTORUN_QUERY_CONFIG)) registerAutorunExecutors();
  if (!resolveQueryExecutor(SETTLE_QUERY_SETTLEMENTS_BY_TENANT)) registerSettlementExecutors();
  if (!resolveQueryExecutor(OBS_QUERY_PENDING_EVENTS)) registerObservabilityOutboxExecutors();
  if (!resolveQueryExecutor(DLQ_QUERY_BY_TENANT)) registerDlqExecutors();
  if (!resolveQueryExecutor(USAGE_QUERY_GET)) registerUsageExecutors();
  if (!resolveQueryExecutor(BOUTBOX_QUERY_PENDING)) registerBillingOutboxExecutors();
  if (!resolveQueryExecutor(LSIM_QUERY_BY_ID)) registerLifeSimExecutors();
  if (!resolveQueryExecutor(CFG_QUERY_ALL)) registerConfigStoreExecutors();
  if (!resolveQueryExecutor(BSVC_QUERY_LIST_PLANS)) registerBillingServiceExecutors();
  if (!resolveQueryExecutor(AUDIT_QUERY_BY_ID)) registerAuditLogExecutors();
  if (!resolveQueryExecutor(EVIDENCE_QUERY_BY_ID)) registerComplianceEvidenceExecutors();
  if (!resolveQueryExecutor(AVT_QUERY_BY_ID)) registerAvatarExecutors();
  if (!resolveQueryExecutor(QUOTA_QUERY_LIMIT)) registerQuotaExecutors();
  if (!resolveQueryExecutor(IDENT_QUERY_BY_USER)) registerIdentityExecutors();
  if (!resolveQueryExecutor(UPROF_QUERY_BY_ID)) registerUserProfileExecutors();
  if (!resolveQueryExecutor(SNAP_QUERY_BY_ID)) registerSnapshotExecutors();
  if (!resolveQueryExecutor(UGATE_QUERY_BY_ID)) registerUpdateGateExecutors();
  if (!resolveQueryExecutor(DISTILL_QUERY_BY_ID)) registerDistilledArtifactExecutors();
  if (!resolveQueryExecutor(CONFLICT_QUERY_UNRESOLVED)) registerConflictExecutors();
  if (!resolveQueryExecutor(ADDON_QUERY_BY_CODE)) registerAddOnExecutors();
  if (!resolveQueryExecutor(ENTL_QUERY_PLAN_ID)) registerEntitlementExecutors();
  if (!resolveQueryExecutor(SUBQ_QUERY_LATEST_PLAN)) registerSubscriptionQueryExecutors();
  if (!resolveQueryExecutor(APIKEY_QUERY_LIST)) registerApiKeyExecutors();
  if (!resolveQueryExecutor(SWHS_QUERY_LATEST_SUBSCRIPTION)) registerStripeWebhookExecutors();
  if (!resolveQueryExecutor(AUTH_QUERY_USER_BY_EMAIL)) registerAuthExecutors();
  if (!resolveQueryExecutor(COLLAB_QUERY_SIMULATION_TENANT)) registerCollaborationExecutors();
  if (!resolveQueryExecutor(MDEV_QUERY_BY_UID)) registerMobileDeviceExecutors();
  if (!resolveQueryExecutor(DAVT_QUERY_ACTIVE)) registerDeviceAvatarExecutors();
  if (!resolveQueryExecutor(ASNAP_QUERY_AUTORUN_CONFIG)) registerAvatarSnapshotExecutors();
  if (!resolveQueryExecutor(ORG_QUERY_LIST_BY_USER)) registerOrganizationExecutors();
  if (!resolveQueryExecutor(SCIM_QUERY_USERS)) registerScimExecutors();
  if (!resolveQueryExecutor(ACP_QUERY_PERSONA_COUNT)) registerAdminControlPlaneExecutors();
  if (!resolveQueryExecutor(TPROF_QUERY_BY_TENANT)) registerTenantProfileExecutors();
  if (!resolveQueryExecutor(PENG_QUERY_BY_ID)) registerPersonaEngineExecutors();
  if (!resolveQueryExecutor(PCMEM_QUERY_NODE_BY_ID)) registerCognitiveMemoryExecutors();
  if (!resolveQueryExecutor(PCORE_QUERY_SUMMARIES_BY_OWNER)) registerPersonaCoreExecutors();
  if (!resolveQueryExecutor(KSRC_QUERY_BY_ID)) registerKnowledgeSourceExecutors();
  if (!resolveQueryExecutor(MTRX_QUERY_QUEUE_COUNT)) registerMetricsQueryExecutors();
  if (!resolveQueryExecutor(IDEM_QUERY_EXISTING)) registerIdempotencyExecutors();
  if (!resolveQueryExecutor(LLM_QUERY_MONTHLY_SUMMARY)) registerLlmUsageExecutors();
  if (!resolveQueryExecutor(EMB_QUERY_BY_MODEL)) registerEmbeddingExecutors();
  if (!resolveQueryExecutor(EMB_QUERY_NEAREST_PG)) registerEmbeddingPgExecutors();
  if (!resolveQueryExecutor(KAFKA_QUERY_TENANT_NAMESPACE)) registerKafkaNamespaceExecutors();
  if (!resolveQueryExecutor(KRTV_QUERY_BY_PERSONA)) registerKnowledgeRetrieverExecutors();
  if (!resolveQueryExecutor(CTOKEN_QUERY_BY_ID)) registerConfirmationTokenExecutors();
  if (!resolveQueryExecutor(CMSG_QUERY_COUNT_BY_SESSION)) registerConversationMessageExecutors();
  if (!resolveQueryExecutor(PTPL_QUERY_LIST)) registerPersonaTemplateExecutors();
  if (!resolveQueryExecutor(BIMP_QUERY_BY_TENANT_AND_ID)) registerBulkImportExecutors();
  if (!resolveQueryExecutor(TPERM_QUERY_BY_PERSONA_TOOL)) registerToolPermissionExecutors();
  if (!resolveQueryExecutor(UOAUTH_QUERY_BY_USER_PROVIDER_SCOPE)) registerUserOauthTokenExecutors();
  if (!resolveCommandExecutor(BG_CMD_INSERT_CONSUMPTION)) registerBreakGlassExecutors();
  if (!resolveQueryExecutor(PERSONA_LEASE_QUERY_GET)) registerPersonaLeaseExecutors();
  if (!resolveQueryExecutor(RT_QUERY_LATEST_BY_INTENT)) registerResponseTemplateExecutors();
  if (!resolveQueryExecutor(RULE_QUERY_ACTIVE_BY_PERSONA)) registerRuleExecutors();
  if (!resolveQueryExecutor(LLMCRED_QUERY_BY_TENANT_PROVIDER)) registerLlmCredentialExecutors();
  if (!resolveQueryExecutor(TENANT_LLM_SETTINGS_QUERY_BY_TENANT)) registerTenantLlmSettingsExecutors();
  if (!resolveQueryExecutor(MEDIA_REF_QUERY_BY_ID)) registerPerceptionMediaExecutors();
  if (!resolveQueryExecutor(PERCEPTION_EVENT_QUERY_BY_TENANT)) registerPerceptionEventExecutors();
}

/** 重置注册状态（仅测试用途） */
export function resetCoreSelfExecutors(): void {
  clearRegistries();
}

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
import { registerAvatarExecutors } from './avatar-executors.js';
import { registerQuotaExecutors } from './quota-executors.js';
import { registerIdentityExecutors } from './identity-executors.js';
import { registerUserProfileExecutors } from './user-profile-executors.js';
import { registerSnapshotExecutors } from './snapshot-executors.js';
import { registerUpdateGateExecutors } from './update-gate-executors.js';
import { registerConflictExecutors } from './conflict-executors.js';
import { registerAddOnExecutors } from './add-on-executors.js';
import { registerEntitlementExecutors } from './entitlement-executors.js';
import { registerSubscriptionQueryExecutors } from './subscription-query-executors.js';
import { registerApiKeyExecutors } from './api-key-executors.js';
import { registerStripeWebhookExecutors } from './stripe-webhook-executors.js';
import { registerAuthExecutors } from './auth-executors.js';
import {
  VALUE_QUERY_BY_ID, ANCHOR_QUERY_BY_ID,
  NARRATIVE_QUERY_GET, DECISION_STYLE_QUERY_GET, COGNITIVE_MODEL_QUERY_GET,
  MEM_QUERY_BY_ID, TASK_QUERY_BY_ID, AUTORUN_QUERY_CONFIG,
  SETTLE_QUERY_SETTLEMENTS_BY_TENANT, OBS_QUERY_PENDING_EVENTS,
  DLQ_QUERY_BY_TENANT, USAGE_QUERY_GET, BOUTBOX_QUERY_PENDING,
  LSIM_QUERY_BY_ID, CFG_QUERY_ALL, BSVC_QUERY_LIST_PLANS, AUDIT_QUERY_BY_ID,
  AVT_QUERY_BY_ID, QUOTA_QUERY_LIMIT,
  IDENT_QUERY_BY_USER, UPROF_QUERY_BY_ID,
  SNAP_QUERY_BY_ID, UGATE_QUERY_BY_ID, CONFLICT_QUERY_UNRESOLVED,
  ADDON_QUERY_BY_CODE, ENTL_QUERY_PLAN_ID,
  SUBQ_QUERY_LATEST_PLAN, APIKEY_QUERY_LIST,
  SWHS_QUERY_LATEST_SUBSCRIPTION, AUTH_QUERY_USER_BY_EMAIL,
} from '@chrono/kernel';
import { resolveQueryExecutor, clearRegistries } from '../legacy-sync-bridge.js';

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
  if (!resolveQueryExecutor(AVT_QUERY_BY_ID)) registerAvatarExecutors();
  if (!resolveQueryExecutor(QUOTA_QUERY_LIMIT)) registerQuotaExecutors();
  if (!resolveQueryExecutor(IDENT_QUERY_BY_USER)) registerIdentityExecutors();
  if (!resolveQueryExecutor(UPROF_QUERY_BY_ID)) registerUserProfileExecutors();
  if (!resolveQueryExecutor(SNAP_QUERY_BY_ID)) registerSnapshotExecutors();
  if (!resolveQueryExecutor(UGATE_QUERY_BY_ID)) registerUpdateGateExecutors();
  if (!resolveQueryExecutor(CONFLICT_QUERY_UNRESOLVED)) registerConflictExecutors();
  if (!resolveQueryExecutor(ADDON_QUERY_BY_CODE)) registerAddOnExecutors();
  if (!resolveQueryExecutor(ENTL_QUERY_PLAN_ID)) registerEntitlementExecutors();
  if (!resolveQueryExecutor(SUBQ_QUERY_LATEST_PLAN)) registerSubscriptionQueryExecutors();
  if (!resolveQueryExecutor(APIKEY_QUERY_LIST)) registerApiKeyExecutors();
  if (!resolveQueryExecutor(SWHS_QUERY_LATEST_SUBSCRIPTION)) registerStripeWebhookExecutors();
  if (!resolveQueryExecutor(AUTH_QUERY_USER_BY_EMAIL)) registerAuthExecutors();
}

/** 重置注册状态（仅测试用途） */
export function resetCoreSelfExecutors(): void {
  clearRegistries();
}

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
import {
  VALUE_QUERY_BY_ID, ANCHOR_QUERY_BY_ID,
  NARRATIVE_QUERY_GET, DECISION_STYLE_QUERY_GET, COGNITIVE_MODEL_QUERY_GET,
  MEM_QUERY_BY_ID, TASK_QUERY_BY_ID, AUTORUN_QUERY_CONFIG,
  SETTLE_QUERY_SETTLEMENTS_BY_TENANT, OBS_QUERY_PENDING_EVENTS,
  DLQ_QUERY_BY_TENANT, USAGE_QUERY_GET, BOUTBOX_QUERY_PENDING,
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
}

/** 重置注册状态（仅测试用途） */
export function resetCoreSelfExecutors(): void {
  clearRegistries();
}

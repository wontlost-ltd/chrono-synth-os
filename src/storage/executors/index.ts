import { registerValueExecutors } from './value-executors.js';
import { registerAnchorExecutors } from './anchor-executors.js';
import { registerNarrativeExecutors } from './narrative-executors.js';
import { registerDecisionStyleExecutors } from './decision-style-executors.js';
import { registerCognitiveModelExecutors } from './cognitive-model-executors.js';
import { registerMemoryExecutors } from './memory-executors.js';
import { registerTaskQueueExecutors } from './task-queue-executors.js';
import {
  VALUE_QUERY_BY_ID, ANCHOR_QUERY_BY_ID,
  NARRATIVE_QUERY_GET, DECISION_STYLE_QUERY_GET, COGNITIVE_MODEL_QUERY_GET,
  MEM_QUERY_BY_ID, TASK_QUERY_BY_ID,
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
}

/** 重置注册状态（仅测试用途） */
export function resetCoreSelfExecutors(): void {
  clearRegistries();
}

import { registerValueExecutors } from './value-executors.js';
import { registerAnchorExecutors } from './anchor-executors.js';
import { VALUE_QUERY_BY_ID, ANCHOR_QUERY_BY_ID } from '@chrono/kernel';
import { resolveQueryExecutor, clearRegistries } from '../legacy-sync-bridge.js';

export function registerCoreSelfExecutors(): void {
  if (resolveQueryExecutor(VALUE_QUERY_BY_ID) && resolveQueryExecutor(ANCHOR_QUERY_BY_ID)) return;
  registerValueExecutors();
  registerAnchorExecutors();
}

/** 重置注册状态（仅测试用途） */
export function resetCoreSelfExecutors(): void {
  clearRegistries();
}

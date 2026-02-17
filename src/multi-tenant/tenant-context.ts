/**
 * 租户上下文
 * 基于 AsyncLocalStorage 在异步调用链中传播租户标识
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export const DEFAULT_TENANT_ID = 'default';

/** 租户 ID 合法字符：字母数字、下划线、连字符，长度 1-64 */
const TENANT_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

const storage = new AsyncLocalStorage<{ tenantId: string }>();

/** 标准化并验证租户 ID */
export function normalizeTenantId(raw: string | undefined | null): string {
  if (!raw) return DEFAULT_TENANT_ID;
  const trimmed = raw.trim();
  if (!trimmed) return DEFAULT_TENANT_ID;
  if (!TENANT_ID_RE.test(trimmed)) {
    throw new RangeError(`无效的租户 ID: "${trimmed}"（仅允许字母数字、下划线、连字符，最长 64 字符）`);
  }
  return trimmed;
}

/** 在指定租户上下文中执行函数 */
export function runWithTenant<T>(tenantId: string, fn: () => T): T {
  return storage.run({ tenantId: normalizeTenantId(tenantId) }, fn);
}

/** 获取当前租户 ID（不在租户上下文中时返回默认值） */
export function getTenantId(): string {
  return storage.getStore()?.tenantId ?? DEFAULT_TENANT_ID;
}

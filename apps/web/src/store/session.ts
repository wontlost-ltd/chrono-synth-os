import { useSyncExternalStore } from 'react';

export type UserMode = 'demo' | 'subscriber';

export interface AuthUser {
  email: string;
  role: string;
  userId: string;
}

interface Session {
  apiKey: string;
  tenantId: string;
  mode: UserMode;
  /** access token 仅存内存，不持久化到 localStorage */
  accessToken: string;
  user: AuthUser | null;
}

/** localStorage 中仅保存非敏感状态 */
interface PersistedSession {
  apiKey: string;
  tenantId: string;
  mode: UserMode;
  user: AuthUser | null;
}

const STORAGE_KEY = 'chrono-session';

function load(): Session {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const persisted = JSON.parse(raw) as PersistedSession;
      return { ...persisted, accessToken: '' };
    }
  } catch { /* ignore */ }
  return { apiKey: '', tenantId: 'default', mode: 'demo', accessToken: '', user: null };
}

let current = load();
const listeners = new Set<() => void>();

/*
 * 会话 epoch：每次「身份级」会话变更（登录写 token、登出清会话）自增。在途 refresh 捕获当时
 * 的 epoch，应用结果前校验 epoch 未变——否则该 refresh 已被后续 login/logout 作废，丢弃不清会话。
 * 用于消除「单个端点的陈旧 401 清掉刚换的新会话 / 瞬时失败误登出」隐患。
 */
let epoch = 0;
export function getSessionEpoch(): number {
  return epoch;
}

function emitChange(): void {
  for (const fn of listeners) fn();
}

export function getSession(): Readonly<Session> {
  return current;
}

export function setSession(patch: Partial<Session>): void {
  /* 身份级变更（apiKey/user 切换，或 accessToken 从无到有=登录）→ 自增 epoch，作废在途 refresh。
   * 纯 token 续期（已有 token 换新 token，apiKey/user 不变）不算身份变更，不自增。 */
  const identityChanged =
    (patch.apiKey !== undefined && patch.apiKey !== current.apiKey) ||
    (patch.user !== undefined && patch.user !== current.user) ||
    (patch.accessToken !== undefined && !current.accessToken && !!patch.accessToken && !current.apiKey);
  if (identityChanged) epoch += 1;
  current = { ...current, ...patch };
  /* 仅持久化非敏感字段，accessToken 保留在内存 */
  const persisted: PersistedSession = {
    apiKey: current.apiKey,
    tenantId: current.tenantId,
    mode: current.mode,
    user: current.user,
  };
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted)); } catch { /* storage unavailable */ }
  emitChange();
}

export function clearSession(): void {
  epoch += 1;
  current = { apiKey: '', tenantId: 'default', mode: 'demo', accessToken: '', user: null };
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  emitChange();
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

export function useSession(): Readonly<Session> {
  return useSyncExternalStore(subscribe, getSession, getSession);
}

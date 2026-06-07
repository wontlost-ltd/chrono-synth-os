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

function emitChange(): void {
  for (const fn of listeners) fn();
}

export function getSession(): Readonly<Session> {
  return current;
}

export function setSession(patch: Partial<Session>): void {
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

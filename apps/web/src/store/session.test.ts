import { describe, it, expect, beforeEach } from 'vitest';
import { getSession, setSession, clearSession } from './session';

beforeEach(() => {
  localStorage.clear();
  clearSession();
});

describe('getSession', () => {
  it('returns default session when storage is empty', () => {
    const session = getSession();
    expect(session.apiKey).toBe('');
    expect(session.tenantId).toBe('default');
    expect(session.mode).toBe('demo');
    expect(session.accessToken).toBe('');
    expect(session.user).toBeNull();
  });
});

describe('setSession', () => {
  it('updates session with partial patch', () => {
    setSession({ apiKey: 'test-key' });
    const session = getSession();
    expect(session.apiKey).toBe('test-key');
    expect(session.tenantId).toBe('default');
  });

  it('persists to localStorage', () => {
    setSession({ tenantId: 'tenant-1', mode: 'subscriber' });
    const raw = localStorage.getItem('chrono-session');
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!);
    expect(parsed.tenantId).toBe('tenant-1');
    expect(parsed.mode).toBe('subscriber');
  });

  it('merges multiple patches', () => {
    setSession({ apiKey: 'key-1' });
    setSession({ tenantId: 'tenant-2' });
    const session = getSession();
    expect(session.apiKey).toBe('key-1');
    expect(session.tenantId).toBe('tenant-2');
  });

  it('updates mode correctly', () => {
    setSession({ mode: 'subscriber' });
    expect(getSession().mode).toBe('subscriber');
    setSession({ mode: 'demo' });
    expect(getSession().mode).toBe('demo');
  });

  it('stores JWT access token in memory', () => {
    setSession({ accessToken: 'at-123' });
    const session = getSession();
    expect(session.accessToken).toBe('at-123');
    /* accessToken 不持久化到 localStorage */
    const raw = localStorage.getItem('chrono-session');
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!);
    expect(parsed.accessToken).toBeUndefined();
  });

  it('stores user info', () => {
    setSession({ user: { email: 'test@example.com', role: 'admin', userId: 'user-1' } });
    const session = getSession();
    expect(session.user?.email).toBe('test@example.com');
    expect(session.user?.role).toBe('admin');
  });
});

describe('clearSession', () => {
  it('resets to default values', () => {
    setSession({ accessToken: 'token', user: { email: 'a@b.c', role: 'admin', userId: 'u1' } });
    clearSession();
    const session = getSession();
    expect(session.accessToken).toBe('');
    expect(session.user).toBeNull();
    expect(session.mode).toBe('demo');
  });
});

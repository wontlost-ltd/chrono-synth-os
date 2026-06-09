/**
 * 移动端 API 客户端
 * 与 Web 端 apiFetch 对齐，使用 expo-secure-store 存储 token
 */

const API_BASE_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000';

interface Session {
  accessToken: string | null;
  tenantId: string | null;
}

let session: Session = { accessToken: null, tenantId: null };

export function setSession(s: Partial<Session>) {
  session = { ...session, ...s };
}

export function clearSession() {
  session = { accessToken: null, tenantId: null };
}

/** 是否已配置会话（有 access token）——plan 探测前先判断，未登录直接视作「未配置」。 */
export function hasSession(): boolean {
  return session.accessToken != null;
}

/**
 * 只取某路径的 HTTP 状态码（不解析响应体，不抛 non-ok）。
 * 供 plan 探测用——靠 /companion/me 的 200/403 区分个人版/企业版。网络异常返回 0（不可达）。
 */
export async function probeStatus(path: string): Promise<number> {
  const headers: Record<string, string> = {};
  if (session.accessToken) headers['Authorization'] = `Bearer ${session.accessToken}`;
  if (session.tenantId) headers['X-Tenant-Id'] = session.tenantId;
  try {
    const res = await fetch(`${API_BASE_URL}${path}`, { method: 'GET', headers });
    return res.status;
  } catch {
    return 0;
  }
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {};

  if (session.accessToken) {
    headers['Authorization'] = `Bearer ${session.accessToken}`;
  }
  if (session.tenantId) {
    headers['X-Tenant-Id'] = session.tenantId;
  }

  const method = init?.method?.toUpperCase() ?? 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: { ...headers, ...init?.headers },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API ${res.status}: ${text.slice(0, 200)}`);
  }

  if (res.status === 204) return undefined as T;

  const json = await res.json() as { data?: T };
  return (json.data ?? json) as T;
}

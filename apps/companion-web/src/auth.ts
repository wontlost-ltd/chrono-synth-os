/**
 * Companion 会话层（alpha）。
 *
 * 后端 /api/v1/auth/login 在响应体里返回 accessToken（短期，Bearer），并把 refreshToken
 * 写进 HttpOnly cookie（Path=/api/v1/auth）。因此 SPA 必须：
 *   - 自己持有 accessToken（内存，不落 localStorage —— 降低 XSS 窃取面），随请求带
 *     Authorization: Bearer；
 *   - accessToken 过期（401）时用 /api/v1/auth/refresh（refresh cookie 自动随同 Path 发送）
 *     换新 accessToken，失败则要求重新登录。
 *
 * 仅内存态：刷新页面需重新登录（用 refresh cookie 静默续期是后续项）。这是 alpha 切片把
 * 「鉴权闭环」打通的最小实现，替代之前 credentials:'include' 取不到 access token 的错误假设。
 */

interface Session {
  accessToken: string;
  tenantId: string;
}

let session: Session | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

/** 订阅会话变化（登录/登出/刷新失败），用于驱动 UI 在登录页与主界面间切换。 */
export function subscribeAuth(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getSession(): Session | null {
  return session;
}

export function isAuthenticated(): boolean {
  return session !== null;
}

interface LoginResult {
  accessToken: string;
  tenantId: string;
}

/** 登录：成功后持有 accessToken + tenantId 并通知订阅者。 */
export async function login(email: string, password: string): Promise<void> {
  const res = await fetch('/api/v1/auth/login', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    throw new Error(res.status === 401 ? '邮箱或密码错误' : `登录失败 (${res.status})`);
  }
  const body = (await res.json()) as { data?: LoginResult };
  if (!body.data?.accessToken || !body.data?.tenantId) {
    throw new Error('登录响应缺少令牌');
  }
  session = { accessToken: body.data.accessToken, tenantId: body.data.tenantId };
  emit();
}

/** 用 refresh cookie 换新 accessToken；成功返回 true。失败则清空会话并返回 false。 */
export async function tryRefresh(): Promise<boolean> {
  try {
    const res = await fetch('/api/v1/auth/refresh', {
      method: 'POST',
      credentials: 'include',
      headers: { accept: 'application/json' },
    });
    if (!res.ok) { clearSession(); return false; }
    const body = (await res.json()) as { data?: LoginResult };
    if (!body.data?.accessToken || !body.data?.tenantId) { clearSession(); return false; }
    session = { accessToken: body.data.accessToken, tenantId: body.data.tenantId };
    emit();
    return true;
  } catch {
    clearSession();
    return false;
  }
}

export function clearSession(): void {
  if (session === null) return;
  session = null;
  emit();
}

/** 登出：通知后端吊销 + 清空本地会话。 */
export async function logout(): Promise<void> {
  const token = session?.accessToken;
  clearSession();
  try {
    await fetch('/api/v1/auth/logout', {
      method: 'POST',
      credentials: 'include',
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
  } catch {
    /* 本地已清空，吊销失败可忽略 */
  }
}

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

/* 会话 epoch：每次 login 开始 / logout 都自增。在途 refresh 捕获当前 epoch，应用结果前
 * 校验 epoch 未变——否则该 refresh 已被后续 login/logout 作废（防 refresh-vs-logout/login
 * 竞态把陈旧会话写回）。single-flight 只解决 refresh-vs-refresh，epoch 解决其余交错。 */
let epoch = 0;

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
  epoch += 1; /* 作废任何在途 refresh：本次登录是新的权威会话 */
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

/** 读取非 HttpOnly 的 csrf_token cookie（后端 login 写、Path=/，供 SPA 双提交）。 */
function readCsrfToken(): string | null {
  for (const part of document.cookie.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === 'csrf_token') return part.slice(eq + 1).trim();
  }
  return null;
}

/** cookie-auth 的状态变更 POST（refresh/logout）必须带 x-csrf-token（后端 csrf.ts 双提交校验）。 */
function csrfHeaders(): Record<string, string> {
  const token = readCsrfToken();
  return token ? { 'x-csrf-token': token } : {};
}

/**
 * refresh 结果三态——调用方（api.ts）据此决定是否清会话：
 *   - 'refreshed'：拿到新 accessToken，会话已更新。
 *   - 'failed'：refresh 真实失败（cookie 过期/无效），应清会话回登录。
 *   - 'superseded'：期间发生了 login/logout（epoch 变），本次结果作废；**不得**清会话
 *     （已有更新的权威会话），调用方应放弃本次重试但保留当前会话。
 * 用三态而非 boolean 是为消除「discarded 与 failed 同为 false」导致调用方误清新会话的歧义。
 */
export type RefreshOutcome = 'refreshed' | 'failed' | 'superseded';

/* refresh single-flight：后端每次 refresh 都吊销旧 refresh token，并发 401 若各自 refresh
 * 会互相作废 → 误登出。用模块级 promise 合并并发 refresh，所有等待者共享同一结果。 */
let refreshPromise: Promise<RefreshOutcome> | null = null;

async function doRefresh(): Promise<RefreshOutcome> {
  const startedEpoch = epoch; /* 捕获本次 refresh 的会话世代 */
  try {
    const res = await fetch('/api/v1/auth/refresh', {
      method: 'POST',
      credentials: 'include',
      headers: { accept: 'application/json', ...csrfHeaders() },
    });
    /* 期间发生了 login/logout（epoch 变了）→ 本次 refresh 结果已陈旧，丢弃不写回也不清会话。 */
    if (epoch !== startedEpoch) return 'superseded';
    if (!res.ok) { clearSession(); return 'failed'; }
    const body = (await res.json()) as { data?: LoginResult };
    if (epoch !== startedEpoch) return 'superseded';
    if (!body.data?.accessToken || !body.data?.tenantId) { clearSession(); return 'failed'; }
    session = { accessToken: body.data.accessToken, tenantId: body.data.tenantId };
    emit();
    return 'refreshed';
  } catch {
    if (epoch === startedEpoch) { clearSession(); return 'failed'; }
    return 'superseded';
  }
}

/** 用 refresh cookie 换新 accessToken。并发调用共享同一次 refresh（single-flight）。 */
export async function tryRefresh(): Promise<RefreshOutcome> {
  if (refreshPromise) return refreshPromise;
  refreshPromise = doRefresh().finally(() => { refreshPromise = null; });
  return refreshPromise;
}

export function clearSession(): void {
  if (session === null) return;
  session = null;
  emit();
}

/** 登出：通知后端吊销 refresh cookie + 清空本地会话。logout 走 cookie-auth，需带 CSRF header。 */
export async function logout(): Promise<void> {
  epoch += 1; /* 作废任何在途 refresh：登出后 refresh 结果不得把会话写回 */
  const token = session?.accessToken;
  const headers: Record<string, string> = { ...csrfHeaders() };
  if (token) headers.authorization = `Bearer ${token}`;
  /* 先发请求（此时 csrf_token cookie 仍在，用于完成服务器吊销），再清本地会话。 */
  try {
    await fetch('/api/v1/auth/logout', { method: 'POST', credentials: 'include', headers });
  } catch {
    /* 吊销失败可忽略：本地仍会清空 */
  }
  clearSession();
}

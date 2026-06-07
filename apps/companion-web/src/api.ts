/**
 * Companion 后端读取客户端 —— 端到端类型来自 @chrono/contracts（与后端同源）。
 *
 * 鉴权：带 Authorization: Bearer <accessToken>（来自 auth.ts 会话）+ x-tenant-id。
 * accessToken 过期（401）时自动用 refresh cookie 续期一次再重试；仍失败则抛 ApiAuthError，
 * UI 退回登录页。响应用契约 schema 在运行时校验（后端漂移即报错，不静默渲染错数据）。
 */

import {
  CompanionMeV1Schema,
  CompanionGrowthV1Schema,
  type CompanionMeV1,
  type CompanionGrowthV1,
} from '@chrono/contracts';
import { getSession, tryRefresh, clearSession } from './auth.js';

/** 鉴权失败（未登录 / 续期失败 / plan 不符）——UI 据此回登录页或提示切换账号。 */
export class ApiAuthError extends Error {
  constructor(public readonly status: number) {
    super(status === 403 ? '当前账号无权访问 companion' : '请先登录');
    this.name = 'ApiAuthError';
  }
}

function authedHeaders(): Record<string, string> {
  const session = getSession();
  const headers: Record<string, string> = { accept: 'application/json' };
  if (session) {
    headers.authorization = `Bearer ${session.accessToken}`;
    headers['x-tenant-id'] = session.tenantId;
  }
  return headers;
}

/** GET + 统一信封 { data: T }；401 时刷新重试一次。403 直接抛（plan/权限问题，刷新无济于事）。 */
async function getData(url: string): Promise<unknown> {
  let res = await fetch(url, { method: 'GET', credentials: 'include', headers: authedHeaders() });

  if (res.status === 401 && (await tryRefresh())) {
    res = await fetch(url, { method: 'GET', credentials: 'include', headers: authedHeaders() });
  }

  if (res.status === 401) {
    clearSession();
    throw new ApiAuthError(401);
  }
  if (res.status === 403) {
    throw new ApiAuthError(403);
  }
  if (!res.ok) {
    throw new Error(`请求失败 ${res.status}: ${url}`);
  }
  const body = (await res.json()) as { data?: unknown };
  return body.data;
}

export async function fetchMe(): Promise<CompanionMeV1> {
  return CompanionMeV1Schema.parse(await getData('/api/v1/companion/me'));
}

export async function fetchGrowth(): Promise<CompanionGrowthV1> {
  return CompanionGrowthV1Schema.parse(await getData('/api/v1/companion/me/growth'));
}

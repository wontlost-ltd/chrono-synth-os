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
  CompanionMemoryListV1Schema,
  CompanionNudgeListV1Schema,
  CompanionPerceiveResultV1Schema,
  CompanionChatResultV1Schema,
  type CompanionMeV1,
  type CompanionGrowthV1,
  type CompanionMemoryListV1,
  type CompanionNudgeListV1,
  type CompanionPerceiveRequestV1,
  type CompanionPerceiveResultV1,
  type CompanionChatResultV1,
} from '@chrono/contracts';
import { getSession, tryRefresh } from './auth.js';
import { decide401Action } from './api-retry.js';

/** 鉴权失败（未登录 / 续期失败 / plan 不符）——UI 据此回登录页或提示切换账号。 */
export class ApiAuthError extends Error {
  /* 显式字段赋值（非参数属性），以便 Node 原生 strip-only TS 在测试中可加载本模块。 */
  readonly status: number;
  constructor(status: number) {
    super(status === 403 ? '当前账号无权访问 companion' : '请先登录');
    this.name = 'ApiAuthError';
    this.status = status;
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

/** GET + 统一信封 { data: T }；401 时按会话身份决策刷新/重试。403 直接抛（plan/权限，刷新无益）。 */
async function getData(url: string): Promise<unknown> {
  const sentToken = getSession()?.accessToken ?? null;
  let res = await fetch(url, { method: 'GET', credentials: 'include', headers: authedHeaders() });

  if (res.status === 401) {
    const action = decide401Action(sentToken, getSession()?.accessToken ?? null);
    if (action === 'refresh') {
      const outcome = await tryRefresh();
      if (outcome === 'refreshed' || outcome === 'superseded') {
        res = await fetch(url, { method: 'GET', credentials: 'include', headers: authedHeaders() });
      }
      /* outcome==='failed' 不重试，按 401 处理（auth.ts 已对**本会话**清理）。 */
    } else {
      /* 陈旧 401（会话已被并发 login/logout 换掉）：用当前会话重试一次，绝不 refresh/清会话。 */
      res = await fetch(url, { method: 'GET', credentials: 'include', headers: authedHeaders() });
    }
  }

  if (res.status === 401) {
    /* 不在此处 clearSession——避免清掉期间产生的新会话；本会话失败清理已由 auth.ts 内做。 */
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

/** POST + 统一信封 { data: T }；401 刷新/重试与 getData 同款。400 抛带消息错误（契约校验失败）。 */
async function postData(url: string, payload: unknown): Promise<unknown> {
  const sentToken = getSession()?.accessToken ?? null;
  const doPost = (): Promise<Response> => fetch(url, {
    method: 'POST', credentials: 'include',
    headers: { ...authedHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  let res = await doPost();

  if (res.status === 401) {
    const action = decide401Action(sentToken, getSession()?.accessToken ?? null);
    if (action === 'refresh') {
      const outcome = await tryRefresh();
      if (outcome === 'refreshed' || outcome === 'superseded') res = await doPost();
    } else {
      res = await doPost();
    }
  }

  if (res.status === 401) throw new ApiAuthError(401);
  if (res.status === 403) throw new ApiAuthError(403);
  if (!res.ok) throw new Error(`请求失败 ${res.status}: ${url}`);
  const body = (await res.json()) as { data?: unknown };
  return body.data;
}

/** 「让 TA 听/看一段」：提交中间表征 → 人格沉淀记忆 → 返回人格记住的。 */
export async function perceive(input: CompanionPerceiveRequestV1): Promise<CompanionPerceiveResultV1> {
  return CompanionPerceiveResultV1Schema.parse(await postData('/api/v1/companion/me/perceive', input));
}

/** 跟数字人对话（零-LLM 确定性回应，据人格记忆生成）。 */
export async function chat(message: string): Promise<CompanionChatResultV1> {
  return CompanionChatResultV1Schema.parse(await postData('/api/v1/companion/me/chat', { message }));
}

export async function fetchMe(): Promise<CompanionMeV1> {
  return CompanionMeV1Schema.parse(await getData('/api/v1/companion/me'));
}

export async function fetchGrowth(): Promise<CompanionGrowthV1> {
  return CompanionGrowthV1Schema.parse(await getData('/api/v1/companion/me/growth'));
}

export async function fetchMemories(page: number, pageSize = 20): Promise<CompanionMemoryListV1> {
  const url = `/api/v1/companion/me/memories?page=${page}&pageSize=${pageSize}`;
  return CompanionMemoryListV1Schema.parse(await getData(url));
}

/** 「TA 主动跟我说的」：拉取主动消息（ADR-0054）。status 缺省取未读，'all' 取全部。 */
export async function fetchNudges(status: 'unread' | 'all' = 'unread'): Promise<CompanionNudgeListV1> {
  return CompanionNudgeListV1Schema.parse(await getData(`/api/v1/companion/me/nudges?status=${status}`));
}

/** 标记一条主动消息已读（幂等：已读再标记也返回成功）。 */
export async function markNudgeRead(id: string): Promise<void> {
  await postData(`/api/v1/companion/me/nudges/${encodeURIComponent(id)}/read`, {});
}

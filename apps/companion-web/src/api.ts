/**
 * Companion 后端读取客户端 —— 端到端类型来自 @chrono/contracts（与后端同源）。
 *
 * 鉴权采用既有 cookie/JWT 会话（与 chrono-synth-web 同后端）；这里只负责取数 + 用契约
 * schema 在运行时校验响应（后端若与契约漂移，前端立刻报错而非静默渲染错数据）。
 */

import {
  CompanionMeV1Schema,
  CompanionGrowthV1Schema,
  type CompanionMeV1,
  type CompanionGrowthV1,
} from '@chrono/contracts';

/** 后端统一响应信封：{ data: T }。 */
async function getData(url: string): Promise<unknown> {
  const res = await fetch(url, {
    method: 'GET',
    credentials: 'include',
    headers: { accept: 'application/json' },
  });
  if (res.status === 401 || res.status === 403) {
    throw new ApiAuthError(res.status);
  }
  if (!res.ok) {
    throw new Error(`请求失败 ${res.status}: ${url}`);
  }
  const body = (await res.json()) as { data?: unknown };
  return body.data;
}

/** 鉴权失败（未登录 / plan 不符）——UI 据此提示登录或切换账号。 */
export class ApiAuthError extends Error {
  constructor(public readonly status: number) {
    super(status === 403 ? '当前账号无权访问 companion' : '请先登录');
    this.name = 'ApiAuthError';
  }
}

export async function fetchMe(): Promise<CompanionMeV1> {
  return CompanionMeV1Schema.parse(await getData('/api/v1/companion/me'));
}

export async function fetchGrowth(): Promise<CompanionGrowthV1> {
  return CompanionGrowthV1Schema.parse(await getData('/api/v1/companion/me/growth'));
}

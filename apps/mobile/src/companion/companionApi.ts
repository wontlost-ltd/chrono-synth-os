/**
 * 移动端 ChronoCompanion API（ADR-0046 Phase 2.3）。
 *
 * 移动端在线优先（HTTP），直接调已上线的服务端 /api/v1/companion/*——服务端已把企业版 persona
 * 数据映射成 C 端 DTO（含 drift→「你最近探索的方向」的 growth 视图），移动端无需本地映射。
 * 用 @chrono/contracts 的 schema 校验响应，保证端到端类型同源（响应漂移即类型/校验失败）。
 */

import {
  CompanionMeV1Schema,
  CompanionGrowthV1Schema,
  CompanionMemoryListV1Schema,
  type CompanionMeV1,
  type CompanionGrowthV1,
  type CompanionMemoryListV1,
} from '@chrono/contracts';
import { apiFetch } from '../api/client';

/** GET /companion/me —「我的数字人」主页。 */
export async function fetchCompanionMe(): Promise<CompanionMeV1> {
  return CompanionMeV1Schema.parse(await apiFetch<unknown>('/api/v1/companion/me'));
}

/** GET /companion/me/growth —「你最近探索的方向」（服务端已做 drift→growth 映射）。 */
export async function fetchCompanionGrowth(): Promise<CompanionGrowthV1> {
  return CompanionGrowthV1Schema.parse(await apiFetch<unknown>('/api/v1/companion/me/growth'));
}

/** 收敛成 [1, max] 的正整数（防御非法/超大 page/pageSize 污染请求）。 */
function clampInt(n: number, fallback: number, max: number): number {
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), max);
}

/** 分页上限——避免导出 API 被复用时传超大 pageSize。 */
const MAX_PAGE = 100_000;
const MAX_PAGE_SIZE = 100;

/** GET /companion/me/memories —「我的记忆」分页。 */
export async function fetchCompanionMemories(
  page = 1,
  pageSize = 20,
): Promise<CompanionMemoryListV1> {
  const qs = new URLSearchParams({
    page: String(clampInt(page, 1, MAX_PAGE)),
    pageSize: String(clampInt(pageSize, 20, MAX_PAGE_SIZE)),
  });
  return CompanionMemoryListV1Schema.parse(
    await apiFetch<unknown>(`/api/v1/companion/me/memories?${qs.toString()}`),
  );
}

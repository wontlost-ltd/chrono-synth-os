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

/** GET /companion/me/memories —「我的记忆」分页。 */
export async function fetchCompanionMemories(
  page = 1,
  pageSize = 20,
): Promise<CompanionMemoryListV1> {
  const qs = `?page=${page}&pageSize=${pageSize}`;
  return CompanionMemoryListV1Schema.parse(
    await apiFetch<unknown>(`/api/v1/companion/me/memories${qs}`),
  );
}

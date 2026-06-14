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
  CompanionPerceiveResultV1Schema,
  CompanionChatResultV1Schema,
  type CompanionMeV1,
  type CompanionGrowthV1,
  type CompanionMemoryListV1,
  type CompanionPerceiveRequestV1,
  type CompanionPerceiveResultV1,
  type CompanionChatResultV1,
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

/**
 * POST /companion/me/perceive —「让 TA 听一段」。
 *
 * 用户把一段经历（已转写的文本表征）交给数字人，服务端确定性感知蒸馏器沉淀为 episodic 记忆 +
 * 经蒸馏门产成长候选，返回「人格记住了什么 + 是否有待审批的成长」。
 * 论点红线（ADR-0051）：服务端**只收文本表征**，不接收原始媒体——移动端当前是文本输入
 * （RN 无 Web Speech；语音输入是后续 expo-speech 增量）。
 */
export async function companionPerceive(
  input: CompanionPerceiveRequestV1,
): Promise<CompanionPerceiveResultV1> {
  return CompanionPerceiveResultV1Schema.parse(
    await apiFetch<unknown>('/api/v1/companion/me/perceive', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  );
}

/**
 * POST /companion/me/chat —「跟 TA 聊聊」（运行时零 LLM）。
 *
 * 回应由确定性离线回应器据人格叙事 + 自己沉淀的记忆生成（ADR-0047「跑为你拥有的人格」）。
 * 离线/无云仍能聊；无相关记忆时诚实告知，不瞎编。
 */
export async function companionChat(message: string): Promise<CompanionChatResultV1> {
  return CompanionChatResultV1Schema.parse(
    await apiFetch<unknown>('/api/v1/companion/me/chat', {
      method: 'POST',
      body: JSON.stringify({ message }),
    }),
  );
}

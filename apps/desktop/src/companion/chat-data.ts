/**
 * 桌面版「跟数字人聊天」数据层（ADR-0047 零-LLM 对话 C 端补全）。
 *
 * 调后端 `POST /api/v1/companion/me/chat`——**运行时零 LLM**：由确定性离线回应器据人格叙事 +
 * 数字人自己沉淀的记忆（关键词检索 grounding）生成第一人称回应。单机模式经内嵌 sidecar（apiFetch
 * sidecar-first + 握手头，红线 11）；无相关记忆时诚实告知，不瞎编。
 *
 * ⚠️ desktop apiFetch **不**解包 `{data}` 信封（与 mobile 不同，见 growth-data.ts 同款注释）——
 * 服务端返回 `{ data: <result> }`，须显式取 `.data`。
 */

import { apiFetch } from '@/bridge/http-client';

/** 与服务端 CompanionChatResultV1 对齐的回应形状（只取 UI 需要的字段）。 */
export interface CompanionChatResult {
  readonly reply: string;
  readonly kind: string;
  readonly confidence: number;
  readonly groundedMemoryCount: number;
}

/** 与服务端 COMPANION_CHAT_MESSAGE_MAX_LEN 对齐（防前端超长请求被 400）。 */
export const CHAT_MESSAGE_MAX_LEN = 2000;

/**
 * 发一句话给数字人，拿零-LLM 确定性回应。message 已由调用方 trim + 长度校验。
 * 失败（ApiNotConfiguredError / ApiHttpError / 网络错）向上抛，由页面转成用户可读提示。
 */
export async function chatWithCompanion(message: string): Promise<CompanionChatResult> {
  const env = await postChatOnce(message).catch(async (err) => {
    /* sidecar 崩溃重启后端口变（#268），前端缓存旧端口 → 首次 POST 网络错（TypeError「Load failed」）。
     * apiFetch 已在网络错时**失效端点缓存**，故重发会重取活端口。chat 消息重发安全（人格确定性 + 记忆
     * 去重，不会重复沉淀）——网络错自动重试一次，避免用户对着「Load failed」手动重发（真机遇到）。
     * 非网络错（如 4xx 业务错）不重试，原样抛。 */
    if (err instanceof TypeError) {
      return postChatOnce(message);
    }
    throw err;
  });
  const data = env?.data;
  if (!data || typeof data.reply !== 'string') {
    throw new Error('数字人回应格式异常');
  }
  return data;
}

async function postChatOnce(message: string): Promise<{ data?: CompanionChatResult }> {
  return apiFetch<{ data?: CompanionChatResult }>('/api/v1/companion/me/chat', {
    method: 'POST',
    body: { message },
  });
}

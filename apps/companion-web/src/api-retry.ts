/**
 * 401 重试决策（纯函数，零依赖，便于 Node 原生 strip-only 单测）。
 *
 * 抽出独立模块是为了让 api.ts 的 401 处理可被单测覆盖（api.ts 本身用 .js import 说明符 +
 * 依赖 @chrono/contracts，bare node --test 不便加载）。
 */

/**
 * 收到 401 时的动作：
 *   - sentToken：发出首请求时所用的 access token（null=当时未登录）。
 *   - currentToken：处理 401 时刻的当前 access token（可能因并发 login/logout 改变）。
 *
 * 规则：
 *   - 当前会话已不是发请求时那个（token 变了）→ 这是**陈旧 401**（与当前会话无关）：
 *     'retry-current'——用当前会话重试一次，**绝不** refresh/清会话（消除「陈旧 401 清新会话」）。
 *   - 否则仍是同一会话 → 'refresh'：尝试续期再重试。
 */
export type Action401 = 'refresh' | 'retry-current';

export function decide401Action(sentToken: string | null, currentToken: string | null): Action401 {
  return currentToken !== sentToken ? 'retry-current' : 'refresh';
}

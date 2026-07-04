/**
 * 桌面 sidecar 本地握手 guard（ADR-0061 红线 11）。
 *
 * loopback（127.0.0.1）**不是**鉴权边界——同机任意进程都能打本地 sidecar 的端口，CORS/CSRF 只约束浏览器
 * 不约束本地进程。故 desktop 模式下，除 JWT/API-Key 外，非 public 端点**额外**要求 per-launch 握手 token：
 *   - Tauri Rust 父进程每次启动生成随机 token，经 env `CHRONO_DESKTOP_SESSION` 传给 sidecar（本插件读），
 *     经 Tauri invoke 传给前端（前端每请求带 `X-Chrono-Desktop-Session` 头）；
 *   - 本插件仅在 env 存在时**激活**（=desktop sidecar 模式）；服务器/容器部署无此 env → 插件 no-op，行为不变。
 *   - token 常量时间比较（防时序）；缺失/不符 → 403 fail-closed。
 *   - public 运维端点（healthz/readyz）豁免（父进程健康探测在拿到 token 前也要能探；且不含业务数据）。
 *
 * 威胁模型（ADR-0061 红线 11 诚实边界）：本 guard 防「同机其他 app / 浏览器页面误打或恶意打 sidecar」、
 * 「端口被后来进程劫持后前端误连」。**不防**能读本进程 env/内存的**同 OS 用户级恶意软件**（那已越过本地 app
 * 防护范围）——只做最小暴露 + fail-closed。
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { timingSafeEqual, createHash } from 'node:crypto';

const HEADER = 'x-chrono-desktop-session';

/** 运维端点豁免（与 auth.ts PUBLIC_PATHS 同纪律：父进程健康探测 + 无业务数据）。 */
const PUBLIC_PATHS = new Set(['/healthz', '/readyz']);

function isPublicPath(url: string): boolean {
  const path = url.split('?')[0];
  for (const p of PUBLIC_PATHS) {
    if (path === p || path.startsWith(p + '/')) return true;
  }
  return false;
}

/** 常量时间比较（先 sha256 等长，避免长度泄露）。 */
function safeCompare(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * 注册桌面握手 guard。仅当 CHRONO_DESKTOP_SESSION 环境变量存在时激活（desktop sidecar 模式）；
 * 否则 no-op（普通服务器/容器部署不受影响，向后兼容）。
 */
export function registerDesktopSession(app: FastifyInstance): void {
  const expected = process.env.CHRONO_DESKTOP_SESSION;
  if (typeof expected !== 'string' || expected.length === 0) return; /* 非 desktop 模式：no-op */

  app.addHook('onRequest', (request: FastifyRequest, reply: FastifyReply, done) => {
    if (isPublicPath(request.url) || request.method === 'OPTIONS') return done();
    const presented = request.headers[HEADER];
    const token = typeof presented === 'string' ? presented : undefined;
    if (!token || !safeCompare(token, expected)) {
      return reply.status(403).send({
        error: 'AuthorizationError',
        code: 'AUTH_MISSING_DESKTOP_SESSION',
        message: '缺少或无效的本地会话握手（X-Chrono-Desktop-Session）——本地 sidecar 只接受本安装实例的前端',
      });
    }
    done();
  });
}

/**
 * 本地 sidecar 端点桥（ADR-0061 S2）。
 *
 * 从 Tauri Rust 侧（get_sidecar_endpoint 命令）取本地内嵌 Node OS 的 base URL + per-launch 握手 token
 * （红线 11）。缓存本次会话结果——端口/token 每次 app 启动变，但一次运行内稳定。
 *
 * apiFetch 优先用本地 sidecar（base + X-Chrono-Desktop-Session 头）；取不到（dev 未打包 / 启动失败）
 * 则回退到手工配置的远端 server（localStorage，自托管模式）——两种模式共存，向后兼容。
 */

export interface SidecarEndpoint {
  readonly baseUrl: string;
  readonly handshakeToken: string;
  readonly instanceNonce: string;
}

let cached: SidecarEndpoint | null = null;
/* resolved 只在**永久性**结论时置 true：拿到端点，或确认「不在 Tauri 环境」（invoke 不可用=远端/浏览器模式）。
 * 「sidecar 尚未就绪」（命令返错但 invoke 可用）是**瞬态**——不缓存 null，下次 apiFetch 重新 invoke
 * （防「启动期首次 invoke 失败永久缓存 null」，Codex S2 复审补）。 */
let resolved = false;

/**
 * 取本地 sidecar 端点（缓存永久性结论）。返回 null=无本地 sidecar（远端/浏览器模式，走 localStorage 回退）
 * 或 sidecar 尚未就绪（瞬态，不缓存，下次重试）。
 */
/** 是否运行在 Tauri 环境。用 __TAURI_INTERNALS__ 存在性判定——@tauri-apps/api 的 import 在普通浏览器**也能成功**
 * （invoke 调用时才抛），故不能靠 import 抛错区分（Codex S2 复审补）。 */
function isTauri(): boolean {
  return typeof globalThis !== 'undefined'
    && (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== undefined;
}

export async function getSidecarEndpoint(): Promise<SidecarEndpoint | null> {
  if (resolved) return cached;
  /* 非 Tauri（远端 web / vitest / 浏览器）→ **永久**无本地 sidecar，缓存 null（不每次重试烧 import/invoke）。 */
  if (!isTauri()) {
    cached = null; resolved = true;
    return cached;
  }
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    cached = await invoke<SidecarEndpoint>('get_sidecar_endpoint');
    resolved = true; /* 拿到端点=永久结论。 */
  } catch {
    /* 在 Tauri 内但命令返错（sidecar 尚未就绪/启动中）=**瞬态**：不置 resolved，下次重试拿到就绪端点。 */
    cached = null; /* resolved 保持 false */
  }
  return cached;
}

/**
 * 使缓存失效 → 下次 getSidecarEndpoint 重新 invoke（拿新 token/端口）。
 * 用于：apiFetch 遇 403(握手失效)/网络错（sidecar 崩溃重启后端口+token 变），或首次 invoke 失败后重试
 * （防「首次失败永久缓存 null」）。Codex S2 复审补。
 */
export function invalidateSidecarEndpoint(): void {
  cached = null;
  resolved = false;
}

/** 测试用：重置缓存（生产不调用）。 */
export function __resetSidecarEndpointCache(): void {
  invalidateSidecarEndpoint();
}

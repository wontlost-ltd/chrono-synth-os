/**
 * 单机模式本地会话引导（ADR-0061 S5）。
 *
 * 当有本地内嵌 sidecar（getSidecarEndpoint 非空）且尚无 API token 时：**自动 provision 本地 admin**——
 * 首启注册一个固定本地账号、拿 JWT token 存起来，让用户**无需手工填 server URL / 注册**（红线：单机双击即用）。
 *
 * 凭据存储：本地 admin 密码存**加密本地设置**（app_settings，落 SQLCipher，key 在 keyring）——非明文、非源码。
 * token 存 localStorage（apiFetch 读；desktop 单机本地 WebView 信任边界内）。JWT 签名 secret 由 Rust keyring
 * 持久（S3），故 token 跨重启有效；token 过期时用持久密码重新 login。
 *
 * 非单机（远端自托管模式，无 sidecar）→ 不动，走既有手工 onboarding（server URL + token）。
 *
 * 威胁模型（对齐红线 11）：本地凭据在同 OS 用户信任边界内；不防同用户 malware（能读加密 DB key/内存的进程超出
 * 本地 app 防护范围）——只做最小暴露（加密 at-rest + 不硬编码）。
 */

import { getSidecarEndpoint, type SidecarEndpoint } from './sidecar-endpoint';
import { getApiToken, setApiToken } from './http-client';
import { getAppSetting, setAppSetting } from './tauri-commands';

const LOCAL_ADMIN_EMAIL = 'local@chrono.app';
const APP_SETTING_LOCAL_ADMIN_PW = 'chrono.local.adminPassword';

interface AuthResult { data?: { accessToken?: string } }

/** 生成一个满足密码强度（含大小写+数字+符号）的随机本地密码。 */
function generateLocalPassword(): string {
  const rand = crypto.getRandomValues(new Uint8Array(24));
  const b64 = btoa(String.fromCharCode(...rand)).replace(/[+/=]/g, '');
  /* 保证含各类字符满足服务器密码策略。 */
  return `Lz9!${b64}`;
}

/**
 * 引导单机本地会话。返回 true=本地模式已就绪（token 已配，跳过手工 onboarding）；false=非单机（走远端手工流程）。
 * 幂等：已有 token 直接返回 true（不重复 provision）。
 */
export async function bootstrapLocalSession(): Promise<boolean> {
  const sidecar = await getSidecarEndpoint();
  if (!sidecar) return false; /* 无本地 sidecar = 远端自托管模式，不接管 */

  /* 取/建本地 admin 密码（加密本地设置持久，供 token 过期后重新 login）。 */
  let password = await getAppSetting(APP_SETTING_LOCAL_ADMIN_PW);
  const firstProvision = !password;
  if (!password) {
    password = generateLocalPassword();
    await setAppSetting(APP_SETTING_LOCAL_ADMIN_PW, password);
  }

  /* 已有 token：验其仍有效（红线——JWT access TTL 15min，重启后旧 token 可能过期）。有效→幂等 true；
   * 过期(401)→清 token 走下面重新 login（用持久密码），不卡在死 token（Codex S5 复审 Major）。 */
  const existing = getApiToken();
  if (existing && await tokenStillValid(sidecar, existing)) { await settleLocalSync(); return true; }
  if (existing) setApiToken(null);

  /* login-or-register：**直接 fetch**（不用 apiFetch——它前置要求 token；auth 端点本就免 token）。带 sidecar
   * base + 握手头（红线 11）。首启优先 register，老用户（已有密码）优先 login。 */
  const token = await loginOrRegister(sidecar, LOCAL_ADMIN_EMAIL, password, firstProvision);
  if (!token) return false; /* provision 失败 → 回退（前端展示「本地引擎初始化失败」，不静默假成功） */
  setApiToken(token);
  await settleLocalSync();
  return true;
}

/**
 * 单机模式落 `local` 同步态：修「本地无远端却永久卡 initial_sync/Syncing…」。**每次启动都应调用**
 * （不仅首启）——onboarding 完成后 App boot 会跳过 bootstrapLocalSession，若只在那里标 local，则老用户
 * 每次启动都卡 Syncing（真机实测：首启崩溃循环期间 markSyncLocal 失败被吞，之后 onboarded=true 永不再标）。
 *
 * markSyncLocal 只更新桌面本地 rusqlite 的 sync_state（不依赖 sidecar 就绪），幂等（只从 initial_sync→local，
 * 不覆盖远端模式 online_synced/degraded）。仅在**检测到本地 sidecar**（单机模式）时标——远端自托管模式
 * 无 sidecar，settle 应 no-op（不把远端态误标 local）。失败不致命（下次启动再标）。
 */
export async function settleLocalSync(): Promise<void> {
  try {
    /* 仅单机（有本地 sidecar）才标 local；远端自托管无 sidecar → 跳过（不误标远端态）。
     * sidecar 在 Rust setup 里异步拉起，boot 时可能尚未就绪 → getSidecarEndpoint() 暂时返 null（瞬态，
     * 不缓存）。故短暂轮询等它就绪（最多 ~10s）再判定；真远端模式（非 Tauri / 无内嵌 sidecar）会一直
     * 返 null，轮询到超时后跳过——代价仅几秒等待，不阻塞（本函数在 boot 里 await，但只在启动早期一次）。 */
    let sidecar = await getSidecarEndpoint();
    for (let i = 0; !sidecar && i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      sidecar = await getSidecarEndpoint();
    }
    if (!sidecar) return; /* 超时仍无 → 远端模式或 sidecar 启动失败，不标 local。 */
    const { markSyncLocal } = await import('./tauri-commands');
    await markSyncLocal();
  } catch {
    /* 非 Tauri / 命令不可用 → 忽略（下次启动再标）。 */
  }
}

/** 带握手头 fetch 一个 sidecar 端点（红线 11）。auth 端点免 token，故不带 authorization。 */
async function sidecarFetch(sidecar: SidecarEndpoint, path: string, init: RequestInit): Promise<Response> {
  return fetch(`${sidecar.baseUrl}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      'x-chrono-desktop-session': sidecar.handshakeToken,
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

/** 校验 token 仍有效：带 token + 握手头打 /companion/me，200/2xx=有效，401=过期。 */
async function tokenStillValid(sidecar: SidecarEndpoint, token: string): Promise<boolean> {
  try {
    const res = await sidecarFetch(sidecar, '/api/v1/companion/me', {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
    });
    return res.ok; /* 401/403 → 过期/无效，重新 login */
  } catch {
    return false;
  }
}

/** 先 login，401/账号不存在则 register（或反序）；返回 accessToken 或 null。直接 fetch，免 token。 */
async function loginOrRegister(sidecar: SidecarEndpoint, email: string, password: string, preferRegister: boolean): Promise<string | null> {
  const attempts = preferRegister ? ['register', 'login'] : ['login', 'register'];
  for (const kind of attempts) {
    try {
      const res = await sidecarFetch(sidecar, `/api/v1/auth/${kind}`, {
        method: 'POST',
        body: JSON.stringify({ email, password, ...(kind === 'register' ? { displayName: 'Local' } : {}) }),
      });
      if (!res.ok) continue; /* 试下一种（register 撞已存在 4xx → login；login 无账号 → register） */
      const r = (await res.json()) as AuthResult;
      const tok = r.data?.accessToken;
      if (tok) return tok;
    } catch {
      /* 网络/解析异常 → 试下一种 */
    }
  }
  return null;
}

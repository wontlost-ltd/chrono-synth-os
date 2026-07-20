/**
 * GitHub App 三级 token 认证链的核心（App 私钥 → App JWT → installation token）。
 *
 * GitHub App 的出站 API 调用不能直接用 App 私钥，须两跳换取一枚短期
 * installation token：
 *   1. 用 App 私钥签一枚 **App JWT**（RS256，GitHub 硬性要求有效期 ≤10min，
 *      iss=appId）；
 *   2. 拿该 App JWT 作 Bearer 头，POST installation 的 access_tokens 端点，
 *      换回一枚有效期约 1h 的 **installation token**（真正用于发 API 请求）。
 *
 * 本类负责第 1、2 步并**内存缓存**换回的 installation token，在到期前
 * （now + skew ≥ expiresAt）静默重签，避免每次请求都换 token。Task 6 的
 * ReadPort 只调 getInstallationToken() 拿有效 token 发请求。
 *
 * 铁律（照 memory adr-0060 T6 flaky 教训）：**时钟必须注入**（deps.now）。
 *   installation token 的有效期判定、以及 App JWT 的 iat/exp，全部用注入
 *   时钟计算，绝不用真 Date.now——否则 token 有效期 / 刷新用例会 flaky。
 *
 * 安全边界：换 token 的出站请求**经 Task 4 的 githubFetch**（SSRF 网关），
 *   不用裸 fetch——所有 GitHub 出站都过 host/scheme allowlist。GHE 自托管
 *   场景下（gheBaseUrl 非空）自动把企业 host 加入 allowlist。
 */

import crypto from 'node:crypto';
import { githubFetch, type GithubFetchOptions } from './github-http.js';

/** App JWT 签发所需的最小凭据（取自 Task 3 getApp() 的子集）。 */
export interface AppCreds {
  /** GitHub App 的数字 App ID（用作 JWT 的 iss）。 */
  appId: string;
  /** App 私钥 PEM（PKCS#8 / PKCS#1 均可，供 RS256 签名）。 */
  privateKeyPem: string;
  /**
   * GitHub Enterprise Server 的 API base（如 `https://ghe.example.com/api/v3`）。
   * 为空则走公有云 `https://api.github.com`。
   */
  gheBaseUrl?: string | null;
}

/** 内存缓存的 installation token 及其到期时间（epoch ms）。 */
interface CachedToken {
  token: string;
  expiresAt: number;
}

/** installation access_tokens 端点的响应形状（仅取用到的字段）。 */
interface AccessTokenResponse {
  token: string;
  expires_at: string;
}

/** 公有云 API base。 */
const PUBLIC_API_BASE = 'https://api.github.com';

/** App JWT 有效期（秒）：540s = 9min，留 1min 余量避开 GitHub 的 10min 硬上限。 */
const APP_JWT_TTL_SECONDS = 540;

/** App JWT iat 回退（秒）：容忍本机与 GitHub 之间的时钟漂移。 */
const APP_JWT_IAT_BACKDATE_SECONDS = 60;

/** installation token 提前重签窗口（ms）：到期前 60s 即视为需重签。 */
const REFRESH_SKEW_MS = 60_000;

export class GitHubAuthManager {
  private readonly getApp: () => AppCreds | undefined;
  private readonly installationId: string;
  private readonly now: () => number;
  private readonly fetchImpl: typeof githubFetch;

  /** 内存缓存的 installation token；null 表示尚未换取或已失效。 */
  private cached: CachedToken | null = null;

  constructor(deps: {
    /** 通常包 Task 3 的 store.getApp()——返回本租户 App 凭据或 undefined。 */
    getApp: () => AppCreds | undefined;
    /** 目标 installation 的数字 ID。 */
    installationId: string;
    /** 注入时钟（epoch ms）。禁真 Date.now——见文件头铁律。 */
    now: () => number;
    /** 可注入的出站实现，默认 Task 4 的 githubFetch（SSRF 网关）。 */
    fetchImpl?: typeof githubFetch;
  }) {
    this.getApp = deps.getApp;
    this.installationId = deps.installationId;
    this.now = deps.now;
    this.fetchImpl = deps.fetchImpl ?? githubFetch;
  }

  /**
   * 返回一枚有效的 installation token。
   *
   * 缓存命中（now + skew < expiresAt）直接复用；否则签一枚新 App JWT、换取
   * 新 installation token 并刷新缓存。到期前 skew 窗口内即触发重签，避免用
   * 一枚马上失效的 token 发请求。
   */
  async getInstallationToken(): Promise<string> {
    if (this.cached && this.now() + REFRESH_SKEW_MS < this.cached.expiresAt) {
      return this.cached.token;
    }
    const fresh = await this.exchangeInstallationToken();
    this.cached = fresh;
    return fresh.token;
  }

  /** 签 App JWT → POST access_tokens 端点换取 installation token。 */
  private async exchangeInstallationToken(): Promise<CachedToken> {
    const app = this.getApp();
    if (!app) {
      throw new Error('GitHubAuthManager：本租户未配置 GitHub App 凭据（getApp 返回 undefined），无法换取 installation token');
    }

    const appJwt = this.signAppJwt(app);
    const { url, opts } = this.resolveTokenEndpoint(app);

    const res = await this.fetchImpl(
      url,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${appJwt}`,
          Accept: 'application/vnd.github+json',
        },
      },
      opts,
    );

    if (!res.ok) {
      throw new Error(`GitHubAuthManager：换取 installation token 失败（HTTP ${res.status}）`);
    }

    const body = (await res.json()) as AccessTokenResponse;
    const expiresAt = Date.parse(body.expires_at);
    if (!body.token || Number.isNaN(expiresAt)) {
      throw new Error('GitHubAuthManager：installation token 响应缺 token 或 expires_at 无法解析');
    }
    return { token: body.token, expiresAt };
  }

  /**
   * 签发 App JWT（RS256）。payload = { iat: now-60, exp: iat+540, iss: appId }：
   * iat 回退 60s 容时钟漂移，exp 距 iat 540s（≤10min）。header/payload/signature
   * 三段各 base64url 后以 '.' 拼接。iat/exp 全部用注入时钟。
   */
  private signAppJwt(app: AppCreds): string {
    const nowSeconds = Math.floor(this.now() / 1000);
    const iat = nowSeconds - APP_JWT_IAT_BACKDATE_SECONDS;
    const exp = iat + APP_JWT_TTL_SECONDS;

    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const payload = base64url(JSON.stringify({ iat, exp, iss: app.appId }));
    const signingInput = `${header}.${payload}`;

    const signer = crypto.createSign('RSA-SHA256');
    signer.update(signingInput);
    signer.end();
    const signature = signer.sign(app.privateKeyPem).toString('base64url');

    return `${signingInput}.${signature}`;
  }

  /**
   * 解析 access_tokens 端点 URL 与 githubFetch 选项。
   *
   * 公有云 → `https://api.github.com/...`，用 githubFetch 默认 allowlist。
   * GHE（gheBaseUrl 非空）→ base 拼路径，并把企业 host 加入 hostAllowlist，
   * 否则会被 SSRF 网关（默认只放 api.github.com）拒绝。
   */
  private resolveTokenEndpoint(app: AppCreds): { url: string; opts: GithubFetchOptions | undefined } {
    const path = `/app/installations/${this.installationId}/access_tokens`;
    const base = app.gheBaseUrl ? app.gheBaseUrl.replace(/\/+$/, '') : PUBLIC_API_BASE;
    const url = `${base}${path}`;

    if (!app.gheBaseUrl) {
      return { url, opts: undefined };
    }

    /* GHE：把企业 host 放进 allowlist，使 SSRF 网关放行该自托管地址。
     * 用 .hostname（不含端口）——SSRF 网关按 URL.hostname 比对 allowlist，
     * 传含端口的 .host 会导致带自定义端口的合法 GHE 地址被误拒。 */
    const host = new URL(base).hostname;
    return { url, opts: { hostAllowlist: [host] } };
  }
}

/** UTF-8 字符串 → base64url（无填充），供 JWT 段编码。 */
function base64url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

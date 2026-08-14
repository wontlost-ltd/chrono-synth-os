/**
 * 安全 URL 内容抓取器（P1-B 知识批量导入支持）
 *
 * 防护：
 *   - 仅允许 http/https 协议
 *   - 拒绝 localhost / 回环地址 / RFC1918 私有网段 / 169.254.x.x（云元数据，含 AWS / Azure / GCP）
 *   - 解析出的**全部**地址都必须通过私有段检查，且连接固定到已验证的 IP
 *     （防 DNS rebinding：校验与连接分离时，攻击者可在两者之间改写 DNS 应答）
 *   - 内容长度上限 5 MB（基于响应头与实际正文双重检查）
 *   - 请求超时 10 秒
 *
 * 注意：不重试，让调用方决定是否进入 failures。
 */

import { lookup } from 'node:dns/promises';
import { Agent, fetch as undiciFetch } from 'undici';

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

export interface FetchResult {
  readonly content: string;
  readonly contentType: string;
}

export interface UrlContentFetcherOptions {
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
  /** 测试钩子：跳过 DNS 解析，直接信任 hostname 文本判定 */
  readonly skipDnsResolve?: boolean;
  /** 测试钩子：允许 loopback（127.0.0.1 / ::1 / localhost）通过 SSRF 检查
   *  生产环境绝对不允许设置为 true */
  readonly allowLoopback?: boolean;
  /** 测试钩子：替换 DNS 解析（返回该主机的全部地址）。
   *  用于验证多 A 记录场景——真实 DNS 无法在单测里稳定构造。 */
  readonly resolveAll?: (hostname: string) => Promise<string[]>;
}

export class UrlContentFetcher {
  private readonly maxBytes: number;
  private readonly timeoutMs: number;
  private readonly skipDnsResolve: boolean;
  private readonly allowLoopback: boolean;
  private readonly resolveAllHook?: (hostname: string) => Promise<string[]>;

  constructor(options: UrlContentFetcherOptions = {}) {
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.skipDnsResolve = options.skipDnsResolve ?? false;
    this.allowLoopback = options.allowLoopback ?? false;
    this.resolveAllHook = options.resolveAll;
  }

  async fetch(url: string): Promise<FetchResult> {
    const parsed = this.parseUrl(url);
    if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
      throw new Error(`URL fetch rejected: protocol ${parsed.protocol} not allowed`);
    }

    const hostname = parsed.hostname.toLowerCase();
    if (this.isRestricted(hostname)) {
      throw new Error(`URL fetch rejected: ${hostname} is in restricted range (SSRF)`);
    }
    /* 已验证并选定的连接目标 IP。非空时用固定 IP 的 dispatcher 发请求，
     * 使「校验的地址」与「实际连接的地址」是同一个。 */
    let pinnedAddress: string | undefined;
    if (!this.skipDnsResolve && !isLiteralIp(hostname)) {
      /* 取**全部**地址而非首个：多 A 记录主机可以把私有 IP 藏在第二条之后，
       * 只查一条等于给攻击者留了一半的通过率。任一条命中私有段即整体拒绝。 */
      const resolved = await this.resolveAllAddresses(hostname);
      for (const addr of resolved) {
        if (this.isRestricted(addr)) {
          throw new Error(`URL fetch rejected: ${hostname} resolved to ${addr} (SSRF)`);
        }
      }
      pinnedAddress = resolved[0];
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    /* 固定到已验证 IP：默认 fetch 会**再解析一次** DNS，与上面的校验是两次独立查询，
     * 攻击者只需在这个窗口内让权威 DNS 改答（TTL=0 即可）就能绕过全部检查。
     * undici 的 connect.lookup 让我们直接把连接钉在已验证的地址上；
     * Host 头仍由 URL 决定，故 TLS 证书校验与虚拟主机路由都不受影响。 */
    const dispatcher = pinnedAddress === undefined ? undefined : new Agent({
      connect: {
        lookup: (_hostname, _opts, cb): void => {
          cb(null, [{ address: pinnedAddress!, family: pinnedAddress!.includes(':') ? 6 : 4 }]);
        },
      },
    });
    try {
      const response = await undiciFetch(url, {
        signal: controller.signal,
        redirect: 'manual',
        ...(dispatcher ? { dispatcher } : {}),
      });
      if (response.status >= 300 && response.status < 400) {
        throw new Error(`URL fetch rejected: redirects disabled (status ${response.status})`);
      }
      if (!response.ok) {
        throw new Error(`URL fetch failed with status ${response.status}`);
      }

      const contentLengthHeader = response.headers.get('content-length');
      if (contentLengthHeader) {
        const len = Number.parseInt(contentLengthHeader, 10);
        if (Number.isFinite(len) && len > this.maxBytes) {
          throw new Error(`URL fetch rejected: Content-Length ${len} exceeds ${this.maxBytes}`);
        }
      }

      const text = await response.text();
      if (text.length > this.maxBytes) {
        throw new Error(`URL fetch rejected: body length ${text.length} exceeds ${this.maxBytes}`);
      }

      return {
        content: text,
        contentType: response.headers.get('content-type') ?? 'text/plain',
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private parseUrl(url: string): URL {
    try {
      return new URL(url);
    } catch {
      throw new Error(`URL fetch rejected: invalid URL ${url}`);
    }
  }

  /** 解析主机名的**全部**地址（v4+v6）。任一条落在私有段即视为不可信。 */
  private async resolveAllAddresses(hostname: string): Promise<string[]> {
    try {
      const addresses = this.resolveAllHook
        ? await this.resolveAllHook(hostname)
        : (await lookup(hostname, { all: true })).map((r) => r.address);
      /* 空结果不能当"没有可疑地址"放行——那样会跳过 pin，落回默认 fetch 的独立解析。 */
      if (addresses.length === 0) {
        throw new Error('empty DNS result');
      }
      return addresses;
    } catch (err) {
      throw new Error(`URL fetch rejected: DNS lookup failed for ${hostname}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private isRestricted(host: string): boolean {
    const h = host.toLowerCase();
    if (this.allowLoopback && (h === 'localhost' || h.endsWith('.localhost') || h === '127.0.0.1' || h.startsWith('127.') || h === '::1' || h === '0:0:0:0:0:0:0:1')) {
      return false;
    }
    return isPrivateHostname(h);
  }
}

function isLiteralIp(hostname: string): boolean {
  return /^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.includes(':');
}

/** 命中以下任一即视为受限地址：localhost、回环、RFC1918、169.254（含云元数据）、IPv6 回环/链路本地/ULA */
export function isPrivateHostname(host: string): boolean {
  const h = host.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '127.0.0.1' || h.startsWith('127.')) return true;
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true;
  if (/^0\./.test(h)) return true;
  if (h.startsWith('fc') || h.startsWith('fd')) return true;  /* IPv6 ULA */
  if (h.startsWith('fe80:')) return true;                      /* IPv6 link-local */
  return false;
}

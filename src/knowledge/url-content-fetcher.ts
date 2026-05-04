/**
 * 安全 URL 内容抓取器（P1-B 知识批量导入支持）
 *
 * 防护：
 *   - 仅允许 http/https 协议
 *   - 拒绝 localhost / 回环地址 / RFC1918 私有网段 / 169.254.x.x（云元数据，含 AWS / Azure / GCP）
 *   - 解析后的 IP 命中私有段也拒绝（防 DNS rebinding）
 *   - 内容长度上限 5 MB（基于响应头与实际正文双重检查）
 *   - 请求超时 10 秒
 *
 * 注意：不重试，让调用方决定是否进入 failures。
 */

import { lookup } from 'node:dns/promises';

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
  /** 注入用：测试时跳过 DNS 解析，直接信任 hostname 文本判定 */
  readonly skipDnsResolve?: boolean;
}

export class UrlContentFetcher {
  private readonly maxBytes: number;
  private readonly timeoutMs: number;
  private readonly skipDnsResolve: boolean;

  constructor(options: UrlContentFetcherOptions = {}) {
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.skipDnsResolve = options.skipDnsResolve ?? false;
  }

  async fetch(url: string): Promise<FetchResult> {
    const parsed = this.parseUrl(url);
    if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
      throw new Error(`URL fetch rejected: protocol ${parsed.protocol} not allowed`);
    }

    const hostname = parsed.hostname.toLowerCase();
    if (isPrivateHostname(hostname)) {
      throw new Error(`URL fetch rejected: ${hostname} is in restricted range (SSRF)`);
    }
    if (!this.skipDnsResolve && !isLiteralIp(hostname)) {
      const resolved = await this.resolveAddress(hostname);
      if (isPrivateHostname(resolved)) {
        throw new Error(`URL fetch rejected: ${hostname} resolved to ${resolved} (SSRF)`);
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal, redirect: 'manual' });
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

  private async resolveAddress(hostname: string): Promise<string> {
    try {
      const result = await lookup(hostname);
      return result.address;
    } catch (err) {
      throw new Error(`URL fetch rejected: DNS lookup failed for ${hostname}: ${err instanceof Error ? err.message : String(err)}`);
    }
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

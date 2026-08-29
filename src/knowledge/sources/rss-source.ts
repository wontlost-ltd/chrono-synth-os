/**
 * RSS/Atom 知识源
 * 解析 XML feed，增量抓取（基于 lastBuildDate 游标）
 */

import { createHash } from 'node:crypto';
import type { KnowledgeItem } from '../../types/avatar-autorun.js';
import type { KnowledgeSource, KnowledgeSourceFetchResult } from '../knowledge-source.js';
import { UrlContentFetcher } from '../url-content-fetcher.js';

/** 简易 XML 文本提取（不引入外部依赖） */
function extractTag(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
  const m = xml.match(re);
  return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : '';
}

function extractItems(xml: string): Array<{ title: string; description: string; link: string; pubDate: string }> {
  const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  const entryRegex = /<entry[^>]*>([\s\S]*?)<\/entry>/gi;
  const items: Array<{ title: string; description: string; link: string; pubDate: string }> = [];

  const regex = xml.includes('<entry') ? entryRegex : itemRegex;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(xml)) !== null) {
    const block = m[1];
    const title = extractTag(block, 'title');
    const description = extractTag(block, 'description') || extractTag(block, 'summary') || extractTag(block, 'content');
    const link = extractTag(block, 'link');
    const pubDate = extractTag(block, 'pubDate') || extractTag(block, 'published') || extractTag(block, 'updated');
    items.push({ title, description, link, pubDate });
  }
  return items;
}

/** 解析日期字符串为毫秒时间戳，失败返回 null */
function parseDate(raw: string): number | null {
  const ts = Date.parse(raw);
  return Number.isFinite(ts) ? ts : null;
}

export class RssKnowledgeSource implements KnowledgeSource {
  readonly type = 'rss' as const;

  /** SSRF 安全的出站抓取器（审计 #403）。见下方 fetch 中的说明。 */
  private readonly fetcher = new UrlContentFetcher();

  async fetch(
    config: Record<string, unknown>,
    state: Record<string, unknown> | null,
    _signal: AbortSignal,
  ): Promise<KnowledgeSourceFetchResult> {
    const url = config.url as string | undefined;
    if (!url) return { items: [] };

    /* 向后兼容：优先读 lastBuildTs（时间戳），回退解析旧 lastBuildDate（字符串） */
    const lastBuildTs = typeof state?.lastBuildTs === 'number'
      ? state.lastBuildTs as number
      : typeof state?.lastBuildDate === 'string'
        ? parseDate(state.lastBuildDate as string) ?? 0
        : 0;

    /* ⚠️ 审计 #403（SSRF）：`config.url` 由租户用户提交，此前直接进裸 `fetch()`。
     * 与 api-source 同型，改走 `UrlContentFetcher`（协议白名单 + 私有段拒绝 +
     * 全部 A 记录校验 + 连接 pin 到已验证 IP 防 DNS rebinding）。 */
    const { content: xml } = await this.fetcher.fetch(url);
    const rawItems = extractItems(xml);

    const items: KnowledgeItem[] = [];
    let newestTs = lastBuildTs;

    for (const raw of rawItems) {
      /* 增量过滤：基于时间戳比较，避免 RFC822 字符串排序错误 */
      const publishedTs = raw.pubDate ? parseDate(raw.pubDate) : null;
      if (lastBuildTs && publishedTs !== null && publishedTs <= lastBuildTs) continue;

      const content = raw.description || raw.title;
      if (!content) continue;

      items.push({
        sourceId: '',
        title: raw.title,
        content,
        url: raw.link,
        publishedAt: publishedTs ?? undefined,
        kind: 'episodic',
        salience: 0.4,
        valence: 0,
        fingerprint: createHash('sha256').update(raw.link || content).digest('hex').slice(0, 32),
      });

      if (publishedTs !== null && publishedTs > newestTs) newestTs = publishedTs;
    }

    return {
      items,
      nextState: { lastBuildTs: newestTs },
    };
  }
}

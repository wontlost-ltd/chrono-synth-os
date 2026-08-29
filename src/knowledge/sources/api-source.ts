/**
 * REST API 知识源
 * 通过 HTTP GET 获取 JSON 数据并解析为知识条目
 */

import { createHash } from 'node:crypto';
import type { KnowledgeItem } from '../../types/avatar-autorun.js';
import type { KnowledgeSource, KnowledgeSourceFetchResult } from '../knowledge-source.js';
import { UrlContentFetcher } from '../url-content-fetcher.js';

export class ApiKnowledgeSource implements KnowledgeSource {
  readonly type = 'api' as const;

  /* ⚠️ 审计 #403（SSRF）：`config.url` 由**租户用户**经 `POST /api/v1/knowledge-sources`
   * 提交，此前直接进裸 `fetch()`，无任何校验（Zod 只有 `z.string().url()`，
   * 接受任意 host/scheme）。攻击者指向 `http://169.254.169.254/...` 或内网
   * admin API，再经自己拥有的 autorun 触发摄入，**响应体会被导入记忆**并可经
   * `GET /api/v1/memories` 读回 —— 完整的 SSRF 读原语，不是盲打。
   *
   * 修法：复用同目录已有的 `UrlContentFetcher` —— 它做了协议白名单、私有段
   * 拒绝、解析**全部** A 记录、并把连接 pin 到已验证 IP（防 DNS rebinding）。
   * 不自研第二套（本仓 `ssrf-guard.ts` 已存在但生产几乎没人调用，正是这类
   * 「有防护却没接上」的根源）。 */
  private readonly fetcher = new UrlContentFetcher();

  async fetch(
    config: Record<string, unknown>,
    _state: Record<string, unknown> | null,
    _signal: AbortSignal,
  ): Promise<KnowledgeSourceFetchResult> {
    const url = config.url as string | undefined;
    if (!url) return { items: [] };

    /* ⚠️ 不再透传 `config.headers`：它同样是攻击者可控的，此前会被原样送进
     * 出站请求（实测可注入 `Authorization: Bearer …` 打内网服务）。
     * 知识摄入不需要调用方自定义鉴权头；确有需求应改为服务端白名单配置。 */
    const { content } = await this.fetcher.fetch(url);

    let body: unknown;
    try {
      body = JSON.parse(content) as unknown;
    } catch {
      throw new Error('API 抓取失败: 响应不是合法 JSON');
    }

    /* 支持数组或 { data: [...] } 两种格式 */
    const entries = Array.isArray(body)
      ? body as Record<string, unknown>[]
      : Array.isArray((body as Record<string, unknown>)?.data)
        ? (body as Record<string, unknown>).data as Record<string, unknown>[]
        : [body as Record<string, unknown>];

    const items: KnowledgeItem[] = [];
    for (const entry of entries) {
      const content = (entry.content ?? entry.text ?? entry.body ?? entry.description ?? JSON.stringify(entry)) as string;
      if (!content || typeof content !== 'string') continue;

      items.push({
        sourceId: '',
        title: (entry.title as string) ?? undefined,
        content,
        url: (entry.url ?? entry.link) as string | undefined,
        kind: 'semantic',
        salience: 0.5,
        valence: 0,
        fingerprint: createHash('sha256').update(content).digest('hex').slice(0, 32),
      });
    }

    return { items };
  }
}

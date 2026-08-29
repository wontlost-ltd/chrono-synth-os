/**
 * 知识源 SSRF 回归测试（审计 #403）。
 *
 * 缺陷：`ApiKnowledgeSource` / `RssKnowledgeSource` 对**租户用户提交**的
 * `config.url` 直接调用裸 `fetch()`，无任何校验（Zod 只有 `z.string().url()`，
 * 接受任意 host/scheme）。攻击者指向 `http://169.254.169.254/...` 或内网
 * admin API，再经自己拥有的 autorun 触发摄入，**响应体会被导入记忆**并可
 * 经 `GET /api/v1/memories` 读回 —— 完整的 SSRF 读原语，不是盲打。
 *
 * 修法是复用同目录的 `UrlContentFetcher`（协议白名单 + 私有段拒绝 +
 * 全部 A 记录校验 + 连接 pin 到已验证 IP）。本文件锁住「确实接上了」。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ApiKnowledgeSource } from '../../knowledge/sources/api-source.js';
import { RssKnowledgeSource } from '../../knowledge/sources/rss-source.js';

const never = new AbortController().signal;

/** 内网/云元数据目标：命中任何一条都意味着 SSRF 防线失效。 */
const INTERNAL_URLS = [
  'http://169.254.169.254/latest/meta-data/',      /* AWS/Azure/GCP 元数据 */
  'http://127.0.0.1:8080/admin',                   /* 回环 */
  'http://localhost:9200/_cluster/health',         /* 本机服务 */
  'http://10.0.0.5/internal',                      /* RFC1918 */
  'http://192.168.1.1/router',                     /* RFC1918 */
  'http://172.16.0.10/svc',                        /* RFC1918 */
];

describe('知识源 SSRF 防护（审计 #403）', () => {
  for (const url of INTERNAL_URLS) {
    it(`ApiKnowledgeSource 必须拒绝内网地址 ${url}`, async () => {
      const src = new ApiKnowledgeSource();
      await assert.rejects(
        () => src.fetch({ url }, null, never),
        (err: Error) => {
          /* 判据是**被拒绝**，且理由是 SSRF/协议而非「连不上」——
           * 后者在 CI 里可能因为环境恰好没起服务而假绿。 */
          assert.match(
            err.message,
            /rejected/i,
            `应被 SSRF 防线拒绝而非网络错误，实际: ${err.message}`,
          );
          return true;
        },
        `内网地址 ${url} 必须被拒绝`,
      );
    });

    it(`RssKnowledgeSource 必须拒绝内网地址 ${url}`, async () => {
      const src = new RssKnowledgeSource();
      await assert.rejects(
        () => src.fetch({ url }, null, never),
        (err: Error) => {
          assert.match(err.message, /rejected/i, `应被 SSRF 防线拒绝，实际: ${err.message}`);
          return true;
        },
        `内网地址 ${url} 必须被拒绝`,
      );
    });
  }

  it('非 http(s) 协议必须拒绝（file:// 读本地文件）', async () => {
    const src = new ApiKnowledgeSource();
    await assert.rejects(
      () => src.fetch({ url: 'file:///etc/passwd' }, null, never),
      /rejected/i,
      'file:// 必须被协议白名单拒绝',
    );
  });

  it('缺 url 时返回空结果（不抛错，保持既有契约）', async () => {
    const api = await new ApiKnowledgeSource().fetch({}, null, never);
    assert.deepEqual(api.items, [], '无 url 应返回空 items');
    const rss = await new RssKnowledgeSource().fetch({}, null, never);
    assert.deepEqual(rss.items, [], '无 url 应返回空 items');
  });

  /* ⚠️ 攻击者可控的 `config.headers` 此前被原样透传进出站请求
   * （实测可注入 `Authorization: Bearer …` 打内网服务）。修复后已不再透传；
   * 这里锁住「即便传了 headers，内网目标仍然被拒」——
   * 保证 header 通道不能成为绕过 URL 校验的侧门。 */
  it('即使带自定义 headers，内网目标仍必须被拒绝', async () => {
    const src = new ApiKnowledgeSource();
    await assert.rejects(
      () => src.fetch(
        { url: 'http://169.254.169.254/latest/meta-data/', headers: { Authorization: 'Bearer forged' } },
        null,
        never,
      ),
      /rejected/i,
      'headers 不得成为绕过 URL 校验的侧门',
    );
  });
});

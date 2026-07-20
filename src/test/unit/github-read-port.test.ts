/**
 * 单元测试：GitHubReadPort（GitHub 只读端点，Plan 2 学习段消费）
 *
 * 铁律（spec 约束 ⑧）：本 port **只读**——绝不含 comment/review 等写方法
 *   （写侧是 Plan 4 的 GitHubWritePort）。本测试文件末尾断言 impl 上不存在
 *   任何写方法名，把"只读"钉成可回归的不变式。
 *
 * 所有出站请求都经注入的 fetchImpl（mock githubFetch）+ 注入的 auth
 *   （mock GitHubAuthManager），不真连 GitHub。断言：
 *   - 每个读方法都带 `Authorization: token <installation-token>` 头（Task 5）；
 *   - list 方法把 since 透传为 query；
 *   - 分页沿 Link header rel="next" 循环合并多页，封顶页数并 warn（不静默丢数据）；
 *   - auth 抛错（无凭据）时错误清晰浮现，不被吞掉。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  GitHubReadPortImpl,
  MAX_LIST_PAGES,
} from '../../integrations/github/github-read-port.js';
import type { GitHubAuthManager } from '../../integrations/github/github-auth-manager.js';
import type { githubFetch as GithubFetch } from '../../integrations/github/github-http.js';

/** 记录出站调用的 githubFetch spy；按预设队列依次返回 Response。 */
interface FetchCall {
  url: string;
  init: RequestInit;
  opts: unknown;
}
function makeFetchSpy(
  responses: Array<{ status?: number; body: string; headers?: Record<string, string> }>,
): { calls: FetchCall[]; impl: typeof GithubFetch } {
  const calls: FetchCall[] = [];
  let i = 0;
  const impl = (async (url: string, init: RequestInit, opts?: unknown) => {
    calls.push({ url, init, opts });
    const r = responses[Math.min(i, responses.length - 1)]!;
    i += 1;
    return new Response(r.body, {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json', ...(r.headers ?? {}) },
    });
  }) as unknown as typeof GithubFetch;
  return { calls, impl };
}

/** 返回固定 installation token 的 mock auth。 */
function makeAuth(token: string): GitHubAuthManager {
  return {
    getInstallationToken: async () => token,
  } as unknown as GitHubAuthManager;
}

/** 抛错的 mock auth（模拟 getApp 无凭据 → getInstallationToken throw）。 */
function makeThrowingAuth(): GitHubAuthManager {
  return {
    getInstallationToken: async () => {
      throw new Error('本租户未配置 GitHub App 凭据（getApp 返回 undefined）');
    },
  } as unknown as GitHubAuthManager;
}

/** 从调用里取 Authorization 头（headers 以对象形态传入）。 */
function authHeader(call: FetchCall): string {
  return (call.init.headers as Record<string, string>).Authorization ?? '';
}

describe('GitHubReadPort', () => {
  it('listIssues 带 Authorization: token <t> + since 参数', async () => {
    const spy = makeFetchSpy([{ body: '[]' }]);
    const port = new GitHubReadPortImpl(makeAuth('tok-abc'), { fetchImpl: spy.impl });

    await port.listIssues('owner/repo', '2026-01-01T00:00:00Z');

    assert.equal(spy.calls.length, 1);
    const call = spy.calls[0]!;
    /* URL 打到 /repos/owner/repo/issues 且带 since query。 */
    assert.match(call.url, /\/repos\/owner\/repo\/issues/);
    assert.match(call.url, /[?&]since=2026-01-01T00%3A00%3A00Z/);
    /* 携带 installation token（Task 5）——token 前缀而非 Bearer。 */
    assert.equal(authHeader(call), 'token tok-abc');
    assert.equal(
      (call.init.headers as Record<string, string>).Accept,
      'application/vnd.github+json',
    );
  });

  it('listIssues 解析 number/title/body/updatedAt', async () => {
    const sample = JSON.stringify([
      {
        number: 42,
        title: '登录页崩溃',
        body: '点击提交后白屏',
        updated_at: '2026-07-01T10:00:00Z',
        /* 巨型响应里的无关字段——不应被映射。 */
        user: { login: 'alice', id: 1, avatar_url: 'x' },
        labels: [{ name: 'bug' }],
        reactions: { '+1': 3 },
      },
    ]);
    const spy = makeFetchSpy([{ body: sample }]);
    const port = new GitHubReadPortImpl(makeAuth('t'), { fetchImpl: spy.impl });

    const issues = await port.listIssues('owner/repo');
    assert.equal(issues.length, 1);
    const issue = issues[0]!;
    assert.equal(issue.number, 42);
    assert.equal(issue.title, '登录页崩溃');
    assert.equal(issue.body, '点击提交后白屏');
    assert.equal(issue.updatedAt, '2026-07-01T10:00:00Z');
    /* 精简映射：不透传 GitHub 巨型响应字段。 */
    assert.equal((issue as unknown as Record<string, unknown>).user, undefined);
    assert.equal((issue as unknown as Record<string, unknown>).reactions, undefined);
  });

  it('listIssues 过滤 PR（issues 端点会混入 pull_request）', async () => {
    /* GitHub 的 /issues 端点把 PR 也当 issue 返回（带 pull_request 字段）；
     * 学习段只要真 issue，须过滤掉 PR。 */
    const sample = JSON.stringify([
      { number: 1, title: '真 issue', body: 'x', updated_at: '2026-01-01T00:00:00Z' },
      {
        number: 2,
        title: '其实是 PR',
        body: 'y',
        updated_at: '2026-01-02T00:00:00Z',
        pull_request: { url: 'https://api.github.com/repos/o/r/pulls/2' },
      },
    ]);
    const spy = makeFetchSpy([{ body: sample }]);
    const port = new GitHubReadPortImpl(makeAuth('t'), { fetchImpl: spy.impl });

    const issues = await port.listIssues('owner/repo');
    assert.equal(issues.length, 1, 'PR 应被过滤掉，只留真 issue');
    assert.equal(issues[0]!.number, 1);
  });

  it('分页：Link rel="next" → 拉第二页并合并', async () => {
    const page1 = JSON.stringify([
      { number: 1, title: 'a', body: '', updated_at: '2026-01-01T00:00:00Z' },
    ]);
    const page2 = JSON.stringify([
      { number: 2, title: 'b', body: '', updated_at: '2026-01-02T00:00:00Z' },
    ]);
    const spy = makeFetchSpy([
      {
        body: page1,
        headers: {
          /* 首页给出 next 链接（GitHub Link header 格式）。 */
          Link: '<https://api.github.com/repos/owner/repo/issues?page=2>; rel="next", <https://api.github.com/repos/owner/repo/issues?page=5>; rel="last"',
        },
      },
      /* 次页无 Link header → 停止分页。 */
      { body: page2 },
    ]);
    const port = new GitHubReadPortImpl(makeAuth('t'), { fetchImpl: spy.impl });

    const issues = await port.listIssues('owner/repo');
    assert.equal(spy.calls.length, 2, '应沿 next 拉两页');
    assert.equal(issues.length, 2, '两页应合并');
    assert.deepEqual(issues.map((i) => i.number), [1, 2]);
    /* 第二页 URL 就是首页 Link 里的 next。 */
    assert.match(spy.calls[1]!.url, /[?&]page=2/);
    /* 每页都带 token。 */
    assert.equal(authHeader(spy.calls[1]!), 'token t');
  });

  it('分页封顶：超过 MAX_LIST_PAGES 停止并 warn（不静默丢数据）', async () => {
    /* 每页都返回带 next 的 Link，制造无限分页——应在 MAX_LIST_PAGES 处封顶。 */
    const bodyOf = (n: number) =>
      JSON.stringify([{ number: n, title: 't', body: '', updated_at: '2026-01-01T00:00:00Z' }]);
    const nextLink = (n: number) => ({
      body: bodyOf(n),
      headers: {
        Link: `<https://api.github.com/repos/owner/repo/issues?page=${n + 1}>; rel="next"`,
      },
    });
    const spy = makeFetchSpy(Array.from({ length: MAX_LIST_PAGES + 3 }, (_, k) => nextLink(k + 1)));
    const port = new GitHubReadPortImpl(makeAuth('t'), { fetchImpl: spy.impl });

    /* 捕获 console.warn，断言截断被显式记录（no silent caps）。 */
    const original = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };
    try {
      const issues = await port.listIssues('owner/repo');
      assert.equal(spy.calls.length, MAX_LIST_PAGES, '页数应封顶在 MAX_LIST_PAGES');
      assert.equal(issues.length, MAX_LIST_PAGES);
      assert.ok(
        warnings.some((w) => /截断|truncat|封顶|MAX_LIST_PAGES|页/.test(w)),
        '截断必须显式 warn，不能静默丢数据',
      );
    } finally {
      console.warn = original;
    }
  });

  it('listPulls 打 /pulls 端点，映射 number/title/body/updatedAt', async () => {
    const sample = JSON.stringify([
      { number: 7, title: '修复登录', body: 'PR body', updated_at: '2026-07-02T00:00:00Z' },
    ]);
    const spy = makeFetchSpy([{ body: sample }]);
    const port = new GitHubReadPortImpl(makeAuth('t'), { fetchImpl: spy.impl });

    const pulls = await port.listPulls('owner/repo', '2026-01-01T00:00:00Z');
    assert.match(spy.calls[0]!.url, /\/repos\/owner\/repo\/pulls/);
    assert.equal(authHeader(spy.calls[0]!), 'token t');
    assert.equal(pulls.length, 1);
    assert.equal(pulls[0]!.number, 7);
    assert.equal(pulls[0]!.title, '修复登录');
    assert.equal(pulls[0]!.updatedAt, '2026-07-02T00:00:00Z');
  });

  it('listCommits 打 /commits 端点，映射 sha/message/committedAt', async () => {
    const sample = JSON.stringify([
      {
        sha: 'abc123',
        commit: {
          message: '重构认证链',
          committer: { date: '2026-07-03T00:00:00Z' },
        },
      },
    ]);
    const spy = makeFetchSpy([{ body: sample }]);
    const port = new GitHubReadPortImpl(makeAuth('t'), { fetchImpl: spy.impl });

    const commits = await port.listCommits('owner/repo', '2026-01-01T00:00:00Z');
    assert.match(spy.calls[0]!.url, /\/repos\/owner\/repo\/commits/);
    assert.equal(authHeader(spy.calls[0]!), 'token t');
    assert.equal(commits.length, 1);
    assert.equal(commits[0]!.sha, 'abc123');
    assert.equal(commits[0]!.message, '重构认证链');
    assert.equal(commits[0]!.committedAt, '2026-07-03T00:00:00Z');
  });

  it('getRepoTree 先查默认分支再拉 tree（recursive），映射 sha/paths', async () => {
    const repoResp = JSON.stringify({ default_branch: 'main' });
    const treeResp = JSON.stringify({
      sha: 'tree-sha-1',
      tree: [
        { path: 'src/index.ts', type: 'blob', sha: 'b1' },
        { path: 'src', type: 'tree', sha: 't1' },
        { path: 'README.md', type: 'blob', sha: 'b2' },
      ],
    });
    const spy = makeFetchSpy([{ body: repoResp }, { body: treeResp }]);
    const port = new GitHubReadPortImpl(makeAuth('t'), { fetchImpl: spy.impl });

    const tree = await port.getRepoTree('owner/repo');
    /* 第一跳查 repo 拿 default_branch，第二跳拉 tree。 */
    assert.match(spy.calls[0]!.url, /\/repos\/owner\/repo$/);
    assert.match(spy.calls[1]!.url, /\/repos\/owner\/repo\/git\/trees\/main\?recursive=1/);
    assert.equal(authHeader(spy.calls[1]!), 'token t');
    assert.equal(tree.sha, 'tree-sha-1');
    /* 只收 blob（文件）路径，目录节点（type=tree）排除。 */
    assert.deepEqual(tree.paths, ['src/index.ts', 'README.md']);
  });

  it('getFileContent 解 base64 content', async () => {
    const raw = 'hello 世界\n第二行';
    const encoded = Buffer.from(raw, 'utf8').toString('base64');
    const resp = JSON.stringify({
      content: encoded,
      encoding: 'base64',
      path: 'docs/readme.md',
    });
    const spy = makeFetchSpy([{ body: resp }]);
    const port = new GitHubReadPortImpl(makeAuth('t'), { fetchImpl: spy.impl });

    const content = await port.getFileContent('owner/repo', 'docs/readme.md');
    assert.match(spy.calls[0]!.url, /\/repos\/owner\/repo\/contents\/docs\/readme\.md/);
    assert.equal(authHeader(spy.calls[0]!), 'token t');
    assert.equal(content, raw, 'base64 content 须解码回原文');
  });

  it('无凭据（auth throw）→ 错误清晰浮现，不被吞', async () => {
    const spy = makeFetchSpy([{ body: '[]' }]);
    const port = new GitHubReadPortImpl(makeThrowingAuth(), { fetchImpl: spy.impl });

    await assert.rejects(
      () => port.listIssues('owner/repo'),
      /GitHub|凭据|credential|未连接|未配置/i,
    );
    /* auth 先失败 → 绝不发出网络请求。 */
    assert.equal(spy.calls.length, 0, 'auth 失败时不应发请求');
  });

  it('非 2xx 响应 → 抛错', async () => {
    const spy = makeFetchSpy([{ status: 404, body: '{"message":"Not Found"}' }]);
    const port = new GitHubReadPortImpl(makeAuth('t'), { fetchImpl: spy.impl });
    await assert.rejects(() => port.listIssues('owner/repo'), /404|失败|Not Found/i);
  });

  it('铁律：只读 port——不含任何写方法（comment/review/create/update/...）', () => {
    const port = new GitHubReadPortImpl(makeAuth('t'), { fetchImpl: makeFetchSpy([{ body: '[]' }]).impl });
    /* 只允许以下读方法存在。 */
    const readMethods = new Set([
      'listIssues',
      'listPulls',
      'listCommits',
      'getRepoTree',
      'getFileContent',
    ]);
    /* 收集实例 + 原型链上的所有方法名。 */
    const methodNames = new Set<string>();
    let proto: object | null = Object.getPrototypeOf(port);
    while (proto && proto !== Object.prototype) {
      for (const name of Object.getOwnPropertyNames(proto)) {
        if (name === 'constructor') continue;
        if (typeof (port as unknown as Record<string, unknown>)[name] === 'function') {
          methodNames.add(name);
        }
      }
      proto = Object.getPrototypeOf(proto);
    }
    /* 禁止任何疑似写操作的方法名。 */
    const writeVerbs = /(comment|review|create|update|delete|post|put|patch|write|merge|close|open|submit|approve|dismiss|add|remove|set)/i;
    for (const name of methodNames) {
      /* 公开读方法在白名单里；其余不得命中写动词。 */
      if (readMethods.has(name)) continue;
      assert.ok(
        !writeVerbs.test(name),
        `只读 port 不得含疑似写方法：${name}（写侧属 Plan 4 GitHubWritePort）`,
      );
    }
    /* 五个读方法必须齐全。 */
    for (const m of readMethods) {
      assert.equal(typeof (port as unknown as Record<string, unknown>)[m], 'function', `缺读方法：${m}`);
    }
  });
});

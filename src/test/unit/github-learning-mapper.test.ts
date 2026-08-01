/**
 * 单元测试：GitHubLearningMapper（四类内容 → 文本表征，spec §5.2）。
 *
 * 这是学习段唯一的新领域逻辑——纯函数，无 IO/网络/LLM（零-LLM，确定性文本拼接）。
 * 断言两条不变式：
 *   1. representation 保留关键结构（issue 标题+正文摘要+讨论要点、pull 的 filesChanged 列表、
 *      code 的顶层目录/关键文件、commits 的 message 聚合），照 §5.2 模板，不压成散文。
 *   2. contentSha 是 representation 的 sha256——这是 Task 3 digest 去重的键，
 *      同输入同 sha、representation 变则 sha 变，必须确定性。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mapCodeAndReadme,
  mapIssue,
  mapPull,
  mapCommits,
} from '../../integrations/github/github-learning-mapper.js';
import type {
  GitHubIssue,
  GitHubPull,
  GitHubCommit,
  GitHubTree,
} from '../../integrations/github/github-read-port.js';

function issue(over: Partial<GitHubIssue> = {}): GitHubIssue {
  return { number: 42, title: '默认标题', body: '默认正文', updatedAt: '2026-07-01T00:00:00Z', comments: 0, ...over };
}

function pull(over: Partial<GitHubPull> = {}): GitHubPull {
  return { number: 7, title: '默认 PR', body: '默认 PR 正文', updatedAt: '2026-07-01T00:00:00Z', ...over };
}

function commit(over: Partial<GitHubCommit> = {}): GitHubCommit {
  return { sha: 'abc123', message: '默认提交', committedAt: '2026-07-01T00:00:00Z', ...over };
}

function tree(over: Partial<GitHubTree> = {}): GitHubTree {
  return { sha: 'treesha', paths: ['src/index.ts', 'README.md', 'package.json'], ...over };
}

/** 通用不变式：contentSha 必须等于 representation 的 sha256。 */
function assertContentShaMatches(result: { representation: string; contentSha: string }): void {
  const expected = createHash('sha256').update(result.representation).digest('hex');
  assert.equal(result.contentSha, expected, 'contentSha 必须是 representation 的 sha256');
}

describe('mapIssue', () => {
  it('representation 以「关于「<repo> issue #<N>」我学到：」开头', () => {
    const result = mapIssue('acme/widget', issue({ number: 99 }), []);
    assert.ok(
      result.representation.startsWith('关于「acme/widget issue #99」我学到：'),
      `实际开头：${result.representation.slice(0, 40)}`,
    );
  });

  it('含标题 + 正文摘要 + 讨论要点', () => {
    const result = mapIssue(
      'acme/widget',
      issue({ title: '登录页崩溃', body: '点登录按钮就白屏，控制台报 null 引用' }),
      ['经排查是 token 未初始化', '已在 PR #7 修复'],
    );
    assert.match(result.representation, /登录页崩溃/, '缺标题');
    assert.match(result.representation, /白屏/, '缺正文摘要');
    assert.match(result.representation, /token 未初始化/, '缺讨论要点');
  });

  it('contentSha 是 representation 的 sha256', () => {
    assertContentShaMatches(mapIssue('acme/widget', issue(), ['一条讨论']));
  });
});

describe('mapPull', () => {
  it('filesChanged 非空时 representation 含这些文件名（保留 files-changed 列表）', () => {
    const result = mapPull(
      'acme/widget',
      pull({ number: 12, title: '重构鉴权', filesChanged: ['src/auth.ts', 'src/session.ts'] }),
      ['注意并发场景'],
    );
    assert.match(result.representation, /src\/auth\.ts/, '缺 filesChanged 中的 src/auth.ts');
    assert.match(result.representation, /src\/session\.ts/, '缺 filesChanged 中的 src/session.ts');
  });

  it('representation 以「关于「<repo> PR #<N>」我学到：」开头并含标题', () => {
    const result = mapPull('acme/widget', pull({ number: 5, title: '加缓存层' }), []);
    assert.ok(
      result.representation.startsWith('关于「acme/widget PR #5」我学到：'),
      `实际开头：${result.representation.slice(0, 40)}`,
    );
    assert.match(result.representation, /加缓存层/);
  });

  it('contentSha 是 representation 的 sha256', () => {
    assertContentShaMatches(mapPull('acme/widget', pull({ filesChanged: ['a.ts'] }), []));
  });
});

describe('mapCommits', () => {
  it('聚合多条 commit message', () => {
    const result = mapCommits('acme/widget', [
      commit({ sha: 'c1', message: 'feat: 加登录' }),
      commit({ sha: 'c2', message: 'fix: 修空指针' }),
      commit({ sha: 'c3', message: 'docs: 更新 README' }),
    ]);
    assert.match(result.representation, /加登录/, '缺第 1 条 message');
    assert.match(result.representation, /修空指针/, '缺第 2 条 message');
    assert.match(result.representation, /更新 README/, '缺第 3 条 message');
  });

  it('representation 以「关于「<repo> 演进」我学到：」开头', () => {
    const result = mapCommits('acme/widget', [commit()]);
    assert.ok(
      result.representation.startsWith('关于「acme/widget 演进」我学到：'),
      `实际开头：${result.representation.slice(0, 40)}`,
    );
  });

  it('contentSha 是 representation 的 sha256', () => {
    assertContentShaMatches(mapCommits('acme/widget', [commit()]));
  });
});

describe('mapCodeAndReadme', () => {
  it('representation 以「关于「<repo>」我学到：」开头并含语言 + README 摘要', () => {
    const result = mapCodeAndReadme(
      'acme/widget',
      tree(),
      '一个高性能的分片路由库，支持零停机迁移。',
      'TypeScript',
    );
    assert.ok(
      result.representation.startsWith('关于「acme/widget」我学到：'),
      `实际开头：${result.representation.slice(0, 40)}`,
    );
    assert.match(result.representation, /TypeScript/, '缺语言');
    assert.match(result.representation, /分片路由库/, '缺 README 摘要');
  });

  it('列出顶层目录 / 关键文件（保留结构，不灌全树）', () => {
    const result = mapCodeAndReadme(
      'acme/widget',
      tree({ paths: ['src/a.ts', 'src/b.ts', 'package.json', 'docs/x.md'] }),
      'README 正文',
      'TypeScript',
    );
    // 关键清单文件应被点名
    assert.match(result.representation, /package\.json/, '关键文件 package.json 应被保留');
    // 顶层目录应出现
    assert.match(result.representation, /src/, '顶层目录 src 应出现');
  });

  it('contentSha 是 representation 的 sha256', () => {
    assertContentShaMatches(mapCodeAndReadme('acme/widget', tree(), 'readme', 'Go'));
  });
});

describe('contentSha 确定性（Task 3 digest 去重键）', () => {
  it('同输入 → 同 sha', () => {
    const a = mapIssue('acme/widget', issue(), ['x']);
    const b = mapIssue('acme/widget', issue(), ['x']);
    assert.equal(a.contentSha, b.contentSha);
    assert.equal(a.representation, b.representation);
  });

  it('representation 变 → sha 变', () => {
    const a = mapIssue('acme/widget', issue({ title: '标题 A' }), []);
    const b = mapIssue('acme/widget', issue({ title: '标题 B' }), []);
    assert.notEqual(a.representation, b.representation);
    assert.notEqual(a.contentSha, b.contentSha);
  });
});

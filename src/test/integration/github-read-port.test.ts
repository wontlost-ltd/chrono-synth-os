/**
 * 集成测试（gated）：GitHubReadPort 真拉一个小 public repo。
 *
 * 门控（照 memory 里 PG rollback 探针的 gated 模式）：无 GITHUB_TEST_TOKEN
 *   时整组 skip——本地无 token 时 skip 是**预期**，不 fail。有 token 时才真
 *   走网络：注入一个直接返回该 token 的 auth（绕过 App JWT 换取链，本测试只
 *   验 ReadPort 的读端点/映射/分页，不验认证链——认证链已由
 *   github-auth-manager 单测覆盖）。
 *
 * 需要的环境变量：
 *   - GITHUB_TEST_TOKEN：一枚能读 public repo 的 token（PAT 或 installation
 *     token 均可，ReadPort 以 `token <t>` 发请求）。
 *   - GITHUB_TEST_REPO：可选，形如 owner/repo 的小 public 仓库；缺省用
 *     octocat/Hello-World（GitHub 官方示例仓，稳定存在）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GitHubReadPortImpl } from '../../integrations/github/github-read-port.js';
import type { GitHubAuthManager } from '../../integrations/github/github-auth-manager.js';

const TEST_TOKEN = process.env.GITHUB_TEST_TOKEN;
const TEST_REPO = process.env.GITHUB_TEST_REPO ?? 'octocat/Hello-World';

/** 直接返回固定 token 的 auth（集成测试绕过 App JWT 换取链）。 */
function tokenAuth(token: string): GitHubAuthManager {
  return { getInstallationToken: async () => token } as unknown as GitHubAuthManager;
}

describe('GitHubReadPort integration', { skip: !TEST_TOKEN }, () => {
  const port = new GitHubReadPortImpl(tokenAuth(TEST_TOKEN ?? ''));

  it('真拉 public repo 的 commits，非空且字段完整', async () => {
    const commits = await port.listCommits(TEST_REPO);
    assert.ok(commits.length > 0, `${TEST_REPO} 应有至少一条 commit`);
    const first = commits[0]!;
    assert.equal(typeof first.sha, 'string');
    assert.ok(first.sha.length > 0, 'commit sha 应非空');
    assert.equal(typeof first.message, 'string');
    assert.ok(first.committedAt.length > 0, 'commit 时间应非空');
  });

  it('真拉 public repo 的目录树，含文件路径', async () => {
    const tree = await port.getRepoTree(TEST_REPO);
    assert.ok(tree.sha.length > 0, 'tree sha 应非空');
    assert.ok(tree.paths.length > 0, '目录树应含至少一个文件');
  });

  it('真读 public repo 的 README，内容非空', async () => {
    /* octocat/Hello-World 的 README 存在；自定义 repo 若无 README 此断言会失败，
     * 属预期（表明该 repo 无 README）。 */
    const content = await port.getFileContent(TEST_REPO, 'README');
    assert.ok(content.length > 0, 'README 内容应非空');
  });
});

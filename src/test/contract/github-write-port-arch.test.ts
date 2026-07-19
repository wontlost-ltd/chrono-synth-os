/**
 * 架构依赖契约测试：GitHubWritePort 的 import 边界（把纪律升级为结构守护）。
 *
 * GitHubWritePort 是**整个系统里唯一能对 GitHub 写**的模块（createIssueComment /
 * createReview——经 githubFetch SSRF 网关真发）。发布侧的不可降级安全不变量是：
 * 任何 GitHub 写操作都必须经过 highRisk 写工具（github.comment / github.review）→
 * ToolInvocationPipeline 的不可降级人工确认门。若别处能直接 import WritePort，就等于
 * 开了一条绕过审批门直写 GitHub 的旁路——这正是本测试要在结构上钉死的。
 *
 * 因此 WritePort 只允许被以下三类持有者 import：
 *   ① 写工具本身（github-comment-tool——真正持 WritePort 执行写，受 highRisk 门约束）；
 *   ② 组合根（server/app.ts——在启动时注入 WritePort resolver，是依赖注入的唯一装配点）；
 *   ③ 针对 WritePort/发布链自身的测试（unit + e2e——直接构造/驱动 WritePort 做行为验证）。
 *
 * 遍历 src/**\/*.ts，对每个文件跑 IMPORT_RE，若某文件的 import specifier 含
 * `github-write-port` 且该文件不在 allowlist → 记为 violation → deepEqual([]) 断言。
 * 任何新文件（如某条路由、某个 service）想直接 import WritePort，都会让本测试变红，
 * 强制它改走写工具 + 审批门，而不是私开写通道。
 *
 * 遍历模式参照同目录 kernel-zero-deps.test.ts 的 walkTs + IMPORT_RE。
 *
 * 注：github-review-tool.ts 只从 github-comment-tool.js import GitHubWritePortResolver
 * **类型**（不直接 import github-write-port），故不在 allowlist——它天然不会被 IMPORT_RE
 * 命中；把它列进 allowlist 反而是一条永不触发的死条目，故据实排除。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { resolve, join, relative, sep } from 'node:path';

const SRC = resolve(process.cwd(), 'src');

/** 本扫描器自身的源文件——它必然在文档/断言里书写 `github-write-port` 这个 token，
 *  扫描自己会得到 prose 假阳性。扫描器不扫自己，从遍历里排除。 */
const SELF = resolve(process.cwd(), 'src/test/contract/github-write-port-arch.test.ts');

function walkTs(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) walkTs(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

/**
 * 匹配全部三种 import specifier 形态，任何一种都可能真的把模块拉进来：
 *   ① 静态 import ... from '...'  /  export ... from '...'
 *   ② 副作用 import '...'（无绑定，仅执行——照样引入模块，是绕过点）
 *   ③ 动态 import('...')  /  require('...')
 * 只匹配 from 会漏掉 ②③——副作用形态的 WritePort import（import 后直接跟模块字符串、
 * 无 from）正是最隐蔽的旁路（Step 3 变异用的就是它），必须一并覆盖。
 * 捕获组 1/2/3 分别对应三种形态的 specifier；命中哪个取哪个。
 */
const IMPORT_RE =
  /\bfrom\s+['"]([^'"]+)['"]|\bimport\s+['"]([^'"]+)['"]|\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/**
 * WritePort 的合法持有者（写工具 + 组合根 + 发布链测试）。
 * 用相对 src 的 POSIX 路径匹配（walkTs 产出绝对路径，比较前归一化）。
 * 该集合就是当前 `grep -rln github-write-port src/` 里**真正 import github-write-port
 * 模块**（任一 import 形态）的全部文件——本扫描器自身除外（已在遍历里排除）；
 * github-review-tool 只在注释里出现 github-write-port（且只 import comment-tool 的
 * GitHubWritePortResolver 类型），不 import 该模块，故不计入。
 */
const ALLOWLIST = new Set<string>([
  /* ① 写工具：唯一真正持 WritePort 执行写，受 highRisk 审批门约束 */
  'src/agent/tools/github-comment-tool.ts',
  /* ② 组合根：启动时注入 WritePort resolver（依赖注入唯一装配点） */
  'src/server/app.ts',
  /* ③ 针对 WritePort / 发布链自身的测试 */
  'src/test/unit/github-write-port.test.ts',
  'src/test/unit/github-publish-tool.test.ts',
  'src/test/integration/github-publish-e2e.test.ts',
]);

/** 把绝对路径归一化成相对 cwd 的 POSIX 路径（跨平台稳定，与 allowlist 比较）。 */
function toPosixRel(absPath: string): string {
  return relative(process.cwd(), absPath).split(sep).join('/');
}

describe('GitHubWritePort import 边界契约（结构守护发布审批门）', () => {
  it('WritePort 只允许被写工具 + 组合根 + 发布链测试 import；别处 import = 绕过审批门直写 GitHub', () => {
    assert.ok(existsSync(SRC), `expected source root at ${SRC}`);
    const files = walkTs(SRC);

    /* 前置一致性守：allowlist 里的每个文件都必须真实存在，防 rename/move 后
     * allowlist 成陈旧死条目（否则一条被移动的持有者会静默变成漏网 violation）。 */
    for (const entry of ALLOWLIST) {
      assert.ok(
        existsSync(resolve(process.cwd(), entry)),
        `allowlist 条目不存在（可能已 rename/move，请同步更新 allowlist）：${entry}`,
      );
    }

    const violations: Array<{ file: string; specifier: string }> = [];
    for (const file of files) {
      if (file === SELF) continue; /* 扫描器不扫自己（prose 假阳性） */
      const rel = toPosixRel(file);
      if (ALLOWLIST.has(rel)) continue;
      const src = readFileSync(file, 'utf8');
      let match: RegExpExecArray | null;
      IMPORT_RE.lastIndex = 0;
      while ((match = IMPORT_RE.exec(src)) !== null) {
        /* 三个捕获组按 from / 副作用 / 动态 三种形态互斥命中，取非空的那个。 */
        const spec = match[1] ?? match[2] ?? match[3];
        if (spec && spec.includes('github-write-port')) {
          violations.push({ file: rel, specifier: spec });
        }
      }
    }

    assert.deepEqual(
      violations,
      [],
      'GitHubWritePort 是系统里唯一能对 GitHub 写的模块，只允许写工具（github-comment-tool）、' +
        '组合根（server/app.ts）与发布链测试持有。以下文件直接 import 了 github-write-port——' +
        '这等于开了一条绕过 highRisk 不可降级审批门、直接对 GitHub 写的旁路，必须改走写工具 + ' +
        `审批门：\n${violations.map((v) => `  ${v.file} → ${v.specifier}`).join('\n')}`,
    );
  });
});

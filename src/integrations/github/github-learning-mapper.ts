/**
 * GitHubLearningMapper：GitHub 四类内容 → 文本表征（spec §5.2）。
 *
 * 学习段唯一的新领域逻辑，**纯函数**——无 IO、无网络、无 LLM（零-LLM 铁律：
 * 映射是确定性文本拼接，绝不调模型。LLM 老师是 Task 5 perceive 里 provider
 * 的事，不在 mapper）。四个 map 分别把 code+README / issue / PR / commits 压成
 * 一段「关于「<repo> …」我学到：…」文本，供 Task 5 编排 service 灌进 perceive。
 *
 * 两条不变式：
 *   ① 保留关键结构（不压成散文）：issue 拼标题+正文摘要+讨论要点、PR 列
 *      filesChanged、code 列顶层目录+关键文件、commits 聚合 message。照 §5.2 模板。
 *   ② contentSha = sha256(representation)：这是 Task 3 digest claim 的去重键——
 *      同输入同 sha、representation 变则 sha 变，故 sha 只依赖最终文本，必须确定性。
 *
 * 「保留结构 ≠ 灌全文」：大 repo 别把整棵 tree 塞进去（会拉爆配额、稀释信号）。
 * mapCodeAndReadme 用「关键文件启发式」只列顶层目录 + 少量清单/入口文件，README
 * 也截取摘要而非全文。见下 CODE_* / SUMMARY_* 常量。
 */

import { createHash } from 'node:crypto';
import type {
  GitHubIssue,
  GitHubPull,
  GitHubCommit,
  GitHubTree,
} from './github-read-port.js';

/** 映射结果：文本表征 + 其 sha256（Task 3 digest claim 去重键）。 */
export interface MappedLearning {
  /** 「关于「<repo> …」我学到：…」文本表征（喂进 perceive）。 */
  representation: string;
  /** representation 的 sha256（十六进制）。同输入同 sha、文本变则 sha 变。 */
  contentSha: string;
  /**
   * 讨论稳定标识（issues:owner/repo#42）；code/commits 无讨论概念时为 undefined。
   * 与 contentSha 正交：contentSha 随讨论内容变化，discussionKey 跨轮次恒定——
   * 演进式取代靠它定位「同一 issue 的上一版记忆」。
   */
  discussionKey?: string;
}

/** README 摘要上限（字符）：避免整篇 README 灌进表征稀释信号。 */
const SUMMARY_MAX_CHARS = 280;
/** issue/PR 正文摘要上限（字符）。 */
const BODY_MAX_CHARS = 280;
/** 单条讨论/review 要点上限（字符）。 */
const COMMENT_MAX_CHARS = 160;
/** 讨论/review 最多纳入几条要点（保留信号，不灌全部楼层）。 */
const MAX_COMMENTS = 5;
/** code 表征最多列几个顶层目录。 */
const MAX_TOP_DIRS = 12;
/** code 表征最多点名几个关键文件。 */
const MAX_KEY_FILES = 8;
/** PR filesChanged 最多列几个文件名（其余以「等 N 个文件」收口）。 */
const MAX_PULL_FILES = 20;
/** commits 最多聚合几条 message（其余以「等 N 次提交」收口）。 */
const MAX_COMMIT_MESSAGES = 15;

/**
 * 「关键文件」清单：仓库根部这些文件对理解项目「是什么」信息量最高
 * （语言/构建/依赖/入口），优先点名。参 §5.2「关键文件启发式」。
 */
const KEY_FILE_NAMES = new Set([
  'package.json',
  'pyproject.toml',
  'setup.py',
  'requirements.txt',
  'go.mod',
  'cargo.toml',
  'pom.xml',
  'build.gradle',
  'gemfile',
  'composer.json',
  'dockerfile',
  'makefile',
  'readme.md',
  'readme',
  'license',
]);

/**
 * 代码 + README → 表征。
 *
 * 结构：语言 + README 摘要 + 核心模块（顶层目录 + 点名的关键文件）。不逐文件
 * 全拉——只列顶层目录结构与少量关键文件（启发式），大 repo 也不会灌爆。
 */
export function mapCodeAndReadme(
  repo: string,
  tree: GitHubTree,
  readme: string,
  lang: string,
): MappedLearning {
  const language = lang.trim() || '未知语言';
  /* README 摘要后接模板的「。」——去掉摘要自身尾部的句末标点，避免「做 …。。」双句号。 */
  const readmeSummary = trimTrailingSentencePunct(summarize(readme, SUMMARY_MAX_CHARS)) || '（无 README 说明）';
  const modules = describeModules(tree.paths);
  const representation =
    `关于「${repo}」我学到：这是一个 ${language} 项目，做 ${readmeSummary}。` +
    `核心模块：${modules}`;
  return finalize(representation);
}

/**
 * Issue + 讨论 → 表征。
 *
 * 结构：标题 + 正文摘要 + 讨论要点（comments 逐条摘要拼接）。
 */
export function mapIssue(repo: string, issue: GitHubIssue, comments: string[]): MappedLearning {
  const title = issue.title.trim() || '（无标题）';
  const bodySummary = summarize(issue.body, BODY_MAX_CHARS) || '（无正文）';
  const discussion = summarizeComments(comments) || '（暂无讨论）';
  const representation =
    `关于「${repo} issue #${issue.number}」我学到：${title}。` +
    `问题是 ${bodySummary}。讨论结论：${discussion}`;
  return finalize(representation);
}

/**
 * PR + code review → 表征。
 *
 * 结构：标题 + 改动文件列表（filesChanged）+ review 意见要点。filesChanged
 * 非空时逐个列出（超上限收口），空时如实标注「（未记录改动文件）」。
 */
export function mapPull(repo: string, pull: GitHubPull, reviewComments: string[]): MappedLearning {
  const title = pull.title.trim() || '（无标题）';
  const files = describeFiles(pull.filesChanged);
  const review = summarizeComments(reviewComments) || '（暂无 review 意见）';
  const representation =
    `关于「${repo} PR #${pull.number}」我学到：${title}。` +
    `改了 ${files}。review 意见：${review}`;
  return finalize(representation);
}

/**
 * Commit 历史 → 表征。
 *
 * 结构：聚合近期 commit message（超上限收口）。演进方向留给下游/记忆检索推导，
 * 这里只如实聚合原始 message，不做零-LLM 之外的语义推断（避免编造）。
 */
export function mapCommits(repo: string, commits: GitHubCommit[]): MappedLearning {
  const aggregated = aggregateCommitMessages(commits);
  const representation = `关于「${repo} 演进」我学到：近期提交 ${aggregated}`;
  return finalize(representation);
}

/* ────────────────────────── 内部纯辅助 ────────────────────────── */

/** 拼最终结果：算 representation 的 sha256 作为 contentSha。 */
function finalize(representation: string): MappedLearning {
  const contentSha = createHash('sha256').update(representation).digest('hex');
  return { representation, contentSha };
}

/** 去掉字符串尾部的句末标点（中英文句号/省略号），拼模板时避免双标点。 */
function trimTrailingSentencePunct(text: string): string {
  return text.replace(/[。.…]+$/u, '');
}

/**
 * 把多行文本压成单行摘要并截断：折叠空白、去首尾空格，超 max 加省略号。
 * 空输入返回空串（调用方自行填占位语）。
 */
function summarize(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= max) {
    return collapsed;
  }
  return `${collapsed.slice(0, max)}…`;
}

/**
 * 把 comments 数组压成讨论要点串：逐条摘要、丢弃空条、最多 MAX_COMMENTS 条，
 * 「；」分隔；超出条数以「等 N 条讨论」收口（不静默丢，显式标注剩余数）。
 */
function summarizeComments(comments: string[]): string {
  const points = comments.map((c) => summarize(c, COMMENT_MAX_CHARS)).filter((c) => c.length > 0);
  if (points.length === 0) {
    return '';
  }
  const shown = points.slice(0, MAX_COMMENTS);
  const rest = points.length - shown.length;
  const suffix = rest > 0 ? `；等 ${rest} 条讨论` : '';
  return shown.join('；') + suffix;
}

/**
 * 描述仓库核心模块：顶层目录清单 + 点名的关键文件。只列结构、不列全部文件。
 * 顶层目录去重取前 MAX_TOP_DIRS；关键文件按 KEY_FILE_NAMES 命中取前 MAX_KEY_FILES。
 */
function describeModules(paths: string[]): string {
  const topDirs: string[] = [];
  const seenDirs = new Set<string>();
  const keyFiles: string[] = [];
  const seenKey = new Set<string>();

  for (const path of paths) {
    const slash = path.indexOf('/');
    if (slash > 0) {
      const dir = path.slice(0, slash);
      if (!seenDirs.has(dir)) {
        seenDirs.add(dir);
        topDirs.push(dir);
      }
    }
    // 关键文件按 basename 小写匹配（KEY_FILE_NAMES 也是小写）。
    const base = (slash >= 0 ? path.slice(path.lastIndexOf('/') + 1) : path).toLowerCase();
    if (KEY_FILE_NAMES.has(base) && !seenKey.has(base)) {
      seenKey.add(base);
      keyFiles.push(slash >= 0 ? path.slice(path.lastIndexOf('/') + 1) : path);
    }
  }

  const dirPart =
    topDirs.length > 0
      ? `顶层目录 ${joinWithCap(topDirs, MAX_TOP_DIRS, '个目录')}`
      : '（无子目录，单层结构）';
  const filePart =
    keyFiles.length > 0
      ? `；关键文件 ${joinWithCap(keyFiles, MAX_KEY_FILES, '个关键文件')}`
      : '';
  return dirPart + filePart;
}

/** 描述 PR 改动文件列表：非空逐个列（超上限收口），空标注未记录。 */
function describeFiles(filesChanged: string[] | undefined): string {
  if (!filesChanged || filesChanged.length === 0) {
    return '（未记录改动文件）';
  }
  return joinWithCap(filesChanged, MAX_PULL_FILES, '个文件');
}

/** 聚合 commit message：逐条摘要、最多 MAX_COMMIT_MESSAGES 条、「；」分隔、超量收口。 */
function aggregateCommitMessages(commits: GitHubCommit[]): string {
  const messages = commits
    .map((c) => summarize(c.message, COMMENT_MAX_CHARS))
    .filter((m) => m.length > 0);
  if (messages.length === 0) {
    return '（无提交记录）';
  }
  return joinWithCap(messages, MAX_COMMIT_MESSAGES, '次提交');
}

/**
 * 「、」连接 items，超过 cap 只列前 cap 项，其余以「等 N <unit>」显式收口
 * （照 memory「no silent caps」——绝不静默丢数据，剩余量显式标注）。
 */
function joinWithCap(items: string[], cap: number, unit: string): string {
  if (items.length <= cap) {
    return items.join('、');
  }
  const shown = items.slice(0, cap);
  const rest = items.length - cap;
  return `${shown.join('、')} 等 ${rest} ${unit}`;
}

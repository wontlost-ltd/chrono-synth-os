/**
 * GitHub webhook 事件 → 学习意图的纯映射（无 IO、无副作用，便于穷举测试）。
 *
 * 为什么单独成文件：webhook 路由已承担安全链（验签/反查租户/幂等）+ 起草编排，
 * 再塞进事件分类逻辑会让该文件职责过载。映射是纯函数，抽出来既好测也好读。
 *
 * 三种意图：
 *   - learn：即时入队学（讨论类事件——这是低延迟的价值所在）；
 *   - mark-commits：**不入队**，只标记该 repo 的 commits 待扫（push 降频聚合）；
 *   - ignore：不处理（未知事件 / 畸形 payload / ReadPort 不支持的类型）。
 */

import type { GithubWebhookPayload } from '../../server/routes/github-webhook.js';

/** 学习意图（webhook 侧据此决定入队 / 标记 / 忽略）。 */
export type GithubLearnIntent =
  | { kind: 'learn'; resourceType: 'issues' | 'pulls' | 'code'; repo: string; targetNumber?: number }
  | { kind: 'mark-commits'; repo: string }
  | { kind: 'ignore' };

const IGNORE: GithubLearnIntent = { kind: 'ignore' };

/**
 * 把 webhook 事件映射成学习意图。
 *
 * push 单列：活跃组织每天几百次 push，逐次入队会调几百次 LLM 老师烧额度，且
 * 「fix typo」「wip」类 commit 信息密度低、逐条摄入还会稀释记忆信号。commits
 * 资源类型在 mapper 里本就聚合成一条表征（mapCommits），天然适合批量而非逐次。
 *
 * discussion 忽略：GitHub Discussions 只有 GraphQL API，ReadPort 无对应方法，
 * 入队后 handler 无从取内容、必然失败并耗尽重试——诚实忽略优于制造必败任务。
 */
export function mapWebhookEventToLearnIntent(
  eventType: string,
  payload: GithubWebhookPayload,
): GithubLearnIntent {
  const repo = payload.repository?.full_name;
  if (typeof repo !== 'string' || repo.length === 0) return IGNORE;

  /* push 不带 action，单独前置判断。 */
  if (eventType === 'push') return { kind: 'mark-commits', repo };

  switch (eventType) {
    case 'issues':
    case 'issue_comment': {
      const num = payload.issue?.number;
      if (typeof num !== 'number') return IGNORE;
      return { kind: 'learn', resourceType: 'issues', repo, targetNumber: num };
    }
    case 'pull_request':
    case 'pull_request_review_comment':
    case 'pull_request_review': {
      const num = payload.pull_request?.number;
      if (typeof num !== 'number') return IGNORE;
      return { kind: 'learn', resourceType: 'pulls', repo, targetNumber: num };
    }
    case 'release':
      /* release 无具体编号可学，退化为学该 repo 的 code（README/目录树刷新）。 */
      return { kind: 'learn', resourceType: 'code', repo };
    default:
      return IGNORE;
  }
}

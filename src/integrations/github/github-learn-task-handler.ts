/**
 * github-learn 队列 handler —— 消费 webhook 入队的学习任务，真正把内容学进记忆。
 *
 * 为什么走队列而非 webhook 内同步学：perceive 要调 LLM 老师抽事实（单条 1-3 秒），
 * 遇上老师慢会逼近 GitHub 的 ~10 秒 webhook 超时。异步入队后 webhook 50ms 返回 200。
 *
 * **首要安全不变量**：用 `task.tenantId` 装配 ReadPort——绝不可用默认租户，
 * 否则会拿 A 租户的 GitHub 凭据去读、或把 B 的内容学进 A 的记忆。
 *
 * 依赖以函数形式注入（assemble / learn），使 handler 可在无数据库、无网络下单测——
 * 组合根负责把真实实现接上。
 */

import type { TaskRecord } from '../../queue/task-queue.js';
import type { TaskHandler } from '../../queue/task-worker.js';
import type { GitHubReadPort } from './github-read-port.js';
import type { ReadPortAssemblyResult } from './github-readport-factory.js';
import type { GitHubResourceType } from './github-learning-service.js';
import type { Logger } from '../../utils/logger.js';

const LAYER = 'GithubLearnTask';

/** 队列任务类型标识（webhook 入队与 worker 注册须用同一常量）。 */
export const GITHUB_LEARN_TASK_TYPE = 'github-learn';

/**
 * webhook 即时学支持的资源类型。**不含 commits**——push 走降频聚合路径
 * （标记游标交轮转批量学），不由 webhook 逐次入队。
 */
export type WebhookLearnResourceType = 'issues' | 'pulls' | 'code';

/** 任务 payload（webhook 侧入队时写入）。 */
export interface GithubLearnTaskPayload {
  repo: string;
  resourceType: WebhookLearnResourceType;
}

export interface GithubLearnTaskHandlerDeps {
  /** 按租户装配 ReadPort（组合根接 assembleGitHubReadPort）。 */
  assemble: (tenantId: string) => ReadPortAssemblyResult;
  /** 执行学习（组合根接 GitHubLearningService.learn，内含蒸馏/去重/演进式取代全部逻辑）。 */
  learn: (
    tenantId: string,
    readPort: GitHubReadPort,
    repo: string,
    resourceTypes: GitHubResourceType[],
  ) => Promise<void>;
  logger: Logger;
}

/** 解析任务 payload；畸形返回 undefined（调用方静默完成，不重试无意义任务）。 */
function parsePayload(raw: string): GithubLearnTaskPayload | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<GithubLearnTaskPayload>;
    if (typeof parsed.repo !== 'string' || parsed.repo.length === 0) return undefined;
    const rt = parsed.resourceType;
    if (rt !== 'issues' && rt !== 'pulls' && rt !== 'code') return undefined;
    return { repo: parsed.repo, resourceType: rt };
  } catch {
    return undefined;
  }
}

export function createGithubLearnTaskHandler(deps: GithubLearnTaskHandlerDeps): TaskHandler {
  return async (task: TaskRecord): Promise<void> => {
    const payload = parsePayload(task.payload);
    if (!payload) {
      /* 畸形 payload 重试多少次都不会变好——记日志后静默完成。 */
      deps.logger.warn(LAYER, `任务 ${task.id} payload 畸形，跳过`);
      return;
    }

    /* 安全不变量：用任务自带租户装配，绝不用默认租户。 */
    const assembled = deps.assemble(task.tenantId);
    if (!assembled.readPort) {
      /* 租户未连 GitHub（或已断开）——重试无意义，静默完成。 */
      deps.logger.info(LAYER, `租户 ${task.tenantId} 未连 GitHub（${assembled.failure}），跳过学习任务`);
      return;
    }

    await deps.learn(task.tenantId, assembled.readPort, payload.repo, [payload.resourceType]);
  };
}

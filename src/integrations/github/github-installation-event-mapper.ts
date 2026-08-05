/**
 * installation 类 webhook 事件 → 动作的纯映射（无 IO、无副作用，便于穷举测试）。
 *
 * 为什么单独成文件：webhook 路由已承担安全链（验签/反查租户/幂等）+ 起草编排 +
 * 学习入队，再塞进 installation 生命周期分类会让该文件职责过载。
 *
 * **created 刻意映射为 ignore**：映射由 setup 回调建立（唯一权威路径，有会话身份）。
 * 若让 created 事件建映射，会与既有 fail-closed 反查形成循环依赖——事件到达时映射
 * 尚不存在 → 反查 401 拒绝；要放行就得跳过验签，而验签正需要该租户的 webhook secret。
 * 详见 spec §3.3。
 */

/** installation 类事件 payload 的最小关心形状。 */
export interface GithubInstallationEventPayload {
  action?: string;
  /** installation_repositories.added 携带的新增仓库（该事件只带增量，不带完整列表）。 */
  repositories_added?: Array<{ full_name?: string }>;
  /** installation_repositories.removed 携带的移除仓库。 */
  repositories_removed?: Array<{ full_name?: string }>;
}

/** installation 事件对应的存储侧动作。 */
export type InstallationAction =
  | { kind: 'delete' }
  | { kind: 'suspend' }
  | { kind: 'unsuspend' }
  | { kind: 'repos-added'; repos: string[] }
  | { kind: 'repos-removed'; repos: string[] }
  | { kind: 'ignore' };

const IGNORE: InstallationAction = { kind: 'ignore' };

/** 从仓库数组提取合法 full_name（丢弃缺失/空串的畸形条目）。 */
function extractFullNames(list: Array<{ full_name?: string }> | undefined): string[] {
  return (list ?? [])
    .map((r) => r.full_name)
    .filter((name): name is string => typeof name === 'string' && name.length > 0);
}

/** 把 installation 类事件映射成存储侧动作。非该类事件 / 未知 action / 畸形 payload → ignore。 */
export function mapInstallationEvent(
  eventType: string,
  payload: GithubInstallationEventPayload,
): InstallationAction {
  if (eventType === 'installation') {
    switch (payload.action) {
      case 'deleted': return { kind: 'delete' };
      case 'suspend': return { kind: 'suspend' };
      case 'unsuspend': return { kind: 'unsuspend' };
      /* created 由 setup 回调负责建映射——见文件头说明。 */
      default: return IGNORE;
    }
  }

  if (eventType === 'installation_repositories') {
    if (payload.action === 'added') {
      const repos = extractFullNames(payload.repositories_added);
      return repos.length > 0 ? { kind: 'repos-added', repos } : IGNORE;
    }
    if (payload.action === 'removed') {
      const repos = extractFullNames(payload.repositories_removed);
      return repos.length > 0 ? { kind: 'repos-removed', repos } : IGNORE;
    }
    return IGNORE;
  }

  return IGNORE;
}

/**
 * 把增删应用到现有 repos 列（逗号分隔字符串）。纯函数，webhook 侧调用。
 *
 * 为什么需要它：GitHub 的 installation_repositories 事件**只推增量**（added/removed），
 * 不推完整授权列表。要维护 repos 列就得读现有值再应用增量。
 *
 * 去重 + 保持稳定顺序（既有在前、新增在后）；空结果返回 null（列语义：null=未知）。
 */
export function applyRepoDelta(
  existing: string | null,
  action: InstallationAction,
): string | null {
  if (action.kind !== 'repos-added' && action.kind !== 'repos-removed') return existing;
  const current = (existing ?? '').split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  if (action.kind === 'repos-added') {
    const merged = [...current];
    for (const r of action.repos) if (!merged.includes(r)) merged.push(r);
    return merged.length > 0 ? merged.join(',') : null;
  }
  const removed = current.filter((r) => !action.repos.includes(r));
  return removed.length > 0 ? removed.join(',') : null;
}

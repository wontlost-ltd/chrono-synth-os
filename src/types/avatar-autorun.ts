/**
 * Avatar 自动运行与知识源类型定义
 */

/** 知识源类型 */
export type KnowledgeSourceType = 'rss' | 'api' | 'file' | 'manual';

/** 知识源数据库记录 */
export interface KnowledgeSourceRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly type: KnowledgeSourceType;
  readonly name: string;
  readonly enabled: boolean;
  readonly configJson: string;
  readonly stateJson: string | null;
  readonly lastIngestedAt: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Avatar 自动运行配置 */
export interface AvatarAutorunConfig {
  readonly id: string;
  readonly tenantId: string;
  readonly avatarId: string;
  readonly enabled: boolean;
  readonly intervalMs: number;
  readonly nextRunAt: number;
  readonly knowledgeSourceIds: string[];
  readonly driftCheckIntervalMs: number;
  readonly driftThreshold: number;
  readonly reviewRequired: boolean;
  readonly lastRunAt: number | null;
  readonly lastDriftCheckAt: number | null;
  readonly lastError: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** 自动运行日志状态 */
export type AutorunRunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

/** 自动运行日志记录 */
export interface AvatarAutorunRunLog {
  readonly id: string;
  readonly tenantId: string;
  readonly avatarId: string;
  readonly configId: string;
  readonly taskId: string;
  readonly status: AutorunRunStatus;
  readonly metrics: AutorunRunMetrics | null;
  readonly error: string | null;
  readonly startedAt: number | null;
  readonly completedAt: number | null;
  readonly createdAt: number;
}

/** 单次运行指标 */
export interface AutorunRunMetrics {
  readonly memoriesCreated: number;
  readonly patternsFound: number;
  readonly valuesProposed: number;
  readonly driftScore: number;
  readonly knowledgeItemsIngested: number;
  readonly knowledgeItemsSkipped: number;
}

/** 知识源抓取后的单条条目 */
export interface KnowledgeItem {
  readonly sourceId: string;
  readonly title?: string;
  readonly content: string;
  readonly url?: string;
  readonly publishedAt?: number;
  readonly kind?: 'episodic' | 'semantic';
  readonly valence?: number;
  readonly salience?: number;
  readonly fingerprint?: string;
}

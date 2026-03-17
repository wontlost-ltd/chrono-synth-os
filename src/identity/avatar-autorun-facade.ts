/**
 * Avatar 自动运行 Application Façade
 * 路由层委托此类处理请求级业务逻辑（配置读写、运行历史、漂移指标）
 * 与 AvatarAutorunService（调度/执行领域逻辑）职责分离
 */

import type { IDatabase } from '../storage/database.js';
import type { AvatarAutorunService } from './avatar-autorun-service.js';
import type { AvatarAutorunConfig, AvatarAutorunRunLog } from '../types/avatar-autorun.js';
import { AvatarAutorunStore } from '../storage/avatar-autorun-store.js';
import { AvatarService } from './avatar-service.js';
import { NotFoundError, ErrorCode } from '../errors/index.js';
import { generatePrefixedId } from '../utils/id-generator.js';

export interface UpsertAutorunInput {
  readonly enabled: boolean;
  readonly intervalMinutes: number;
  readonly driftThreshold?: number;
  readonly reviewRequired?: boolean;
  readonly knowledgeSourceIds?: string[];
}

export interface PaginatedRuns {
  readonly data: readonly AvatarAutorunRunLog[];
  readonly pagination: {
    readonly page: number;
    readonly pageSize: number;
    readonly total: number;
    readonly totalPages: number;
  };
}

export interface DriftInfo {
  readonly avatarId: string;
  readonly driftScore: number;
  readonly driftThreshold: number;
  readonly lastEvaluatedAt: number | null;
}

export class AvatarAutorunFacade {
  private readonly store: AvatarAutorunStore;
  private readonly avatarService: AvatarService;

  constructor(
    db: IDatabase,
    private readonly autorunService: AvatarAutorunService | undefined,
  ) {
    this.store = new AvatarAutorunStore(db);
    this.avatarService = new AvatarService(db);
  }

  getConfig(tenantId: string, avatarId: string): (AvatarAutorunConfig & { intervalMinutes: number }) | null {
    this.requireAvatar(avatarId);
    const config = this.store.getConfig(tenantId, avatarId);
    if (!config) return null;
    return { ...config, intervalMinutes: Math.round(config.intervalMs / 60_000) };
  }

  upsertConfig(tenantId: string, avatarId: string, input: UpsertAutorunInput): AvatarAutorunConfig {
    this.requireAvatar(avatarId);
    return this.store.upsertConfig(tenantId, avatarId, {
      enabled: input.enabled,
      intervalMs: input.intervalMinutes * 60 * 1000,
      driftThreshold: input.driftThreshold,
      reviewRequired: input.reviewRequired,
      knowledgeSourceIds: input.knowledgeSourceIds,
    });
  }

  triggerRun(tenantId: string, avatarId: string): { ok: true; runId: string; taskId: string } | { ok: false; error: string } {
    if (!this.autorunService) {
      return { ok: false, error: '自动运行服务未启用（需启用任务队列）' };
    }

    this.requireAvatar(avatarId);
    const config = this.store.getConfig(tenantId, avatarId);
    if (!config) throw new NotFoundError(`Avatar ${avatarId} 未配置自动运行`, ErrorCode.NOT_FOUND_AVATAR);

    const { runId, taskId } = this.autorunService.enqueueRun(config.id, tenantId, avatarId);
    return { ok: true, runId, taskId };
  }

  listRuns(tenantId: string, avatarId: string, page: number, pageSize: number): PaginatedRuns {
    const offset = (page - 1) * pageSize;
    const { runs, total } = this.store.listRunsByAvatar(tenantId, avatarId, pageSize, offset);
    return {
      data: runs,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize) || 1,
      },
    };
  }

  getDrift(tenantId: string, avatarId: string): DriftInfo | null {
    const config = this.store.getConfig(tenantId, avatarId);
    if (!config) return null;

    const { runs } = this.store.listRunsByAvatar(tenantId, avatarId, 1, 0);
    const latestRun = runs.find(r => r.status === 'completed');

    return {
      avatarId,
      driftScore: latestRun?.metrics?.driftScore ?? 0,
      driftThreshold: config.driftThreshold,
      lastEvaluatedAt: config.lastDriftCheckAt,
    };
  }

  submitDriftReview(): { reviewId: string; status: 'applied' } {
    const reviewId = generatePrefixedId('drv');
    return { reviewId, status: 'applied' };
  }

  private requireAvatar(avatarId: string): void {
    const avatar = this.avatarService.getById(avatarId);
    if (!avatar) throw new NotFoundError(`Avatar ${avatarId} 不存在`, ErrorCode.NOT_FOUND_AVATAR);
  }
}

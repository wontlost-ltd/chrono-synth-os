/**
 * 租户 OS 实例工厂
 * 使用 LRU 缓存为每个租户维护独立的 ChronoSynthOS 实例
 */

import { ChronoSynthOS } from '../chrono-synth-os.js';
import type { IDatabase } from '../storage/database.js';
import type { Clock } from '../utils/clock.js';
import type { Logger } from '../utils/logger.js';
import { TenantDatabase } from './tenant-database.js';
import { normalizeTenantId } from './tenant-context.js';

export interface TenantOSFactoryConfig {
  /** LRU 缓存容量（默认 64） */
  maxCachedTenants?: number;
}

/** LRU 缓存条目 */
interface CacheEntry {
  os: ChronoSynthOS;
  lastAccessedAt: number;
}

export class TenantOSFactory {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly maxCached: number;

  constructor(
    private readonly db: IDatabase,
    private readonly clock: Clock,
    private readonly logger: Logger,
    config?: TenantOSFactoryConfig,
  ) {
    this.maxCached = config?.maxCachedTenants ?? 64;
  }

  /** 获取或创建租户 OS 实例 */
  getTenantOS(tenantId: string): ChronoSynthOS {
    const normalized = normalizeTenantId(tenantId);
    const existing = this.cache.get(normalized);
    if (existing) {
      existing.lastAccessedAt = this.clock.now();
      return existing.os;
    }

    const os = this.createTenantOS(normalized);
    this.cache.set(normalized, { os, lastAccessedAt: this.clock.now() });

    /* LRU 驱逐 */
    if (this.cache.size > this.maxCached) {
      this.evictLRU();
    }

    return os;
  }

  /** 当前缓存的租户数量 */
  get cachedCount(): number {
    return this.cache.size;
  }

  /** 驱逐指定租户的缓存实例 */
  evict(tenantId: string): void {
    const normalized = normalizeTenantId(tenantId);
    const entry = this.cache.get(normalized);
    if (entry) {
      entry.os.close();
      this.cache.delete(normalized);
      this.logger.info('TenantOSFactory', `租户 OS 实例已驱逐: ${normalized}`);
    }
  }

  /** 清理所有缓存的租户实例 */
  clear(): void {
    for (const entry of this.cache.values()) {
      entry.os.close();
    }
    this.cache.clear();
  }

  private createTenantOS(tenantId: string): ChronoSynthOS {
    const tenantDb = new TenantDatabase(this.db, tenantId);
    const os = new ChronoSynthOS({
      db: tenantDb,
      clock: this.clock,
      logger: this.logger,
      skipMigrations: true,  /* 迁移由宿主数据库统一管理 */
    });
    os.start();
    this.logger.info('TenantOSFactory', `租户 OS 实例已创建: ${tenantId}`);
    return os;
  }

  private evictLRU(): void {
    let oldestKey: string | undefined;
    let oldestTime = Infinity;
    for (const [key, entry] of this.cache) {
      if (entry.lastAccessedAt < oldestTime) {
        oldestTime = entry.lastAccessedAt;
        oldestKey = key;
      }
    }
    if (oldestKey) {
      const entry = this.cache.get(oldestKey);
      entry?.os.close();
      this.cache.delete(oldestKey);
      this.logger.info('TenantOSFactory', `租户 OS 实例已驱逐: ${oldestKey}`);
    }
  }
}

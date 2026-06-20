/**
 * 租户 OS 实例工厂
 * 使用 LRU 缓存为每个租户维护独立的 ChronoSynthOS 实例
 */

import { ChronoSynthOS } from '../chrono-synth-os.js';
import type { IDatabase } from '../storage/database.js';
import type { EncryptionConfig } from '../storage/encryption.js';
import type { Clock } from '../utils/clock.js';
import type { Logger } from '../utils/logger.js';
import { TenantDatabase } from './tenant-database.js';
import { normalizeTenantId } from './tenant-context.js';
import type { ProactiveGateConfig } from '@chrono/kernel';

export interface TenantOSFactoryConfig {
  /** LRU 缓存容量（默认 64） */
  maxCachedTenants?: number;
  /**
   * 性格出生扰动幅度（②③ 出生机制接线）。每个租户按 tenantId 派生确定性 seed，对 6 维决策风格
   * 加 ±magnitude 有界扰动，让不同租户的人格出生即略有不同（性格分布从一个点变成一团）。
   * 0 = 关闭扰动（出生同质，旧行为）。默认 0.15（[0,1] 维约 ±0.15，有界且温和）。
   * 仅影响**全新** persona——已写过 decision style row 的租户（已设置/演化/恢复）不受影响。
   */
  personalityBirthMagnitude?: number;
  /**
   * 主动性门控配置（ADR-0054，生产可达关闭入口/红线 3）。透传给每个租户 OS——`{ enabled: false }`
   * 关闭该部署所有租户的主动消息。缺省 → 各租户用 DEFAULT_PROACTIVE_GATE_CONFIG（保守）。
   */
  proactivity?: Partial<ProactiveGateConfig>;
  /** 动态成长预算（ADR-0048）：透传给每个租户 OS。默认开（婴儿激进/成熟保守）；false 回退静态。 */
  dynamicGrowthBudgetEnabled?: boolean;
}

/** 默认出生扰动幅度——温和有界，让租户人格出生即有可度量差异（diversityScore>0）。 */
const DEFAULT_PERSONALITY_BIRTH_MAGNITUDE = 0.15;

/** LRU 缓存条目 */
interface CacheEntry {
  os: ChronoSynthOS;
  lastAccessedAt: number;
}

export class TenantOSFactory {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly maxCached: number;

  private readonly encryptionConfig?: EncryptionConfig;
  private readonly personalityBirthMagnitude: number;
  private readonly proactivity?: Partial<ProactiveGateConfig>;
  private readonly dynamicGrowthBudgetEnabled?: boolean;

  constructor(
    private readonly db: IDatabase,
    private readonly clock: Clock,
    private readonly logger: Logger,
    config?: TenantOSFactoryConfig,
    encryptionConfig?: EncryptionConfig,
  ) {
    this.maxCached = config?.maxCachedTenants ?? 64;
    this.encryptionConfig = encryptionConfig;
    this.personalityBirthMagnitude = config?.personalityBirthMagnitude ?? DEFAULT_PERSONALITY_BIRTH_MAGNITUDE;
    this.proactivity = config?.proactivity;
    this.dynamicGrowthBudgetEnabled = config?.dynamicGrowthBudgetEnabled;
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
      encryptionConfig: this.encryptionConfig,
      skipMigrations: true,  /* 迁移由宿主数据库统一管理 */
      tenantId,
      /* ②③ 出生机制接线：按已规范化的 tenantId 派生确定性 seed（同租户恒同扰动、可复现），
       * 让不同租户的人格出生即略有不同。exists() 守卫保证仅作用于全新 persona，现有租户不漂移。
       * tenantId 此处已由 getTenantOS 规范化，直接作 seed。 */
      personalitySeed: { seed: tenantId, magnitude: this.personalityBirthMagnitude },
      /* ADR-0054 主动性配置透传（生产可达关闭/红线 3）；缺省 → 租户 OS 用默认保守配置。 */
      ...(this.proactivity ? { proactivity: this.proactivity } : {}),
      /* ADR-0048 动态成长预算透传（缺省 → ChronoSynthOS 默认开）。 */
      ...(this.dynamicGrowthBudgetEnabled !== undefined ? { dynamicGrowthBudgetEnabled: this.dynamicGrowthBudgetEnabled } : {}),
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

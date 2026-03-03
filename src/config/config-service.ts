/**
 * 配置服务
 * 提供配置的读写接口，整合元数据分类、Zod 校验和 Redis 热重载通知
 */

import type { IDatabase } from '../storage/database.js';
import type { AppConfig } from './schema.js';
import { AppConfigSchema } from './schema.js';
import { ConfigStore, type ConfigItemRow, type ConfigAuditRow } from './config-store.js';
import { resolveConfigMetadata, SECRET_MASK, type ConfigCategory } from './config-metadata.js';

export interface ConfigItemView {
  readonly key: string;
  readonly value: unknown;
  readonly category: ConfigCategory;
  readonly requiresRestart: boolean;
  readonly groupKey: string;
  readonly updatedAt: number;
  readonly updatedBy: string;
}

export interface ApplyPatchResult {
  readonly updated: number;
  readonly requiresRestart: string[];
}

export class ConfigService {
  private readonly store: ConfigStore;

  constructor(
    db: IDatabase,
    private readonly currentConfig: AppConfig,
    private readonly redis?: { publish(channel: string, message: string): Promise<void> },
  ) {
    this.store = new ConfigStore(db);
  }

  /** 获取配置项列表（按调用者角色过滤） */
  getConfigItems(callerRole: string): ConfigItemView[] {
    const rows = this.store.getAll();
    return rows
      .filter(r => this.isVisible(r.category, callerRole))
      .map(r => this.toView(r, callerRole));
  }

  /**
   * 获取有效配置（仅用于 Admin UI 展示）
   * DB 值覆盖运行时配置以显示"期望状态"，实际运行时仍由 loadConfig() 控制
   * requiresRestart 的配置项修改后需重启才真正生效
   */
  getEffectiveConfig(callerRole: string): Record<string, unknown> {
    const flatCurrent = flattenObject(this.currentConfig as unknown as Record<string, unknown>);
    const dbItems = this.store.getAll();

    for (const item of dbItems) {
      try {
        flatCurrent[item.key] = JSON.parse(item.value_json);
      } catch { /* 无效 JSON，保留运行时值 */ }
    }

    /* 按角色过滤与脱敏 */
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(flatCurrent)) {
      const meta = resolveConfigMetadata(key);
      if (!this.isVisible(meta.category, callerRole)) continue;
      result[key] = meta.category === 'secret' ? SECRET_MASK : value;
    }
    return result;
  }

  /** 批量应用配置变更 */
  async applyPatch(patch: Record<string, unknown>, changedBy: string): Promise<ApplyPatchResult> {
    /* 校验所有 key 的合法性 */
    const allowedKeys = new Set(Object.keys(
      flattenObject(this.currentConfig as unknown as Record<string, unknown>),
    ));
    for (const key of Object.keys(patch)) {
      if (!allowedKeys.has(key)) {
        throw new Error(`未知配置项: "${key}"`);
      }
      const meta = resolveConfigMetadata(key);
      if (meta.category === 'secret') {
        throw new Error(`配置项 "${key}" 为 secret 类，不允许通过 API 修改`);
      }
    }

    /* 用 Zod 对合并后的值做部分校验 */
    const currentFlat = flattenObject(this.currentConfig as unknown as Record<string, unknown>);
    const merged = { ...currentFlat, ...patch };
    const nested = unflattenObject(merged);
    AppConfigSchema.parse(nested);

    const requiresRestart = this.store.applyPatch(patch, changedBy);

    /* 通知 Redis 热重载（非 requiresRestart 的配置可立即生效） */
    if (this.redis) {
      try {
        await this.redis.publish('chrono:config:reload', JSON.stringify({
          keys: Object.keys(patch),
          changedBy,
          changedAt: Date.now(),
        }));
      } catch { /* Redis 不可用不阻断写入 */ }
    }

    return { updated: Object.keys(patch).length, requiresRestart };
  }

  /** 查询审计日志 */
  getAudit(limit = 50, offset = 0): ConfigAuditRow[] {
    return this.store.getAudit(limit, offset);
  }

  /** 按角色判定可见性 */
  private isVisible(category: ConfigCategory, role: string): boolean {
    if (role === 'admin') return category !== 'secret';
    if (role === 'member') return category === 'public' || category === 'protected';
    return category === 'public';
  }

  /** 数据库行转视图对象 */
  private toView(row: ConfigItemRow, callerRole: string): ConfigItemView {
    const meta = resolveConfigMetadata(row.key);
    let value: unknown;
    try { value = JSON.parse(row.value_json); } catch { value = row.value_json; }
    if (meta.category === 'secret' && callerRole !== 'superadmin') {
      value = SECRET_MASK;
    }
    return {
      key: row.key,
      value,
      category: row.category as ConfigCategory,
      requiresRestart: row.requires_restart !== 0,
      groupKey: row.group_key,
      updatedAt: row.updated_at,
      updatedBy: row.updated_by,
    };
  }
}

/** 将嵌套对象扁平化为 dot-separated key */
function flattenObject(obj: Record<string, unknown>, prefix = ''): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(result, flattenObject(value as Record<string, unknown>, fullKey));
    } else {
      result[fullKey] = value;
    }
  }
  return result;
}

/** 将扁平 key 恢复为嵌套对象 */
function unflattenObject(flat: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(flat)) {
    const parts = key.split('.');
    let current = result;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!(parts[i] in current) || typeof current[parts[i]] !== 'object') {
        current[parts[i]] = {};
      }
      current = current[parts[i]] as Record<string, unknown>;
    }
    current[parts[parts.length - 1]] = value;
  }
  return result;
}

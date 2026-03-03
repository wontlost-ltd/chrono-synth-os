/**
 * 配置存储层
 * 管理 config_items 表的 CRUD 与审计日志
 */

import type { IDatabase } from '../storage/database.js';
import { resolveConfigMetadata, type ConfigCategory } from './config-metadata.js';

export interface ConfigItemRow {
  readonly key: string;
  readonly value_json: string;
  readonly category: ConfigCategory;
  readonly requires_restart: number;
  readonly group_key: string;
  readonly updated_at: number;
  readonly updated_by: string;
}

export interface ConfigAuditRow {
  readonly id: number;
  readonly config_key: string;
  readonly old_value: string | null;
  readonly new_value: string | null;
  readonly changed_by: string;
  readonly changed_at: number;
}

export class ConfigStore {
  constructor(private readonly db: IDatabase) {}

  /** 获取所有配置项（按 key 排序） */
  getAll(): ConfigItemRow[] {
    return this.db.prepare<ConfigItemRow>(
      'SELECT * FROM config_items ORDER BY key',
    ).all();
  }

  /** 获取指定分类的配置项 */
  getByCategory(category: ConfigCategory): ConfigItemRow[] {
    return this.db.prepare<ConfigItemRow>(
      'SELECT * FROM config_items WHERE category = ? ORDER BY key',
    ).all(category);
  }

  /** 获取单个配置项 */
  get(key: string): ConfigItemRow | undefined {
    return this.db.prepare<ConfigItemRow>(
      'SELECT * FROM config_items WHERE key = ?',
    ).get(key);
  }

  /** 批量应用配置变更（原子性事务，包含审计日志） */
  applyPatch(patch: Record<string, unknown>, changedBy: string): string[] {
    const now = Date.now();
    const requiresRestart: string[] = [];

    this.db.transaction(() => {
      for (const [key, value] of Object.entries(patch)) {
        const meta = resolveConfigMetadata(key);
        const valueJson = JSON.stringify(value);
        const existing = this.get(key);

        /* 审计日志 */
        this.db.prepare<void>(
          'INSERT INTO config_audit (config_key, old_value, new_value, changed_by, changed_at) VALUES (?, ?, ?, ?, ?)',
        ).run(key, existing?.value_json ?? null, valueJson, changedBy, now);

        /* 写入或更新配置项 */
        this.db.prepare<void>(
          `INSERT INTO config_items (key, value_json, category, requires_restart, group_key, updated_at, updated_by)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at, updated_by=excluded.updated_by`,
        ).run(key, valueJson, meta.category, meta.requiresRestart ? 1 : 0, meta.groupKey, now, changedBy);

        if (meta.requiresRestart) {
          requiresRestart.push(key);
        }
      }
    });

    return requiresRestart;
  }

  /** 查询审计日志 */
  getAudit(limit = 50, offset = 0): ConfigAuditRow[] {
    return this.db.prepare<ConfigAuditRow>(
      'SELECT * FROM config_audit ORDER BY changed_at DESC LIMIT ? OFFSET ?',
    ).all(limit, offset);
  }

  /** 按 key 查询审计日志 */
  getAuditByKey(key: string, limit = 50): ConfigAuditRow[] {
    return this.db.prepare<ConfigAuditRow>(
      'SELECT * FROM config_audit WHERE config_key = ? ORDER BY changed_at DESC LIMIT ?',
    ).all(key, limit);
  }
}

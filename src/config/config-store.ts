/**
 * 配置存储层
 * 管理 config_items 表的 CRUD 与审计日志
 */

import type { IDatabase } from '../storage/database.js';
import type { SyncWriteUnitOfWork } from '@chrono/kernel';
import type { ConfigItemRow, ConfigAuditRow } from '@chrono/kernel';
import {
  cfgQueryAll, cfgQueryByCategory, cfgQueryByKey,
  cfgQueryAudit, cfgQueryAuditByKey,
  cfgCmdUpsert, cfgCmdAuditLog,
} from '@chrono/kernel';
import { resolveConfigMetadata, type ConfigCategory } from './config-metadata.js';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';

export type { ConfigItemRow, ConfigAuditRow };

export class ConfigStore {
  private readonly db: IDatabase;
  private readonly tx: SyncWriteUnitOfWork;

  constructor(db: IDatabase) {
    this.db = db;
    registerCoreSelfExecutors();
    this.tx = db;
  }

  /** 获取所有配置项（按 key 排序） */
  getAll(): ConfigItemRow[] {
    return [...this.tx.queryMany(cfgQueryAll())];
  }

  /** 获取指定分类的配置项 */
  getByCategory(category: ConfigCategory): ConfigItemRow[] {
    return [...this.tx.queryMany(cfgQueryByCategory(category))];
  }

  /** 获取单个配置项 */
  get(key: string): ConfigItemRow | undefined {
    return this.tx.queryOne(cfgQueryByKey(key)) ?? undefined;
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
        this.tx.execute(cfgCmdAuditLog({
          configKey: key,
          oldValue: existing?.value_json ?? null,
          newValue: valueJson,
          changedBy,
          now,
        }));

        /* 写入或更新配置项 */
        this.tx.execute(cfgCmdUpsert({
          key,
          valueJson,
          category: meta.category,
          requiresRestart: meta.requiresRestart ? 1 : 0,
          groupKey: meta.groupKey,
          now,
          changedBy,
        }));

        if (meta.requiresRestart) {
          requiresRestart.push(key);
        }
      }
    });

    return requiresRestart;
  }

  /** 查询审计日志 */
  getAudit(limit = 50, offset = 0): ConfigAuditRow[] {
    return [...this.tx.queryMany(cfgQueryAudit(limit, offset))];
  }

  /** 按 key 查询审计日志 */
  getAuditByKey(key: string, limit = 50): ConfigAuditRow[] {
    return [...this.tx.queryMany(cfgQueryAuditByKey(key, limit))];
  }
}

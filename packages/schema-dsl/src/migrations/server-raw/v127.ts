import { defineRaw, rawSql } from '../../dsl/raw.js';
import type { RawMigration } from '../../types.js';

/**
 * GitHub 安装入口产品化地基——给 github_installations 加暂停状态列。
 *
 * 为什么要这列：GitHub 允许把已安装的 App **暂停**（suspend）而不卸载。暂停期间
 * installation token 换取会失败。表里没有该状态，系统就不知道 App 已被暂停——
 * 组织同步 worker 会持续对暂停的装机发请求拿 403，白烧配额还刷错误日志。
 *
 * suspended_at 可空：NULL = 未暂停（既有行天然兼容），非 NULL = 暂停时刻（毫秒 epoch）。
 * 由 installation.suspend / unsuspend webhook 事件维护。
 *
 * 手法：纯加列，**不重建表**——故不触发 SQLite 重建表时「RENAME 占用索引名致
 * CREATE INDEX IF NOT EXISTS 静默 no-op、DROP _old 连带删掉唯一索引」的已知坑
 * （参 v122/v126 注释）。既有 UNIQUE(github_host, installation_id) 索引原地保留。
 *
 * 时间戳列：Postgres BIGINT（毫秒 epoch），SQLite 无 BIGINT 用 INTEGER（同为 64 位整数语义）。
 *
 * 向后兼容：新列可空，既有写路径（upsertInstallation 不传该列）仍合法。
 * 回滚：PG DROP COLUMN；SQLite 需重建表去列（或保留冗余空列，无害）。
 *
 * Alias：SQLite v127 / Postgres v129（紧跟 v126 github-learn-state-org-rotation / Postgres v128）。
 */
export const v127_github_installation_suspended: RawMigration = defineRaw({
  id: 'github-installation-suspended',
  version: 'v127',
  aliases: { postgres: 'v129', 'sqlite-sql': 'v127' },
  description: 'GitHub install entrypoint: github_installations adds suspended_at',
  reason: '安装入口产品化：GitHub 允许暂停已安装 App（暂停期 token 换取失败），表无该状态则同步 worker 持续对暂停装机发请求拿 403；加 suspended_at（可空，NULL=未暂停）由 installation.suspend/unsuspend webhook 事件维护；纯加列不重建表',
  postgres: rawSql([
    `ALTER TABLE github_installations ADD COLUMN IF NOT EXISTS suspended_at BIGINT`,
  ]),
  sqlite: rawSql([
    /* SQLite 无 ADD COLUMN IF NOT EXISTS；版本号全新不会重复执行，直接加列。 */
    `ALTER TABLE github_installations ADD COLUMN suspended_at INTEGER`,
  ]),
});

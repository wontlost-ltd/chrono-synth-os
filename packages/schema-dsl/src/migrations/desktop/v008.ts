import { defineRaw, rawSql } from '../../dsl/raw.js';

/**
 * v008 — desktop 本地 snapshots 表（ADR-0046 路线 A）。
 *
 * 镜像服务端 snapshots 的子集（id/data_json/reason/created_at），加 tenant_id 以与服务端
 * PersonaDriftAnalyzer 的查询语义一致（`WHERE tenant_id = ? OR (tenant_id IS NULL AND ? = 'default')`）。
 * desktop 同步引擎把服务端 GET /api/v1/snapshots 落到这里，desktop 即可**本地**用共享纯函数
 * computeDriftFromSnapshots 算 drift（真离线），不再只依赖在线取 /companion/me/growth（路线 B）。
 *
 * created_at 用 INTEGER 毫秒（与服务端 analyzer 的 ORDER BY created_at DESC 取最近两条一致）。
 */
export const desktop_v008: ReturnType<typeof defineRaw> = defineRaw({
  id: 'desktop-snapshots',
  version: 'v008',
  aliases: { 'sqlite-rust': 'v008' },
  description: 'snapshots — 本地快照镜像（路线 A 本地算 drift 的数据源）',
  target: 'desktop-only',
  reason: 'Desktop migration is kept byte-stable against the Rust execute_batch SQL',
  sqliteRust: rawSql([
    `
        CREATE TABLE IF NOT EXISTS snapshots (
            id         TEXT PRIMARY KEY,
            data_json  TEXT NOT NULL,
            reason     TEXT NOT NULL DEFAULT '',
            tenant_id  TEXT,
            created_at INTEGER NOT NULL,
            synced_at  INTEGER NOT NULL DEFAULT 0
        );

        CREATE INDEX IF NOT EXISTS idx_snapshots_tenant_created
            ON snapshots (tenant_id, created_at DESC);
        `,
  ]),
});

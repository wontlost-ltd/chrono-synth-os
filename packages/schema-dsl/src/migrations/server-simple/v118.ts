import { defineMigration, type Migration } from '../../index.js';

/**
 * 安全修复 — life_simulations 补 owner_user_id 列（模拟归属权判定）。
 *
 * 背景（Codex 交叉审查发现的既有安全洞）：life_simulations 表原本只有 tenant_id，没有任何「谁创建/拥有
 * 这个模拟」的字段。协作分享的所谓 owner 全靠「第一个分享者把自己写进 shared_simulations.owner_user_id」
 * 自封——导致同租户任意用户可给别人的模拟抢注分享、把自己变 owner，且「列某模拟分享给了谁」无从做真正的
 * owner-only 鉴权。
 *
 * 修复：给 life_simulations 加 owner_user_id（创建模拟的用户）。创建路径写入真实创建者，分享/取消/列举
 * 分享一律按此列做 owner-only 校验。
 *
 * 字段决策：
 *   - owner_user_id 可空（sqlite ADD COLUMN NOT NULL 无 default + 历史行无从回填 → 留 NULL）；
 *     历史模拟 owner 未知 → 分享鉴权对其保守失败（无 owner 可证 → 非创建者一律拒绝，见 collaboration-service）。
 *   - 新模拟由创建路由强制写入 request.user.sub，owner 真实可追溯。
 *
 * Alias：SQLite v118 / Postgres v120（紧跟 v117 tool-authorization-requests / Postgres v119）。
 */
export const v118_life_simulation_owner: Migration = defineMigration({
  kind: 'schema',
  id: '118-life-simulation-owner',
  aliases: { postgres: 'v120', 'sqlite-sql': 'v118' },
  description: '安全: life_simulations 补 owner_user_id 列（模拟归属权，owner-only 分享鉴权基础）',
  operations: [
    {
      kind: 'add-column',
      table: 'life_simulations',
      ifNotExists: true,
      safeIfTableExists: true,
      column: { name: 'owner_user_id', type: 'text' },
    },
  ],
});

import { defineMigration, type Migration } from '../../index.js';

/**
 * 数字员工组织 M2：playbook 版本审计——给 org_goals 加 playbook_version（产生该目标的规则包版本）。
 *
 * M2 把分解规则做成 versioned rule pack。为可审计/可复盘，每个目标落库**当时用的 playbook 版本号**，
 * 这样规则演进（M3 蒸馏出新版本）后仍能追溯「这个目标是哪版规则拆的」。确定性、零-LLM。
 *
 * playbook_version 默认 1（既有目标 = 参考版本 v1）；新目标由 runGoal 写入当时激活版本。
 * Alias：SQLite v105 / Postgres v107（紧跟 v104 due_at / pg v106）。
 */
export const v105_org_goals_playbook_version: Migration = defineMigration({
  kind: 'schema',
  id: '105-org-goals-playbook-version',
  aliases: { postgres: 'v107', 'sqlite-sql': 'v105' },
  description: 'Digital workforce M2: org_goals.playbook_version (audit which rule-pack version produced the goal)',
  operations: [
    { kind: 'add-column', table: 'org_goals', ifNotExists: true, safeIfTableExists: true, column: { name: 'playbook_version', type: 'integer', nullable: false, default: 1 } },
  ],
});

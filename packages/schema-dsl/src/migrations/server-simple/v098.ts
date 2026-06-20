import { defineMigration, type Migration } from '../../index.js';

/**
 * 数字员工组织 A0：Playbook 契约 + Rubric——给 org_tasks 加稳定契约字段。
 *
 * M1 的 TaskSpec 只有 {assigneeRoleCode, title, taskType}（临时三字段）。A0 把它升级成**稳定契约**并
 * 持久化，让后续切片（B 协作 / D 真实执行 / E API+UI）有稳定字段可引用，不必各自发明临时 payload：
 *   - risk_level：low/medium/high——D 据此决定走不走人类审批门。
 *   - allows_tool_execution：是否允许走真实工具（0/1）——D 据此决定走 ToolInvocationPipeline 还是 stub。
 *   - acceptance_criteria：验收标准——E 展示 / D 判定完成。
 *   - required_capabilities：所需能力标签（JSON 数组字符串）——B/D 匹配。
 *
 * 仍零-LLM（契约由确定性 playbook 产出）。加 nullable 列兼容既有行；新行总会写入。
 * Alias：SQLite v098 / Postgres v100（紧跟 v097 digital_workforce / Postgres v099）。
 */
export const v098_workforce_task_contract: Migration = defineMigration({
  kind: 'schema',
  id: '098-workforce-task-contract',
  aliases: { postgres: 'v100', 'sqlite-sql': 'v098' },
  description: 'Digital workforce A0: org_tasks contract fields (risk/tool-eligible/acceptance/capabilities)',
  operations: [
    { kind: 'add-column', table: 'org_tasks', ifNotExists: true, safeIfTableExists: true, column: { name: 'risk_level', type: 'text', nullable: false, default: 'low' } },
    { kind: 'add-column', table: 'org_tasks', ifNotExists: true, safeIfTableExists: true, column: { name: 'allows_tool_execution', type: 'integer', nullable: false, default: 0 } },
    { kind: 'add-column', table: 'org_tasks', ifNotExists: true, safeIfTableExists: true, column: { name: 'acceptance_criteria', type: 'text', nullable: false, default: '' } },
    /* 所需能力标签：JSON 数组字符串（如 ["research"]）；默认空数组。 */
    { kind: 'add-column', table: 'org_tasks', ifNotExists: true, safeIfTableExists: true, column: { name: 'required_capabilities', type: 'text', nullable: false, default: '[]' } },
  ],
});

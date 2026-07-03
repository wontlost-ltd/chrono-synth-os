/**
 * 工具动作规则存储（ADR-0060 T1）——tool_action_rules 表的轻量读写适配器。
 *
 * 直接走 IDatabase.prepare（与 companion-*-store 同款轻量），含 tenant_id → TenantDatabase 自动隔离。
 * T1 只需**运行时按 (tenant, persona, tool, capability) 取候选规则集**供 ToolActionCompiler + kernel
 * 纯函数消费；规则的**写入**（学习/编译期产出）在 T2/T3（本 store 仅提供最小 insert 供测试/后续用）。
 *
 * ⚠️ bigint 列（compiled_at/expires_at）：SQLite 返回 number，Postgres node-pg 返回 string——统一 Number()
 * 强转 + null 守卫（PG bigint string coercion 陷阱，见既有 store 同纪律）。
 */

import type { IDatabase } from './database.js';
import type { ToolActionRule, ToolArgMapping } from '@chrono/kernel';

interface ToolActionRuleRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly persona_id: string;
  readonly tool_id: string;
  readonly capability: string;
  readonly schema_version: string;
  readonly rule_version: string;
  readonly content_hash: string;
  readonly arg_mappings: string;
  readonly created_by: string;
  readonly compiled_at: number | string;
  readonly expires_at: number | string | null;
  readonly active: number;
}

export interface InsertToolActionRuleInput {
  readonly id: string;
  readonly personaId: string;
  readonly toolId: string;
  readonly capability: string;
  readonly schemaVersion: string;
  readonly ruleVersion: string;
  readonly contentHash: string;
  readonly argMappings: Readonly<Record<string, ToolArgMapping>>;
  readonly createdBy: string;
  readonly compiledAt: number;
  readonly expiresAt: number | null;
  readonly active: boolean;
}

export class ToolActionRuleStore {
  constructor(
    private readonly db: IDatabase,
    private readonly tenantId: string = 'default',
  ) {}

  /** 运行时取候选规则集（按 tenant+persona+tool+capability；active 与 schemaVersion/过期由 kernel 纯函数判定）。 */
  listCandidates(personaId: string, toolId: string, capability: string): ToolActionRule[] {
    const rows = this.db.prepare<ToolActionRuleRow>(
      `SELECT * FROM tool_action_rules
       WHERE tenant_id = ? AND persona_id = ? AND tool_id = ? AND capability = ?`,
    ).all(this.tenantId, personaId, toolId, capability);
    return rows.map((r) => this.toRule(r));
  }

  /** 最小 insert（T2/T3 学习通道落规则前的占位写入；测试/后续用）。 */
  insert(input: InsertToolActionRuleInput): void {
    this.db.prepare<void>(
      `INSERT INTO tool_action_rules
        (id, tenant_id, persona_id, tool_id, capability, schema_version, rule_version, content_hash,
         arg_mappings, created_by, compiled_at, expires_at, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.id, this.tenantId, input.personaId, input.toolId, input.capability, input.schemaVersion,
      input.ruleVersion, input.contentHash, JSON.stringify(input.argMappings), input.createdBy,
      input.compiledAt, input.expiresAt, input.active ? 1 : 0,
    );
  }

  private toRule(r: ToolActionRuleRow): ToolActionRule {
    return {
      tenantId: r.tenant_id,
      personaId: r.persona_id,
      toolId: r.tool_id,
      capability: r.capability,
      schemaVersion: r.schema_version,
      ruleVersion: r.rule_version,
      contentHash: r.content_hash,
      createdBy: r.created_by,
      compiledAt: Number(r.compiled_at),
      expiresAt: r.expires_at === null ? null : Number(r.expires_at),
      active: r.active === 1,
      argMappings: safeParseMappings(r.arg_mappings),
    };
  }
}

/** 安全解析 argMappings JSON；畸形持久化数据回退空映射（读路径不崩，运行时会因缺映射 fail-closed）。 */
function safeParseMappings(text: string): Readonly<Record<string, ToolArgMapping>> {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, ToolArgMapping>;
    }
  } catch { /* 畸形 → 空 */ }
  return {};
}

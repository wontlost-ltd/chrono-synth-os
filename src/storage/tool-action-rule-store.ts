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
  readonly source_artifact_id: string | null;
  readonly exam_spec_version: string | null;
  readonly risk_class: string | null;
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
  /** 来源蒸馏产物 id（红线 6 provenance；门控学习通道落表时强制非空，来源可审计）。 */
  readonly sourceArtifactId: string;
  /** 放行该规则的工具考试标识（examId::scorerVersion，红线 11 eligibility 陈旧失效溯源；service 强制非空）。 */
  readonly examSpecVersion: string;
  /** 学习期评定风险类（'high'|'low'，红线 11 溯源；红线 13：非授权依据；service 强制非空）。 */
  readonly riskClass: string;
}

/** 规则的 eligibility 溯源（红线 11）：T4 projector 从活跃规则读，产出建议的 examSpecVersion/riskClass/ruleVersion。 */
export interface RuleEligibilityProvenance {
  readonly toolId: string;
  readonly schemaVersion: string;
  readonly ruleVersion: string;
  /** 规则内容哈希（防「同 ruleVersion 内容被替换」治理事故，纳入 constraintsHash 陈旧指纹，Codex T4 复审补）。 */
  readonly contentHash: string;
  readonly examSpecVersion: string;
  readonly riskClass: 'high' | 'low';
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

  /**
   * 落规则入表（T3 学习通道过考后写入）。存储层强制 provenance 非空（红线 6 fail-closed 兜底）：即便有人
   * 绕过 ToolRuleLearningService 门控直接调本方法，也拒绝无来源规则落表——TS required string 不挡运行时空串。
   */
  insert(input: InsertToolActionRuleInput): void {
    if (typeof input.sourceArtifactId !== 'string' || input.sourceArtifactId.length === 0) {
      throw new Error('tool_action_rules.source_artifact_id 不得为空（红线 6：规则来源必须可追溯，禁直灌）');
    }
    if (typeof input.examSpecVersion !== 'string' || input.examSpecVersion.length === 0) {
      throw new Error('tool_action_rules.exam_spec_version 不得为空（红线 11：eligibility 陈旧失效需考试溯源）');
    }
    if (input.riskClass !== 'high' && input.riskClass !== 'low') {
      throw new Error(`tool_action_rules.risk_class 必须为 'high'|'low'（红线 11 溯源），得到「${String(input.riskClass)}」`);
    }
    this.db.prepare<void>(
      `INSERT INTO tool_action_rules
        (id, tenant_id, persona_id, tool_id, capability, schema_version, rule_version, content_hash,
         arg_mappings, created_by, compiled_at, expires_at, active, source_artifact_id, exam_spec_version, risk_class)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.id, this.tenantId, input.personaId, input.toolId, input.capability, input.schemaVersion,
      input.ruleVersion, input.contentHash, JSON.stringify(input.argMappings), input.createdBy,
      input.compiledAt, input.expiresAt, input.active ? 1 : 0, input.sourceArtifactId,
      input.examSpecVersion, input.riskClass,
    );
  }

  /**
   * 取某 (persona, capability) 下所有 active 规则的 eligibility 溯源（红线 11）——供 T4 ToolEligibilityProjector
   * 产出建议。只返回溯源列齐全（exam_spec_version + risk_class 非空且 risk_class 合法）的规则；旧行（无溯源）跳过。
   */
  listActiveEligibilityProvenance(personaId: string, capability: string): RuleEligibilityProvenance[] {
    const rows = this.db.prepare<Pick<ToolActionRuleRow, 'tool_id' | 'schema_version' | 'rule_version' | 'content_hash' | 'exam_spec_version' | 'risk_class'>>(
      `SELECT tool_id, schema_version, rule_version, content_hash, exam_spec_version, risk_class FROM tool_action_rules
       WHERE tenant_id = ? AND persona_id = ? AND capability = ? AND active = 1`,
    ).all(this.tenantId, personaId, capability);
    const out: RuleEligibilityProvenance[] = [];
    for (const r of rows) {
      if (typeof r.exam_spec_version !== 'string' || r.exam_spec_version.length === 0) continue;
      if (r.risk_class !== 'high' && r.risk_class !== 'low') continue;
      out.push({ toolId: r.tool_id, schemaVersion: r.schema_version, ruleVersion: r.rule_version, contentHash: r.content_hash, examSpecVersion: r.exam_spec_version, riskClass: r.risk_class });
    }
    return out;
  }

  /**
   * 停用同 key (persona,tool,capability,schemaVersion) 的所有 active 规则（T3：新规则过考落表前先停旧，
   * 保证部分唯一索引 WHERE active=1 恒单条——新旧版本平滑替换，旧版留档 active=0 供审计）。返回停用条数。
   */
  deactivateActive(personaId: string, toolId: string, capability: string, schemaVersion: string): number {
    const r = this.db.prepare<void>(
      `UPDATE tool_action_rules SET active = 0
       WHERE tenant_id = ? AND persona_id = ? AND tool_id = ? AND capability = ? AND schema_version = ? AND active = 1`,
    ).run(this.tenantId, personaId, toolId, capability, schemaVersion);
    return r.changes;
  }

  /** 取某规则的来源蒸馏产物 id（红线 6 provenance 审计；null=历史无 provenance 行）。 */
  getSourceArtifactId(ruleId: string): string | null {
    const row = this.db.prepare<{ source_artifact_id: string | null }>(
      `SELECT source_artifact_id FROM tool_action_rules WHERE tenant_id = ? AND id = ?`,
    ).get(this.tenantId, ruleId);
    return row?.source_artifact_id ?? null;
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

/**
 * 工具规则学习通道 service（ADR-0060 T3）——候选工具动作规则**过门才入表**。
 *
 * 承 T1（规则表 + 编译器）+ T2（工具考试）。学习期产出的**候选规则**（映射 DSL）不直接落表，必须过：
 *   ⓪ provenance 门（红线 6）：候选规则必须携带 sourceArtifactId（可追溯到上游蒸馏产物），禁任意直灌；
 *   ① 规则形状 lint（T1 DSL 合法性——每条映射能确定性求值）；
 *   ② 工具考试 lint（T2 ExamSpec 反作弊：有正例 + 有 fail-closed 用例 + 目标绑定一致）；
 *   ③ **跑工具考试**（T2 scoreToolExam：正例 arguments 精确匹配 + 安全场景 fail-closed，全过才算学会）；
 *   ④ 过考 → 原子落表（先停同 key 旧 active 规则，再插新 active——部分唯一索引恒单条，红线 10）。
 *
 * 本 service 即红线 6 的**等价蒸馏门控通道**（非物理复用 DistillationService.ingest——工具规则非知识
 * artifact，且复用需迁移 distilled_artifacts.kind CHECK；本仓刻意规避）：同 lint+验收+落表纪律，且强制
 * provenance 字段证明来源可审计——门的本质是「有据可查的验收产物，非任意直灌」，非物理入口单一性。
 *
 * 严守 ADR-0060 红线：
 *   - 运行时零-LLM（红线 1）：本 service **不调 LLM**——候选规则由调用方（学习期教师，经蒸馏门产出、
 *     携带 provenance）提供，本 service 只做确定性门控 + 验收 + 落表。
 *   - 不过考不落表（fail-closed）：lint 不过 / 考试 <100% → 拒绝，返回原因供重训，绝不落半成品规则。
 *   - per-persona（红线 7）：规则按 (tenant, persona) 隔离（store 已带 tenantId + 表隔离）。
 *   - 目标绑定（T2 复审）：候选规则与考试的 tool/capability/schemaVersion 必须一致，否则 lint 拒。
 */

import type { McpToolSchema, ToolActionRule, ToolExamSpec } from '@chrono/kernel';
import { scoreToolExam, lintToolExamSpec, lintToolActionRule } from '@chrono/kernel';
import { generatePrefixedId } from '../utils/id-generator.js';
import type { ToolActionRuleStore } from '../storage/tool-action-rule-store.js';
import type { IDatabase } from '../storage/database.js';

/** 候选规则（学习期产出，尚未过门；不含 id/compiledAt——由本 service 落表时赋）。 */
export interface CandidateToolRule {
  readonly personaId: string;
  readonly toolId: string;
  readonly capability: string;
  readonly schemaVersion: string;
  readonly ruleVersion: string;
  readonly contentHash: string;
  readonly createdBy: string;
  readonly expiresAt: number | null;
  readonly argMappings: ToolActionRule['argMappings'];
  /** 来源蒸馏产物 id（红线 6 provenance）：候选规则必须能追溯到其上游蒸馏产物，禁任意直灌。 */
  readonly sourceArtifactId: string;
  /** 学习期评定风险类（红线 11 eligibility 溯源；红线 13：仅记录/失效判定用，非授权依据）。 */
  readonly riskClass: 'high' | 'low';
}

/** 学习结果：learned=过门落表 / rejected=未过门（附原因，供重训）。 */
export type ToolRuleLearnResult =
  | { readonly ok: true; readonly learned: true; readonly ruleId: string; readonly deactivatedPriorCount: number }
  | { readonly ok: false; readonly learned: false; readonly stage: 'provenance' | 'rule_lint' | 'exam_lint' | 'exam'; readonly reason: string };

export class ToolRuleLearningService {
  constructor(
    private readonly store: ToolActionRuleStore,
    private readonly db: IDatabase,
    private readonly now: () => number,
  ) {}

  /**
   * 门控学习一条候选工具规则：lint → 工具考试 → 过考原子落表。
   * @param candidate  候选规则（学习期产出）
   * @param examSpec   针对该规则的工具考试（同 tool/capability/schemaVersion）
   * @param toolSchema 目标 tool inputSchema（考试构造校验用）
   */
  learn(candidate: CandidateToolRule, examSpec: ToolExamSpec, toolSchema: McpToolSchema): ToolRuleLearnResult {
    const now = this.now();
    const rule: ToolActionRule = {
      tenantId: '', /* store 落表时按自身 tenantId 写；scorer/lint 不依赖 tenantId */
      personaId: candidate.personaId,
      toolId: candidate.toolId,
      capability: candidate.capability,
      schemaVersion: candidate.schemaVersion,
      ruleVersion: candidate.ruleVersion,
      contentHash: candidate.contentHash,
      createdBy: candidate.createdBy,
      compiledAt: now,
      expiresAt: candidate.expiresAt,
      active: true,
      argMappings: candidate.argMappings,
    };

    /* ⓪ provenance 门（红线 6）：候选规则必须能追溯到上游蒸馏产物，禁任意直灌。 */
    if (typeof candidate.sourceArtifactId !== 'string' || candidate.sourceArtifactId.length === 0) {
      return { ok: false, learned: false, stage: 'provenance', reason: '候选规则缺 sourceArtifactId（红线 6：规则来源必须可追溯，禁直灌）' };
    }

    /* ① 规则形状 lint（T1 DSL 结构门）：落表前挡畸形规则（未知 kind / 缺 field / 空 allow 等）。 */
    const ruleProblems = lintToolActionRule(rule.argMappings);
    if (ruleProblems.length > 0) {
      return { ok: false, learned: false, stage: 'rule_lint', reason: ruleProblems.join('; ') };
    }

    /* ② 工具考试 lint（含目标绑定 tool/capability/schemaVersion 一致，T2 S3a）。 */
    const examLint = lintToolExamSpec(examSpec, { toolId: rule.toolId, capability: rule.capability, schemaVersion: rule.schemaVersion });
    if (!examLint.ok) {
      return { ok: false, learned: false, stage: 'exam_lint', reason: examLint.violations.map((v) => `${v.code}: ${v.detail}`).join('; ') };
    }

    /* ③ 跑工具考试（T2）：正例精确匹配 + 安全场景 fail-closed，全过才算学会。 */
    const exam = scoreToolExam(rule, examSpec, toolSchema, now);
    if (!exam.passed) {
      const failed = exam.caseResults.filter((c) => !c.passed).map((c) => `${c.caseId}(${c.detail})`).join('; ');
      return { ok: false, learned: false, stage: 'exam', reason: `工具考试未过（coverage=${exam.coverage.toFixed(2)}）：${failed}` };
    }

    /* ④ 过考 → 原子落表：先停同 key 旧 active，再插新 active（部分唯一索引恒单条，红线 10）。
     * examSpecVersion = 放行本规则的那份冻结考试的唯一标识（examId::scorerVersion，红线 11 eligibility 溯源）。 */
    const examSpecVersion = `${examSpec.examId}::${examSpec.scorerVersion}`;
    const ruleId = generatePrefixedId('tarule');
    const deactivatedPriorCount = this.db.transaction(() => {
      const deactivated = this.store.deactivateActive(rule.personaId, rule.toolId, rule.capability, rule.schemaVersion);
      this.store.insert({
        id: ruleId,
        personaId: rule.personaId, toolId: rule.toolId, capability: rule.capability,
        schemaVersion: rule.schemaVersion, ruleVersion: rule.ruleVersion, contentHash: rule.contentHash,
        argMappings: rule.argMappings, createdBy: rule.createdBy, compiledAt: rule.compiledAt,
        expiresAt: rule.expiresAt, active: true, sourceArtifactId: candidate.sourceArtifactId,
        examSpecVersion, riskClass: candidate.riskClass,
      });
      return deactivated;
    });

    return { ok: true, learned: true, ruleId, deactivatedPriorCount };
  }
}

/**
 * 工具考试评分 + lint（纯函数，ADR-0060 T2）。
 *
 * scoreToolExam：对 spec 每个用例跑 T1 compileToolCall，按 expect_args（arguments 精确等）/ expect_fail（命中
 * 期望 fail code）判定；**全过才 passed**（工具调用不容小错——一个越权/拼错都是安全事故）。
 * lintToolExamSpec：反作弊——必须有正例、**必须有 fail-closed（安全/错误）用例**、无重复 id、schemaVersion 一致。
 *
 * 纯函数、零 node:* 依赖、确定性可复现（同 rule+spec → 同结果）。
 */

import type { McpToolSchema } from '../agent/mcp-protocol-types.js';
import type { ToolActionRule } from './tool-action-types.js';
import { compileToolCall } from './tool-action-compiler.js';
import type {
  ToolExamSpec, ToolExamResult, ToolExamCaseResult,
  ToolExamLintResult, ToolExamLintViolation,
} from './tool-exam-types.js';

export const TOOL_EXAM_SCORER_VERSION = 'tool-exam-v1';

/** lint 反作弊配额（frozen 底线）。 */
export const TOOL_EXAM_LINT_LIMITS = Object.freeze({
  minPositiveCases: 1,   /* 至少一个「能正确构造」正例 */
  minFailClosedCases: 1, /* 至少一个 fail-closed（安全/错误）用例——不考安全=验收漏洞 */
});

/**
 * 对一条规则跑工具考试。now 注入（不读系统时钟）。
 * @param rule       被考的 ToolActionRule
 * @param spec       冻结的工具考试规格
 * @param toolSchema 目标 tool inputSchema（compileToolCall 校验必填/类型）
 * @param now        注入时钟
 */
export function scoreToolExam(rule: ToolActionRule, spec: ToolExamSpec, toolSchema: McpToolSchema, now: number): ToolExamResult {
  const caseResults: ToolExamCaseResult[] = [];
  for (const c of spec.cases) {
    const compiled = compileToolCall(rule, c.taskFields, toolSchema, now);
    if (c.kind === 'expect_args') {
      if (!compiled.ok) {
        caseResults.push({ caseId: c.id, passed: false, detail: `期望编译成功，实得 fail-closed(${compiled.code}): ${compiled.reason}` });
        continue;
      }
      /* 目标绑定校验（Codex T2 复审 S3b）：plan.toolId 须等于 spec.toolId——否则「同 args、错 toolId」的规则会假阳性。 */
      if (compiled.plan.toolId !== spec.toolId) {
        caseResults.push({ caseId: c.id, passed: false, detail: `toolId 不符：期望 ${spec.toolId}，实得 ${compiled.plan.toolId}` });
        continue;
      }
      const eq = argsEqual(compiled.plan.arguments, c.expectArgs);
      caseResults.push({
        caseId: c.id, passed: eq,
        detail: eq ? 'arguments 精确匹配' : `arguments 不符：期望 ${stableStringify(c.expectArgs)}，实得 ${stableStringify(compiled.plan.arguments)}`,
      });
    } else {
      /* expect_fail：期望 fail-closed 且 code 命中允许集。 */
      if (compiled.ok) {
        caseResults.push({ caseId: c.id, passed: false, detail: `期望 fail-closed(${c.expectFailCodes.join('/')})，实得编译成功（应拒未拒——安全隐患）` });
        continue;
      }
      const hit = c.expectFailCodes.includes(compiled.code);
      caseResults.push({
        caseId: c.id, passed: hit,
        detail: hit ? `fail-closed 命中 ${compiled.code}` : `fail code 不符：期望 ${c.expectFailCodes.join('/')}，实得 ${compiled.code}`,
      });
    }
  }
  const passedCount = caseResults.filter((r) => r.passed).length;
  const coverage = caseResults.length === 0 ? 0 : passedCount / caseResults.length;
  return {
    coverage,
    passed: caseResults.length > 0 && passedCount === caseResults.length, /* 全过才算学会（无小错容忍） */
    caseResults,
    scorerVersion: TOOL_EXAM_SCORER_VERSION,
  };
}

/** lint 一份工具考试规格（规则入表前调；ok=false 不得作为验收依据）。传 rule 时校验目标绑定全维一致。 */
export function lintToolExamSpec(spec: ToolExamSpec, rule?: { toolId: string; capability: string; schemaVersion: string }): ToolExamLintResult {
  const v: ToolExamLintViolation[] = [];
  const L = TOOL_EXAM_LINT_LIMITS;

  if (spec.cases.length === 0) {
    v.push({ code: 'no_cases', detail: 'ToolExamSpec 无用例，无法验收' });
  }
  const positives = spec.cases.filter((c) => c.kind === 'expect_args').length;
  const failClosed = spec.cases.filter((c) => c.kind === 'expect_fail').length;
  if (positives < L.minPositiveCases) {
    v.push({ code: 'too_few_positive', detail: `expect_args 正例 ${positives} < ${L.minPositiveCases}` });
  }
  if (failClosed < L.minFailClosedCases) {
    v.push({ code: 'no_failclosed_case', detail: `expect_fail 用例 ${failClosed} < ${L.minFailClosedCases}（不考安全/错误场景=反作弊漏洞）` });
  }
  const ids = new Set<string>();
  for (const c of spec.cases) {
    if (ids.has(c.id)) v.push({ code: 'duplicate_case_id', detail: `用例 id 重复：${c.id}` });
    ids.add(c.id);
  }
  if (rule) {
    /* 目标绑定全维一致（Codex T2 复审 S3a）：考试必须针对被考规则的同一 tool/capability/schemaVersion。 */
    if (rule.schemaVersion !== spec.schemaVersion) {
      v.push({ code: 'schema_version_mismatch', detail: `spec.schemaVersion=${spec.schemaVersion} 与规则 ${rule.schemaVersion} 不符` });
    }
    if (rule.toolId !== spec.toolId) {
      v.push({ code: 'schema_version_mismatch', detail: `spec.toolId=${spec.toolId} 与规则 ${rule.toolId} 不符（目标绑定错配）` });
    }
    if (rule.capability !== spec.capability) {
      v.push({ code: 'schema_version_mismatch', detail: `spec.capability=${spec.capability} 与规则 ${rule.capability} 不符（目标绑定错配）` });
    }
  }
  return { ok: v.length === 0, violations: v };
}

/** arguments 精确相等（确定性深比较，键序无关）。 */
function argsEqual(a: Readonly<Record<string, unknown>>, b: Readonly<Record<string, unknown>>): boolean {
  return stableStringify(a) === stableStringify(b);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

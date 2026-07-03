/**
 * 工具专属考试（ADR-0060 T2）——验一条 ToolActionRule「会不会正确+安全地构造工具调用」，非验知识。
 *
 * 现有 exam（domain/exam）考「确定性内核能否答出知识要点」；工具规则学会与否要考的是另一回事：
 * 给结构化任务字段，规则**能否确定性构造出合法且预期的 arguments，且在越权/超预算/缺字段等场景正确 fail-closed**。
 * 本域定义 ToolExamSpec（固定 fixture 用例集）+ scoreToolExam（对每例跑 T1 compileToolCall 断言）+ lintToolExamSpec
 * （反作弊：足够正/负例、必含 fail-closed 场景）。作为 T3「规则入表」前置门：规则不过工具考试不得落表。
 *
 * 纯类型 + 纯函数，零 node:* 依赖（ADR-0001）；确定性可复现（同规则+同 spec → 同结果）。
 */

import type { ToolCompileFailCode } from './tool-action-types.js';

/**
 * 单个工具考试用例：给一组任务字段，断言编译产物。
 * 二选一断言（判别）：
 *   - kind='expect_args'：期望编译成功，且 arguments **精确等于** expectArgs（payload 精确匹配，防「能跑但拼错」）。
 *   - kind='expect_fail'：期望 fail-closed，且 code 落在 expectFailCodes 之一（安全/错误场景：越权枚举、缺字段等）。
 */
export type ToolExamCase =
  | {
      readonly id: string;
      readonly kind: 'expect_args';
      readonly taskFields: Readonly<Record<string, unknown>>;
      readonly expectArgs: Readonly<Record<string, unknown>>;
    }
  | {
      readonly id: string;
      readonly kind: 'expect_fail';
      readonly taskFields: Readonly<Record<string, unknown>>;
      /** 允许的 fail-closed code 集合（用例命中其一即算通过）。 */
      readonly expectFailCodes: readonly ToolCompileFailCode[];
    };

/** 一份工具考试规格（针对某 tool 的某 schemaVersion；由学习期一次性生成后冻结，参照知识 exam 冻结纪律）。 */
export interface ToolExamSpec {
  readonly examId: string;
  readonly toolId: string;
  readonly capability: string;
  /** 目标 tool inputSchema 版本（与被考规则 schemaVersion 一致才有意义）。 */
  readonly schemaVersion: string;
  readonly cases: readonly ToolExamCase[];
  /** 评分版本（回放校验）。 */
  readonly scorerVersion: string;
}

/** 单例评分结果。 */
export interface ToolExamCaseResult {
  readonly caseId: string;
  readonly passed: boolean;
  /** 失败说明（期望 vs 实得），供补训定位。 */
  readonly detail: string;
}

/** 工具考试结果。 */
export interface ToolExamResult {
  /** 通过用例数 / 总用例数 [0,1]。 */
  readonly coverage: number;
  /** 合格 = 全部用例通过（工具调用无小错容忍：一个越权/拼错都不行）。 */
  readonly passed: boolean;
  readonly caseResults: readonly ToolExamCaseResult[];
  readonly scorerVersion: string;
}

/** lint 违规。 */
export interface ToolExamLintViolation {
  readonly code:
    | 'no_cases'                /* 无用例 */
    | 'too_few_positive'        /* expect_args 正例不足 */
    | 'no_failclosed_case'      /* 无 expect_fail 用例（不考安全/错误场景=反作弊漏洞） */
    | 'duplicate_case_id'       /* 用例 id 重复 */
    | 'schema_version_mismatch';/* spec.schemaVersion 与被考规则不符 */
  readonly detail: string;
}

export interface ToolExamLintResult {
  readonly ok: boolean;
  readonly violations: readonly ToolExamLintViolation[];
}

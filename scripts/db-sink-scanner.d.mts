/**
 * db-sink-scanner 的类型声明——供 tsx / strict TS 测试 import 时有声明，
 * 避免 `npm run typecheck` 报「无声明模块」（Codex #4）。
 *
 * Task 1 提供 buildProgram / isDbCapabilityType + Edge 类型骨架；
 * Task 2 再补 enumerateDbCapabilityEdges / collectUnregisteredEdges / scanProductionDbCapabilityEdges 签名。
 */
import type { Program, TypeChecker, Type, ParsedCommandLine } from 'typescript';

/** buildProgram 的返回：Program + TypeChecker + canonical UoW type + 解析出的 ParsedCommandLine。 */
export interface BuiltProgram {
  program: Program;
  checker: TypeChecker;
  /** canonical SyncWriteUnitOfWork type（检测上界，非 IDatabase）。 */
  uowType: Type;
  parsed: ParsedCommandLine;
}

/**
 * 建 TS Program + 健康门 + 解析 canonical UoW type。
 * 失败（tsconfig 不存在 / root files 空 / 致命 diagnostic / sentinel 缺 / canonical 未解析）时抛（fail-closed）。
 */
export declare function buildProgram(tsconfigPath?: string): BuiltProgram;

/**
 * 判定某类型是否携带 DB 能力（逐 union/intersection 分量 + generic 约束 + 结构兼容）。
 * 绝不吞异常返 false（吞异常 = 静默漏扫）。
 */
export declare function isDbCapabilityType(
  type: Type | undefined,
  checker: TypeChecker,
  uowType: Type,
): boolean;

/**
 * DB-capability edge —— source→sink 的一条边（Task 2 起产出）。
 * id = `<file>#<owner>::<kind>::<target>::<param>`，edge 级（非 owner 级）。
 */
export interface Edge {
  id: string;
  file: string;
  owner: string;
  kind: string;
  target: string;
  param: string;
}

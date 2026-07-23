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
 *
 * kind 取值（A 接收 + B 转移 taxonomy + unknown-boundary 兜底）：
 *  - 接收：'ctor-param' | 'route-param' | 'fn-param' | 'field-decl' | 'deps-prop'
 *  - 转移：'capture' | 'factory-indirect' | 'collection-write' | 'return'
 *          | 'aggregate-wrapping' | 'assignment' | 'decl-init' | 'module-export'
 *  - 兜底：'unknown-boundary'（有 DB 能力但不可分类 / 预算超限 → 门红）
 */
export interface Edge {
  id: string;
  file: string;
  owner: string;
  kind: string;
  target: string;
  param: string;
  /** 仅 unknown-boundary edge 带：诊断上下文（file + property-path + 超限原因）。 */
  context?: string;
}

/**
 * findDbCapabilityPaths 的一条结果：
 *  - `{ path: [] }`：type 本身即 DB 能力（直接命中）。
 *  - `{ path: ['options', 'db'] }`：内部路径命中（包裹类型）。
 *  - `{ unknown: true, context }`：递归预算超限——调用点应产 unknown-boundary edge。
 */
export type CapabilityPath =
  | { path: string[]; unknown?: undefined }
  | { unknown: true; context: string };

/**
 * 递归查某类型携带 DB 能力的完整属性路径（含 union/intersection 分量、tuple·array element、
 * object 属性、对象 spread 结果）。visited = 当前递归栈 active-set（非全局），允许同一 type
 * 经不同父路径重复展开。异常带 context 重抛（fail-closed）。
 */
export declare function findDbCapabilityPaths(
  type: Type,
  checker: TypeChecker,
  uowType: Type,
  ctx?: { node?: import('typescript').Node; file?: string },
): CapabilityPath[];

/**
 * 枚举一个 Program 内所有携带 DB 能力的 source→sink edge（edge 级，不按 owner 合并）。
 * 遍历 A1-A4 接收 + B1-B8 转移全形态；每 boundary 三态判定
 * （空→跳过 / 可归 kind→known edge / 不可分类·超限→unknown-boundary edge）。
 * includeTests=false 时排除 src/test/**（主门 production scope）。
 */
export declare function enumerateDbCapabilityEdges(
  program: Program,
  checker: TypeChecker,
  uowType: Type,
  opts?: { includeTests?: boolean },
): Edge[];

/**
 * 纯比较：edge id 不在 inventory 集合中 → 未登记（无路径过滤）。
 */
export declare function collectUnregisteredEdges(edges: Edge[], inventoryIds: Set<string>): Edge[];

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

/**
 * 一条传播 edge 的机器归因结果（Task 2.5）。
 *  - linked-to-sink：能机械定位终点=已扫描的 A 接收点（sinkId 指向该 A 点 edge id）。
 *  - ephemeral：机械证明能力不逃逸（仅同步传给明确 per-request 函数，不 return/存/注册/写容器）。
 *  - terminal-escape：能力可能跨调用/作用域/生命周期存活（module export / 闭包·timer·worker
 *    capture / 动态 assignment / container write / 逃逸未知调用方 return / 传外部·any·动态 call）——
 *    须升级为 semantic sink 登记。
 *  - unknown：解析失败 / 预算超限 / callee 不明且未升级 escape → 门红。
 */
export interface PropagationResult {
  propagation: 'linked-to-sink' | 'ephemeral' | 'terminal-escape' | 'unknown';
  /** 仅 linked-to-sink 带：终点 A 接收点的 semantic sink id。 */
  sinkId?: string;
  /** 归因依据（诊断用，便于门红时定位为何某 edge 判某态）。 */
  reason?: string;
}

/**
 * 机器归因一条传播 edge（B 类）的处置：linked-to-sink / ephemeral / terminal-escape / unknown。
 * 只对 B 传播 edge 有意义；A 接收 edge（sink declaration 本身）传入时按 terminal-escape 之外的
 * 语义处理由调用方决定。allEdges 用于 linked-to-sink 时定位终点 A 点。
 */
export declare function classifyPropagation(
  edge: Edge,
  checker: TypeChecker,
  allEdges: Edge[],
): PropagationResult;

/**
 * 唯一应用 production scope（排除 src/test/**）的入口——建 Program（tsconfig.src.json）+ 健康门
 * + 枚举全量 edge。供主门 check:db-access 调。
 */
export declare function scanProductionDbCapabilityEdges(): Edge[];

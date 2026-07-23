/**
 * 方法面 negative fixture（Task 2.5）—— 证明收窄后「方法/原型面」不再被误判含 DB 能力。
 *
 * 收窄前（Task 2）findDbCapabilityPaths 递归所有属性，含**方法签名 / 原型方法 / 函数对象
 * 表面**——对含大量方法的 DTO / service 对象（或 string/number 的 length/toString、
 * Buffer.subarray 之类标准库原型）预算爆 → 产 1269 条 unknown-boundary 误报。
 *
 * 本 fixture 的所有返回类型都**不含**任何 DB 能力数据属性——只含方法 / primitive /
 * 标准库容器。收窄后（只递归数据属性、跳方法/原型面）应产 **0 条 edge**（含 0 unknown）。
 *
 * 变异自证：临时恢复「递归方法面」→ 本 fixture 会因为方法参数/原型深钻而产 unknown-boundary
 * edge（预算超限），下面的「method-surface 不产任何 edge」断言变红。
 */

/** 一条 DTO 行——只含 primitive 数据字段（无 DB 能力）。 */
interface Row {
  id: string;
  count: number;
  createdAt: Date;
  tags: string[];
}

/**
 * 一个含丰富**方法**的 service 对象类型——方法签名参数里即便出现类似 DB 的形状，
 * 收窄后也不展开方法面，故不产 edge。
 */
interface RowService {
  find(id: string): Row | undefined;
  list(): Row[];
  countBy(pred: (row: Row) => boolean): number;
  toJSON(): string;
}

/** 返回 primitive 数组（rows）——无 DB 能力，收窄后不产 return edge。 */
export function listRows(): Row[] {
  return [];
}

/** 返回含方法的 service 对象——方法面不展开，收窄后不产 return edge。 */
export function makeRowService(): RowService {
  return {
    find: () => undefined,
    list: () => [],
    countBy: () => 0,
    toJSON: () => '{}',
  };
}

/**
 * 返回 primitive + 标准库容器（string.length / number.toString / Map / Set / Buffer）——
 * 这些原型方法（endsWith / slice / subarray / toString / set / add …）正是收窄前预算爆的根因。
 * 收窄后直接取 element type、跳原型方法，不产任何 edge。
 */
export function scalarAndContainers(): { name: string; total: number; index: Map<string, number>; seen: Set<string> } {
  return { name: '', total: 0, index: new Map(), seen: new Set() };
}

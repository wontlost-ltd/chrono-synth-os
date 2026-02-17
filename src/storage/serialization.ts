/**
 * Map ↔ JSON 序列化工具
 * SQLite 中以 JSON 文本存储 Map 数据
 */

/** Map → JSON 字符串 */
export function mapToJson<V>(map: ReadonlyMap<string, V>): string {
  return JSON.stringify(Object.fromEntries(map));
}

/** JSON 字符串 → Map */
export function jsonToMap<V>(json: string): Map<string, V> {
  const obj = JSON.parse(json) as Record<string, V>;
  return new Map(Object.entries(obj));
}

/** 数组 → JSON 字符串 */
export function arrayToJson<T>(arr: readonly T[]): string {
  return JSON.stringify(arr);
}

/** JSON 字符串 → 数组 */
export function jsonToArray<T>(json: string): T[] {
  return JSON.parse(json) as T[];
}

/**
 * JSON.stringify 替换器：将 Map 序列化为可恢复的格式
 */
export function mapReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Map) {
    return { __type: 'Map', entries: Array.from(value.entries()) };
  }
  return value;
}

/**
 * JSON.parse 恢复器：将序列化的 Map 恢复
 */
export function mapReviver(_key: string, value: unknown): unknown {
  if (value !== null && typeof value === 'object' && '__type' in value) {
    const obj = value as { __type: string; entries?: [string, unknown][] };
    if (obj.__type === 'Map' && Array.isArray(obj.entries)) {
      return new Map(obj.entries);
    }
  }
  return value;
}

/** 深度序列化（保留 Map） */
export function deepStringify(value: unknown): string {
  return JSON.stringify(value, mapReplacer);
}

/** 深度反序列化（恢复 Map） */
export function deepParse<T>(json: string): T {
  return JSON.parse(json, mapReviver) as T;
}

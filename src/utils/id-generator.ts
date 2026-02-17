import { randomUUID } from 'node:crypto';

/** 生成 UUID v4 */
export function generateId(): string {
  return randomUUID();
}

/** 生成带前缀的 ID，方便调试时区分实体类型 */
export function generatePrefixedId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

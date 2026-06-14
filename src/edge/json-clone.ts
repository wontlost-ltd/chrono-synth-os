/**
 * Edge 本地 JSON 深拷贝工具（收口审查 — DRY，仅 src/edge 内复用）。
 *
 * Edge 各模块（outbox/growth-queue）的可序列化 payload 都是 JSON 安全的领域数据，需要深拷贝隔离
 * 外部 reference（防调用方篡改入参/读出污染内部状态）。此处统一一份 JSON round-trip 深拷贝——
 * 范围**仅限 src/edge**（不是全仓库通用深拷贝；payload 保证 JSON 安全，无 Date/Map/循环引用）。
 */

/** 深拷贝一个 JSON 安全的对象（payload）。调用方须保证输入可 JSON 序列化。 */
export function cloneJsonObject(o: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(o)) as Record<string, unknown>;
}

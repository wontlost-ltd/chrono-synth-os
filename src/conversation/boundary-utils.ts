/** 行为边界（BehaviorBoundary）校验工具——从 conversation-service 提取的共享模块。
 * 供 conversation-service 与 collaboration 编排共用，避免后者为取一个函数而 import 整个对话流水线。
 * 纯函数、零 I/O、确定性。 */
import type { BehaviorBoundary } from '../enterprise/persona-template-catalog.js';

/** 校验一个未知值是否为合法 BehaviorBoundary（rule 属三种枚举之一 + topic 为非空字符串）。 */
export function isValidBoundary(value: unknown): value is BehaviorBoundary {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    (v.rule === 'never_discuss' || v.rule === 'always_escalate' || v.rule === 'require_confirmation') &&
    typeof v.topic === 'string' && v.topic.length > 0
  );
}

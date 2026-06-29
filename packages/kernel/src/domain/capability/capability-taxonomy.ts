/**
 * 能力分类法（ADR-0057 L1）——数字员工「职能能力」的确定性词表 + 规范化。
 *
 * 背景：`requiredCapabilities` 现状是自由字符串（decomposition-playbook 里散落 'research' / 'review' /
 * 'compliance' / ...），无中央词表。GapDetector（缺口检测）要确定性比对「任务要求的能力」与「persona 已学的
 * 能力」，必须先有**规范化的能力标识**——否则 'Research' / 'research' / ' research ' 会被当成不同能力，缺口
 * 检测假阳/假阴。
 *
 * 本模块只做两件确定性的事（零-LLM、纯函数、零 node:* 依赖，ADR-0001）：
 *   1. 规范化能力标识（normalizeCapability）：小写 + trim + 折叠空白，让同义书写归一。
 *   2. 提供已知能力词表（KNOWN_CAPABILITIES，来自 playbook 现状）——**仅作参考/校验**，**不限制**取值
 *      （新职能可引入新能力字符串；词表用于 lint/可观测，不做白名单拒绝，避免锁死扩展）。
 *
 * 关键纪律：规范化是**纯字符串确定性变换**，**禁止**任何 LLM/embedding/语义归并（红线 1/3）——
 * 'research' 与 'literature_review' 是不同能力，不做语义合并（那会引入不可复现的语义判断）。
 */

/** 已知能力词表（来自 decomposition-playbook 现状，规范化形态）。仅参考/可观测，不做白名单拒绝。 */
export const KNOWN_CAPABILITIES: readonly string[] = Object.freeze([
  'analysis',
  'compliance',
  'data_extraction',
  'escalation',
  'publishing',
  'qa',
  'reporting',
  'requirements',
  'research',
  'review',
  'support',
  'triage',
  'writing',
]);

/**
 * 规范化能力标识：小写 + 去首尾空白 + 内部连续空白折叠为单个下划线。
 * 纯确定性字符串变换——同输入同输出，无语义判断。空/非字符串归一为空串（由调用方按缺口语义处理）。
 */
export function normalizeCapability(raw: string): string {
  if (typeof raw !== 'string') return '';
  return raw.trim().toLowerCase().replace(/\s+/g, '_');
}

/** 规范化一组能力标识 + 去重 + 去空（确定性排序：字典序，保证可复现）。 */
export function normalizeCapabilities(raw: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  for (const c of raw) {
    const n = normalizeCapability(c);
    if (n.length > 0) seen.add(n);
  }
  return [...seen].sort();
}

/** 是否为已知能力（规范化后查词表）。仅供 lint/可观测，不用于拒绝未知能力。 */
export function isKnownCapability(raw: string): boolean {
  return KNOWN_CAPABILITIES.includes(normalizeCapability(raw));
}

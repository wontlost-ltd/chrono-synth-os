/**
 * 主动性引擎（ADR-0054 Phase 3）——订阅既有内部信号 → 确定性门控 → 确定性生成 → 入队。
 *
 * 主动性 = 对既有 EventBus 信号的确定性门控，不是新推理循环（ADR-0054 核心决策）。本引擎：
 *   订阅 os.bus 信号子集 → evaluateProactiveGate（纯函数节制）→ composeNudge（零-LLM 模板）
 *   → ProactiveMessageStore.enqueue（幂等键防重）。
 *
 * 红线（ADR-0054）：
 *   - 红线 1 零-LLM：门 + 生成全确定性，绝不调 LLM。
 *   - 红线 2 不改身份：只读人格状态 + 写 outbound 队列，绝不调 CoreRhythmLayer 身份写方法。
 *   - 红线 5/10 失败隔离：订阅回调**自身 try/catch**——Node EventEmitter.emit 会传播 listener
 *     异常，一条主动性评估异常绝不能炸穿触发它的记忆写入/蒸馏/演化主流程。
 *   - 红线 7 信号租户归属：只处理 tenantId 与本引擎 tenantId 一致的信号；缺失/不一致 → drop，
 *     绝不默认归 'default'（隔离须在信号入口成立）。
 */

import type { EventBus } from '../events/event-bus.js';
import type { Logger } from '../utils/logger.js';
import type { ProactiveMessageStore } from '../storage/proactive-message-store.js';
import {
  evaluateProactiveGate,
  DEFAULT_PROACTIVE_GATE_CONFIG,
  type ProactiveGateConfig,
  type ProactiveSignalType,
} from '@chrono/kernel';
import { composeNudge } from './proactive-composer.js';

const LAYER = 'ProactiveEngine';

/** 引擎 personaId——companion 单 core-self 模型（与 chat/me 路由一致）。 */
const PERSONA_ID = 'default';

export interface ProactiveEngineDeps {
  readonly bus: EventBus;
  readonly store: ProactiveMessageStore;
  readonly now: () => number;
  readonly logger: Logger;
  /** 本引擎所属租户——信号 tenantId 必须与之一致才处理（红线 7）。 */
  readonly tenantId: string;
  readonly config?: ProactiveGateConfig;
}

/** 各信号类型如何从载荷里取**确定性信号身份**（sourceId，幂等键组成；ADR-0054 红线 8）。
 * 返回 undefined → 该信号无稳定身份，不入队（宁可漏发，不重复发）。 */
const SIGNAL_SOURCE_ID: Readonly<Record<ProactiveSignalType, (p: Record<string, unknown>) => string | undefined>> = {
  /* 巩固结果的 consolidatedId 唯一标识这次巩固。 */
  'core:memory-consolidated': (p) => {
    const r = p.result as { consolidatedId?: unknown } | undefined;
    return typeof r?.consolidatedId === 'string' ? `mc:${r.consolidatedId}` : undefined;
  },
  /* 叙事变化用新叙事内容的稳定指纹（同一份新叙事 → 同 id，重放不重复）。 */
  'core:narrative-changed': (p) => {
    return typeof p.narrative === 'string' ? `nc:${fnv1a(p.narrative)}` : undefined;
  },
  /* 演化完成用合并版本集的稳定指纹。 */
  'system:evolution-completed': (p) => {
    const ids = p.mergedVersionIds;
    if (!Array.isArray(ids) || ids.length === 0) return undefined;
    return `ev:${fnv1a([...ids].sort().join(','))}`;
  },
};

/** FNV-1a 32-bit 十六进制——确定性内容指纹（同串恒同值，零依赖）。 */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

export class ProactiveEngine {
  private readonly config: ProactiveGateConfig;
  /* 保存 listener 引用以便 stop() 解绑。 */
  private readonly bound: Array<{ event: ProactiveSignalType; fn: (payload: Record<string, unknown>) => void }> = [];
  private started = false;

  constructor(private readonly deps: ProactiveEngineDeps) {
    this.config = deps.config ?? DEFAULT_PROACTIVE_GATE_CONFIG;
  }

  /** 订阅信号子集开始工作（幂等：重复 start 无副作用）。 */
  start(): void {
    if (this.started) return;
    this.started = true;
    const signals: ProactiveSignalType[] = [
      'core:memory-consolidated',
      'core:narrative-changed',
      'system:evolution-completed',
    ];
    for (const event of signals) {
      const fn = (payload: Record<string, unknown>): void => this.handle(event, payload);
      this.deps.bus.on(event, fn as never);
      this.bound.push({ event, fn });
    }
  }

  /** 解绑所有订阅（OS close 时）。 */
  stop(): void {
    for (const { event, fn } of this.bound) {
      this.deps.bus.off(event, fn as never);
    }
    this.bound.length = 0;
    this.started = false;
  }

  /**
   * 处理一条信号——**自身 try/catch**（红线 5/10）：评估异常不外抛，绝不污染触发它的主流程。
   */
  private handle(signalType: ProactiveSignalType, payload: Record<string, unknown>): void {
    try {
      /* 红线 7：缺 tenantId 或与本引擎不一致 → drop，绝不默认归 'default'。 */
      const tenantId = payload.tenantId;
      if (typeof tenantId !== 'string' || tenantId !== this.deps.tenantId) return;

      /* 红线 8：sourceId 取**信号自身的确定性身份**（非时间窗口）——同一信号重放/重订阅/重启
       * 都得同 sourceId，被唯一索引吞，不会跨窗口重复发。拿不到稳定身份的信号宁可不发。 */
      const sourceId = SIGNAL_SOURCE_ID[signalType](payload);
      if (sourceId === undefined) return;

      const now = this.deps.now();
      const since = now - this.config.windowMs;
      const stats = this.deps.store.windowStats(PERSONA_ID, since);

      const decision = evaluateProactiveGate({
        signalType, now, config: this.config,
        windowCount: stats.windowCount, lastCreatedAt: stats.lastCreatedAt,
      });
      if (!decision.emit) return;

      const nudge = composeNudge(signalType);
      this.deps.store.enqueue({
        personaId: PERSONA_ID,
        signalType,
        sourceId,
        signalVersion: 0,
        body: nudge.body,
        kind: nudge.kind,
      });
    } catch (err) {
      /* 失败隔离：记录但绝不外抛（红线 5/10）。 */
      this.deps.logger.error(LAYER, `主动性评估失败（已隔离，不影响主流程）: ${signalType}`, err as Error);
    }
  }
}

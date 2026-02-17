/**
 * 引导服务
 * 渐进式画像构建：五步流程将用户数据注入五层人格模型
 *
 * Step 1: 快速启动 — 用户描述待决策问题
 * Step 2: 价值选择 — 选择核心价值
 * Step 3: 记忆种子 — 描述过往决策经验
 * Step 4: 首次模拟 — 运行决策引擎验证
 * Step 5: 保存基线 — 创建快照
 */

import type { CoreRhythmLayer } from '../core/core-rhythm-layer.js';
import type { DecisionEngine } from '../intelligence/decision-engine.js';
import type { DecisionCase, DecisionResult } from '../intelligence/types.js';
import type { EventBus } from '../events/event-bus.js';
import type { Clock } from '../utils/clock.js';
import type { Logger } from '../utils/logger.js';
import type { SystemSnapshot } from '../types/snapshot.js';
import { generatePrefixedId } from '../utils/id-generator.js';
import { NotFoundError, ErrorCode } from '../errors/index.js';

export interface OnboardingSession {
  readonly id: string;
  readonly currentStep: number;
  readonly completedSteps: readonly number[];
  readonly decision?: DecisionCase;
  readonly simulationResult?: DecisionResult;
  readonly snapshotId?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

interface MutableSession {
  id: string;
  currentStep: number;
  completedSteps: number[];
  decision?: DecisionCase;
  simulationResult?: DecisionResult;
  snapshotId?: string;
  createdAt: number;
  updatedAt: number;
}

const LAYER = 'Onboarding';

export class OnboardingService {
  private readonly sessions = new Map<string, MutableSession>();

  constructor(
    private readonly core: CoreRhythmLayer,
    private readonly engine: DecisionEngine,
    private readonly bus: EventBus,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly createSnapshot: (reason: SystemSnapshot['reason']) => SystemSnapshot,
  ) {}

  /** 创建新的引导会话 */
  createSession(): OnboardingSession {
    const id = generatePrefixedId('onb');
    const now = this.clock.now();
    const session: MutableSession = {
      id,
      currentStep: 1,
      completedSteps: [],
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(id, session);
    this.bus.emit('onboarding:session-started', { sessionId: id });
    this.logger.info(LAYER, `引导会话已创建: ${id}`);
    return this.toReadonly(session);
  }

  /** 获取会话状态 */
  getSession(sessionId: string): OnboardingSession | undefined {
    const session = this.sessions.get(sessionId);
    return session ? this.toReadonly(session) : undefined;
  }

  /** 提交步骤数据 */
  async submitStep(sessionId: string, step: number, data: Record<string, unknown>): Promise<OnboardingSession> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new NotFoundError(`引导会话 ${sessionId} 不存在`, ErrorCode.NOT_FOUND_ONBOARDING);
    }

    switch (step) {
      case 1:
        this.processStep1(session, data as { title: string; description: string });
        break;
      case 2:
        this.processStep2(session, data as { values: string[]; customValues?: string[] });
        break;
      case 3:
        this.processStep3(session, data as { memories: Array<{ description: string; valence?: number; salience?: number }> });
        break;
      case 4:
        await this.processStep4(session);
        break;
      case 5:
        this.processStep5(session);
        break;
      default:
        throw new RangeError(`无效步骤: ${step}`);
    }

    session.updatedAt = this.clock.now();
    if (!session.completedSteps.includes(step)) {
      session.completedSteps.push(step);
    }
    session.currentStep = Math.min(step + 1, 6);

    this.bus.emit('onboarding:step-completed', { sessionId, step });
    this.logger.info(LAYER, `步骤 ${step} 完成: ${sessionId}`);

    return this.toReadonly(session);
  }

  /** Step 1: 记录待决策问题 */
  private processStep1(session: MutableSession, data: { title: string; description: string }): void {
    session.decision = {
      id: generatePrefixedId('dec'),
      title: data.title,
      description: data.description,
    };
  }

  /** Step 2: 初始化 L1 价值 */
  private processStep2(_session: MutableSession, data: { values: string[]; customValues?: string[] }): void {
    const allValues = [...data.values, ...(data.customValues ?? [])];
    const step = 1 / Math.max(1, allValues.length);
    for (let i = 0; i < allValues.length; i++) {
      /* 权重按顺序递减（用户首选优先） */
      const weight = Math.max(0.1, 1 - i * step);
      this.core.addValue(allValues[i], weight);
    }
  }

  /** Step 3: 创建 L4 情景记忆种子 */
  private processStep3(_session: MutableSession, data: { memories: Array<{ description: string; valence?: number; salience?: number }> }): void {
    for (const mem of data.memories) {
      this.core.addMemory('episodic', mem.description, mem.valence ?? 0.5, mem.salience ?? 0.7);
    }
  }

  /** Step 4: 运行首次决策模拟 */
  private async processStep4(session: MutableSession): Promise<void> {
    if (!session.decision) {
      throw new Error('请先完成步骤 1 (描述决策问题)');
    }
    const result = await this.engine.evaluate(session.decision);
    session.simulationResult = result;
  }

  /** Step 5: 保存基线快照 */
  private processStep5(session: MutableSession): void {
    const snapshot = this.createSnapshot('manual');
    session.snapshotId = snapshot.id;
    this.bus.emit('onboarding:completed', { sessionId: session.id, snapshotId: snapshot.id });
    this.logger.info(LAYER, `引导完成，基线快照: ${snapshot.id}`);
  }

  private toReadonly(session: MutableSession): OnboardingSession {
    return {
      id: session.id,
      currentStep: session.currentStep,
      completedSteps: [...session.completedSteps],
      decision: session.decision,
      simulationResult: session.simulationResult,
      snapshotId: session.snapshotId,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    };
  }
}

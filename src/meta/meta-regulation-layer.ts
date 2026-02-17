/**
 * 元调控层
 * 解决版本冲突、分配资源、决定变更集成
 * 维护自我的一致性和连续性
 */

import type { CoreRhythmLayer } from '../core/core-rhythm-layer.js';
import type { EventBus } from '../events/event-bus.js';
import type { IDatabase } from '../storage/database.js';
import type { AllocationStrategy, IntegrationProposal, ResourceAllocation } from '../types/meta-regulation.js';
import type { PersonaVersion, SimulationResult } from '../types/persona-version.js';
import type { Clock } from '../utils/clock.js';
import type { Logger } from '../utils/logger.js';
import { ConflictResolver } from './conflict-resolver.js';
import { IntegrationEngine, type IntegrationConfig } from './integration-engine.js';
import { ResourceAllocator } from './resource-allocator.js';
import type { UpdateGate, PendingUpdate } from './update-gate.js';

const LAYER = 'MetaRegulation';

export class MetaRegulationLayer {
  readonly conflicts: ConflictResolver;
  readonly integrator: IntegrationEngine;
  readonly allocator: ResourceAllocator;

  private readonly updateGate?: UpdateGate;

  constructor(
    db: IDatabase,
    private readonly bus: EventBus,
    private readonly clock: Clock,
    private readonly logger: Logger,
    integrationConfig?: Partial<IntegrationConfig>,
    updateGate?: UpdateGate,
  ) {
    this.updateGate = updateGate;
    this.conflicts = new ConflictResolver(db, clock);
    this.integrator = new IntegrationEngine(clock, integrationConfig, logger);
    this.allocator = new ResourceAllocator(clock);
  }

  /** 运行冲突检测 */
  detectConflicts(personas: readonly PersonaVersion[]): void {
    const valueConflicts = this.conflicts.detectValueDivergence(personas);
    for (const c of valueConflicts) {
      this.bus.emit('meta:conflict-detected', { conflict: c });
      this.logger.warn(LAYER, `冲突检测: ${c.description}`, { severity: c.severity });
    }

    const resourceConflict = this.conflicts.detectResourceContention(personas);
    if (resourceConflict) {
      this.bus.emit('meta:conflict-detected', { conflict: resourceConflict });
      this.logger.warn(LAYER, `资源冲突: ${resourceConflict.description}`);
    }
  }

  /** 提出并评估集成提案 */
  proposeIntegration(result: SimulationResult): IntegrationProposal {
    const proposal = this.integrator.propose(result);
    this.bus.emit('meta:integration-proposed', { proposal });
    this.logger.info(LAYER, `集成提案: 来源=${result.personaVersionId}, 置信度=${proposal.confidence.toFixed(3)}`);
    return proposal;
  }

  /** 决定并执行集成 */
  decideIntegration(
    proposal: IntegrationProposal,
    fitnessScore: number,
    coreLayer: CoreRhythmLayer,
  ): { accepted: boolean; pendingUpdates: PendingUpdate[] } {
    const accepted = this.integrator.evaluate(proposal, fitnessScore);

    /* 填充提案生命周期字段 */
    proposal.accepted = accepted;
    proposal.decidedAt = this.clock.now();

    let pendingUpdates: PendingUpdate[] = [];
    if (accepted) {
      const result = this.integrator.apply(proposal, coreLayer, this.updateGate);
      pendingUpdates = result.pendingUpdates;
      this.logger.info(LAYER, `集成已接受: 提案=${proposal.id}`);
    } else {
      this.logger.info(LAYER, `集成已拒绝: 提案=${proposal.id}, 适应度=${fitnessScore.toFixed(3)}, 置信度=${proposal.confidence.toFixed(3)}`);
    }

    this.bus.emit('meta:integration-decided', { proposalId: proposal.id, accepted });
    return { accepted, pendingUpdates };
  }

  /** 分配资源 */
  allocateResources(personas: readonly PersonaVersion[], strategy?: AllocationStrategy): ResourceAllocation[] {
    const allocations = this.allocator.allocate(personas, strategy);
    this.bus.emit('meta:resources-allocated', { allocations });
    this.logger.info(LAYER, `资源已分配: ${allocations.length} 个版本, 策略=${strategy ?? 'equal'}`);
    return allocations;
  }

  /** 解决冲突 */
  resolveConflict(conflictId: string, resolution: string): boolean {
    const ok = this.conflicts.resolve(conflictId, resolution);
    if (ok) {
      this.bus.emit('meta:conflict-resolved', { conflictId, resolution });
      this.logger.info(LAYER, `冲突已解决: ${conflictId}`);
    }
    return ok;
  }
}

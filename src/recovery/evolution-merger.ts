/**
 * 演化合并器：将快层中表现优秀的实验成果合并到慢层
 */

import type { CoreRhythmLayer } from '../core/core-rhythm-layer.js';
import type { MetaRegulationLayer } from '../meta/meta-regulation-layer.js';
import type { IDatabase } from '../storage/database.js';
import { arrayToJson, deepStringify } from '../storage/serialization.js';
import type { EvolutionRecord } from '../types/snapshot.js';
import type { PersonaVersion, SimulationResult } from '../types/persona-version.js';
import type { Clock } from '../utils/clock.js';
import type { Logger } from '../utils/logger.js';
import { generatePrefixedId } from '../utils/id-generator.js';

const LAYER = 'Evolution';

export class EvolutionMerger {
  constructor(
    private readonly db: IDatabase,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  /**
   * 从已完成的人格版本中提取最佳成果，合并到核心层
   */
  merge(
    completedPersonas: readonly PersonaVersion[],
    coreLayer: CoreRhythmLayer,
    metaLayer: MetaRegulationLayer,
  ): { mergedVersionIds: string[]; valueDelta: Map<string, number> } {
    const mergedVersionIds: string[] = [];

    /* 获取合并前的核心价值快照 */
    const beforeValues = new Map<string, number>();
    for (const [id, v] of coreLayer.values.getAll()) {
      beforeValues.set(id, v.weight);
    }

    for (const persona of completedPersonas) {
      if (persona.results.length === 0) continue;

      /* 取最高适应度的结果 */
      const best = this.selectBest(persona.results);
      if (!best) continue;

      const proposal = metaLayer.proposeIntegration(best);
      const accepted = metaLayer.decideIntegration(proposal, best.fitnessScore, coreLayer);

      if (accepted) {
        mergedVersionIds.push(persona.id);
        this.logger.info(LAYER, `演化合并: 人格 ${persona.label} 的最佳结果已集成`);
      }
    }

    /* 计算价值变化增量 */
    const valueDelta = new Map<string, number>();
    for (const [id, v] of coreLayer.values.getAll()) {
      const before = beforeValues.get(id);
      if (before !== undefined && before !== v.weight) {
        valueDelta.set(id, v.weight - before);
      }
    }

    return { mergedVersionIds, valueDelta };
  }

  /** 创建并持久化演化记录 */
  persistRecord(
    beforeSnapshotId: string,
    afterSnapshotId: string,
    mergedVersionIds: string[],
    valueDelta: Map<string, number>,
  ): EvolutionRecord {
    const record: EvolutionRecord = {
      id: generatePrefixedId('evo'),
      beforeSnapshotId,
      afterSnapshotId,
      mergedVersionIds,
      valueDelta,
      evolvedAt: this.clock.now(),
    };

    this.db.prepare<void>(
      `INSERT INTO evolution_records (id, before_snapshot_id, after_snapshot_id, merged_version_ids_json, value_delta_json, evolved_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      record.id, record.beforeSnapshotId, record.afterSnapshotId,
      arrayToJson(record.mergedVersionIds as string[]),
      deepStringify(record.valueDelta),
      record.evolvedAt,
    );

    this.logger.info(LAYER, `演化记录已持久化: ${record.id}`);
    return record;
  }

  /** 选择最高适应度的模拟结果 */
  private selectBest(results: readonly SimulationResult[]): SimulationResult | undefined {
    if (results.length === 0) return undefined;
    return results.reduce((best, r) => r.fitnessScore > best.fitnessScore ? r : best);
  }
}

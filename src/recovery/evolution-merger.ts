/**
 * 演化合并器：将快层中表现优秀的实验成果合并到慢层
 */

import type { CoreRhythmLayer } from '../core/core-rhythm-layer.js';
import type { MetaRegulationLayer } from '../meta/meta-regulation-layer.js';
import type { IDatabase } from '../storage/database.js';
import { arrayToJson, deepStringify } from '../storage/serialization.js';
import type { EvolutionRecord, EvolutionDiffReport } from '../types/snapshot.js';
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
   * 生成差异报告和后悔概率（must-think 第七节）
   */
  merge(
    completedPersonas: readonly PersonaVersion[],
    coreLayer: CoreRhythmLayer,
    metaLayer: MetaRegulationLayer,
  ): { mergedVersionIds: string[]; valueDelta: Map<string, number>; diffReport: EvolutionDiffReport } {
    const mergedVersionIds: string[] = [];

    /* 获取合并前的核心价值快照（含 label） */
    const beforeValues = new Map<string, { label: string; weight: number }>();
    for (const [id, v] of coreLayer.values.getAll()) {
      beforeValues.set(id, { label: v.label, weight: v.weight });
    }

    for (const persona of completedPersonas) {
      if (persona.results.length === 0) continue;

      /* 取最高适应度的结果 */
      const best = this.selectBest(persona.results);
      if (!best) continue;

      const proposal = metaLayer.proposeIntegration(best);
      const { accepted } = metaLayer.decideIntegration(proposal, best.fitnessScore, coreLayer);

      if (accepted) {
        mergedVersionIds.push(persona.id);
        this.logger.info(LAYER, `演化合并: 人格 ${persona.label} 的最佳结果已集成`);
      }
    }

    /* 计算价值变化增量 + 差异报告 */
    const valueDelta = new Map<string, number>();
    const valueDiffs: EvolutionDiffReport['valueDiffs'][number][] = [];

    for (const [id, v] of coreLayer.values.getAll()) {
      const before = beforeValues.get(id);
      if (before !== undefined && before.weight !== v.weight) {
        const delta = v.weight - before.weight;
        valueDelta.set(id, delta);
        valueDiffs.push({
          valueId: id,
          label: before.label,
          weightBefore: before.weight,
          weightAfter: v.weight,
          delta,
        });
      }
    }

    /* 后悔概率 = regretSensitivity × tanh(totalDeltaMagnitude / max(valueCount, 1)) */
    const totalDeltaMagnitude = valueDiffs.reduce((sum, d) => sum + Math.abs(d.delta), 0);
    const valueCount = Math.max(beforeValues.size, 1);
    const regretSensitivity = coreLayer.decisionStyle.get().regretSensitivity;
    const regretProbability = regretSensitivity * Math.tanh(totalDeltaMagnitude / valueCount);

    const summary = mergedVersionIds.length === 0
      ? '无版本被合并'
      : `合并 ${mergedVersionIds.length} 个版本，影响 ${valueDiffs.length} 个价值维度，总偏移量 ${totalDeltaMagnitude.toFixed(4)}，后悔概率 ${(regretProbability * 100).toFixed(1)}%`;

    const diffReport: EvolutionDiffReport = {
      valueDiffs,
      regretProbability,
      totalDeltaMagnitude,
      summary,
    };

    return { mergedVersionIds, valueDelta, diffReport };
  }

  /** 创建并持久化演化记录 */
  persistRecord(
    beforeSnapshotId: string,
    afterSnapshotId: string,
    mergedVersionIds: string[],
    valueDelta: Map<string, number>,
    diffReport?: EvolutionDiffReport,
  ): EvolutionRecord {
    const record: EvolutionRecord = {
      id: generatePrefixedId('evo'),
      beforeSnapshotId,
      afterSnapshotId,
      mergedVersionIds,
      valueDelta,
      diffReport,
      evolvedAt: this.clock.now(),
    };

    this.db.prepare<void>(
      `INSERT INTO evolution_records (id, before_snapshot_id, after_snapshot_id, merged_version_ids_json, value_delta_json, evolved_at, diff_report_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      record.id, record.beforeSnapshotId, record.afterSnapshotId,
      arrayToJson(record.mergedVersionIds),
      deepStringify(record.valueDelta),
      record.evolvedAt,
      diffReport ? JSON.stringify(diffReport) : null,
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

/**
 * P-OS (人格操作系统) 路由
 * L0 生存锚点 | L2 决策风格 | L3 认知模型 | 完整状态
 */

import type { FastifyInstance } from 'fastify';
import type { ChronoSynthOS } from '../../chrono-synth-os.js';
import { NotFoundError, ValidationError, ErrorCode } from '../../errors/index.js';
import { compilePersonaState, summarizeForPrompt } from '../../intelligence/persona-state.js';
import { UpdateGate, type PendingUpdate } from '../../meta/update-gate.js';
import type { SurvivalAnchorUpdate } from '../../core/survival-anchor-store.js';
import {
  CreateSurvivalAnchorSchema,
  UpdateSurvivalAnchorSchema,
  UpdateDecisionStyleSchema,
  UpdateCognitiveModelSchema,
} from '../schemas/api-schemas.js';

export function registerPosRoutes(app: FastifyInstance, os: ChronoSynthOS): void {
  let gate: UpdateGate | undefined;
  function getGate(): UpdateGate {
    if (!gate) {
      gate = new UpdateGate(os.getDatabase(), os.getClock());
    }
    return gate;
  }

  function parseJsonValue(raw: string | null | undefined): unknown {
    if (raw === undefined || raw === null || raw === '') return undefined;
    try {
      return JSON.parse(raw);
    } catch {
      throw new ValidationError('pending_updates 值不是有效 JSON', ErrorCode.VALIDATION_FORMAT);
    }
  }

  function applyPendingUpdate(update: PendingUpdate): void {
    const proposed = parseJsonValue(update.proposedValue);
    if (!proposed || typeof proposed !== 'object') {
      throw new ValidationError(`pending_updates ${update.id} 缺少有效 proposed_value`, ErrorCode.VALIDATION_FORMAT);
    }
    const patch = proposed as Record<string, unknown>;

    if (update.layer === 'L1') {
      const value = os.core.updateValueParams(update.targetId, {
        weight: typeof patch.weight === 'number' ? patch.weight : undefined,
        timeDiscount: typeof patch.timeDiscount === 'number' ? patch.timeDiscount : undefined,
        emotionAmplifier: typeof patch.emotionAmplifier === 'number' ? patch.emotionAmplifier : undefined,
      });
      if (!value) {
        throw new NotFoundError(`价值 ${update.targetId} 不存在`, ErrorCode.NOT_FOUND_VALUE);
      }
      return;
    }

    const anchorPatch: SurvivalAnchorUpdate = {
      label: typeof patch.label === 'string' ? patch.label : undefined,
      kind: typeof patch.kind === 'string' ? patch.kind as SurvivalAnchorUpdate['kind'] : undefined,
      severity: typeof patch.severity === 'number' ? patch.severity : undefined,
      ...(Object.prototype.hasOwnProperty.call(patch, 'value') ? { value: patch.value } : {}),
    };
    const anchor = os.core.updateSurvivalAnchor(update.targetId, anchorPatch);
    if (!anchor) {
      throw new NotFoundError(`生存锚点 ${update.targetId} 不存在`, ErrorCode.NOT_FOUND_SURVIVAL_ANCHOR);
    }
  }

  // ===== L0 生存锚点 =====

  /* GET /api/v1/pos/survival — 列出所有生存锚点 */
  app.get('/api/v1/pos/survival', async () => {
    return { data: os.core.survival.getAll() };
  });

  /* POST /api/v1/pos/survival — 添加锚点 */
  app.post('/api/v1/pos/survival', async (request) => {
    const body = CreateSurvivalAnchorSchema.parse(request.body);
    const anchor = os.core.addSurvivalAnchor(body.label, body.kind, body.value, body.severity);
    return { data: anchor };
  });

  /* PATCH /api/v1/pos/survival/:id — 更新锚点 */
  app.patch<{ Params: { id: string } }>('/api/v1/pos/survival/:id', async (request) => {
    const { id } = request.params;
    const body = UpdateSurvivalAnchorSchema.parse(request.body);
    const anchor = os.core.updateSurvivalAnchor(id, body);
    if (!anchor) {
      throw new NotFoundError(`生存锚点 ${id} 不存在`, ErrorCode.NOT_FOUND_SURVIVAL_ANCHOR);
    }
    return { data: anchor };
  });

  /* DELETE /api/v1/pos/survival/:id — 删除锚点 */
  app.delete<{ Params: { id: string } }>('/api/v1/pos/survival/:id', async (request) => {
    const { id } = request.params;
    const deleted = os.core.deleteSurvivalAnchor(id);
    if (!deleted) {
      throw new NotFoundError(`生存锚点 ${id} 不存在`, ErrorCode.NOT_FOUND_SURVIVAL_ANCHOR);
    }
    return { data: { id, deleted: true } };
  });

  // ===== L2 决策风格 =====

  /* GET /api/v1/pos/decision-style — 获取决策风格 */
  app.get('/api/v1/pos/decision-style', async () => {
    return { data: os.core.decisionStyle.get() };
  });

  /* PUT /api/v1/pos/decision-style — 设置决策风格 */
  app.put('/api/v1/pos/decision-style', async (request) => {
    const body = UpdateDecisionStyleSchema.parse(request.body);
    const style = os.core.setDecisionStyle(body);
    return { data: style };
  });

  // ===== L3 认知模型 =====

  /* GET /api/v1/pos/cognitive-model — 获取认知模型 */
  app.get('/api/v1/pos/cognitive-model', async () => {
    const model = os.core.cognitiveModel.get();
    return {
      data: {
        beliefs: Object.fromEntries(model.beliefs),
        biasWeights: Object.fromEntries(model.biasWeights),
        attributionStyle: model.attributionStyle,
        growthMindset: model.growthMindset,
        updatedAt: model.updatedAt,
      },
    };
  });

  /* PUT /api/v1/pos/cognitive-model — 设置认知模型 */
  app.put('/api/v1/pos/cognitive-model', async (request) => {
    const body = UpdateCognitiveModelSchema.parse(request.body);
    const model = os.core.setCognitiveModel({
      attributionStyle: body.attributionStyle,
      growthMindset: body.growthMindset,
      ...(body.beliefs ? { beliefs: new Map(Object.entries(body.beliefs)) } : {}),
      ...(body.biasWeights ? { biasWeights: new Map(Object.entries(body.biasWeights)) } : {}),
    });
    return {
      data: {
        beliefs: Object.fromEntries(model.beliefs),
        biasWeights: Object.fromEntries(model.biasWeights),
        attributionStyle: model.attributionStyle,
        growthMindset: model.growthMindset,
        updatedAt: model.updatedAt,
      },
    };
  });

  // ===== 更新闸门 =====

  /* GET /api/v1/pos/pending-updates — 获取待确认更新 */
  app.get('/api/v1/pos/pending-updates', async () => {
    return { data: getGate().getPending() };
  });

  /* POST /api/v1/pos/pending-updates/:id/approve — 审批并应用 */
  app.post<{ Params: { id: string } }>('/api/v1/pos/pending-updates/:id/approve', async (request) => {
    const { id } = request.params;
    const gate = getGate();
    const pending = gate.getById(id);
    if (!pending) {
      throw new NotFoundError(`待确认更新 ${id} 不存在`, ErrorCode.NOT_FOUND_TASK);
    }
    applyPendingUpdate(pending);
    const update = gate.approve(id);
    return { data: update };
  });

  /* POST /api/v1/pos/pending-updates/:id/reject — 拒绝更新 */
  app.post<{ Params: { id: string } }>('/api/v1/pos/pending-updates/:id/reject', async (request) => {
    const { id } = request.params;
    const update = getGate().reject(id);
    if (!update) {
      throw new NotFoundError(`待确认更新 ${id} 不存在`, ErrorCode.NOT_FOUND_TASK);
    }
    return { data: update };
  });

  // ===== 完整状态 =====

  /* GET /api/v1/pos/state — 获取完整 P-OS 五层状态 */
  app.get('/api/v1/pos/state', async () => {
    const state = compilePersonaState(os.core);
    return {
      data: {
        L0: state.L0,
        L1: [...state.L1.values()],
        L2: state.L2,
        L3: {
          beliefs: Object.fromEntries(state.L3.beliefs),
          biasWeights: Object.fromEntries(state.L3.biasWeights),
          attributionStyle: state.L3.attributionStyle,
          growthMindset: state.L3.growthMindset,
          updatedAt: state.L3.updatedAt,
        },
        L4: {
          narrative: state.L4.narrative,
          memoryCount: state.L4.memories.size,
          edgeCount: state.L4.edges.length,
        },
      },
    };
  });

  /* GET /api/v1/pos/state/summary — 获取 prompt-ready 文本摘要 */
  app.get('/api/v1/pos/state/summary', async () => {
    const state = compilePersonaState(os.core);
    return { data: { summary: summarizeForPrompt(state) } };
  });
}

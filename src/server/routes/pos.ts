/**
 * P-OS (人格操作系统) 路由
 * L0 生存锚点 | L2 决策风格 | L3 认知模型 | 完整状态
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ChronoSynthOS } from '../../chrono-synth-os.js';
import type { TenantOSFactory } from '../../multi-tenant/tenant-os-factory.js';
import { NotFoundError, ValidationError, ErrorCode } from '../../errors/index.js';
import { compilePersonaState, summarizeForPrompt } from '../../intelligence/persona-state.js';
import type { PendingUpdate } from '../../meta/update-gate.js';
import type { SurvivalAnchorUpdate } from '../../core/survival-anchor-store.js';
import {
  CreateSurvivalAnchorSchema,
  UpdateSurvivalAnchorSchema,
  UpdateDecisionStyleSchema,
  UpdateCognitiveModelSchema,
  PaginationQuerySchema,
} from '../schemas/api-schemas.js';

export function registerPosRoutes(app: FastifyInstance, os: ChronoSynthOS, tenantFactory?: TenantOSFactory): void {
  function getOS(request: FastifyRequest): ChronoSynthOS {
    const tid = request.tenantId;
    if (tenantFactory && tid && tid !== 'default') return tenantFactory.getTenantOS(tid);
    return os;
  }

  function parseJsonValue(raw: string | null | undefined): unknown {
    if (raw === undefined || raw === null || raw === '') return undefined;
    try {
      return JSON.parse(raw);
    } catch {
      throw new ValidationError('pending_updates 值不是有效 JSON', ErrorCode.VALIDATION_FORMAT);
    }
  }

  function applyPendingUpdate(update: PendingUpdate, tenantOS: ChronoSynthOS): void {
    const proposed = parseJsonValue(update.proposedValue);
    if (!proposed || typeof proposed !== 'object') {
      throw new ValidationError(`pending_updates ${update.id} 缺少有效 proposed_value`, ErrorCode.VALIDATION_FORMAT);
    }
    const patch = proposed as Record<string, unknown>;

    if (update.layer === 'L1') {
      const value = tenantOS.core.updateValueParams(update.targetId, {
        weight: typeof patch.weight === 'number' ? patch.weight : undefined,
        timeDiscount: typeof patch.timeDiscount === 'number' ? patch.timeDiscount : undefined,
        emotionAmplifier: typeof patch.emotionAmplifier === 'number' ? patch.emotionAmplifier : undefined,
      });
      if (!value) {
        throw new NotFoundError(`价值 ${update.targetId} 不存在`, ErrorCode.NOT_FOUND_VALUE);
      }
      return;
    }

    if (update.layer !== 'L0') {
      throw new ValidationError(`不支持的层级: ${update.layer}`, ErrorCode.VALIDATION_FORMAT);
    }

    const VALID_KINDS = new Set(['constraint', 'threshold', 'must_have']);
    const anchorPatch: SurvivalAnchorUpdate = {
      label: typeof patch.label === 'string' ? patch.label : undefined,
      kind: typeof patch.kind === 'string' && VALID_KINDS.has(patch.kind) ? patch.kind as SurvivalAnchorUpdate['kind'] : undefined,
      severity: typeof patch.severity === 'number' ? patch.severity : undefined,
      ...(Object.prototype.hasOwnProperty.call(patch, 'value') ? { value: patch.value } : {}),
    };
    const anchor = tenantOS.core.updateSurvivalAnchor(update.targetId, anchorPatch);
    if (!anchor) {
      throw new NotFoundError(`生存锚点 ${update.targetId} 不存在`, ErrorCode.NOT_FOUND_SURVIVAL_ANCHOR);
    }
  }

  // ===== L0 生存锚点 =====

  /* GET /api/v1/pos/survival — 列出所有生存锚点（分页） */
  app.get('/api/v1/pos/survival', async (request) => {
    const tenantOS = getOS(request);
    const all = tenantOS.core.survival.getAll();
    const { page, pageSize } = PaginationQuerySchema.parse(request.query);
    const offset = (page - 1) * pageSize;
    return {
      data: all.slice(offset, offset + pageSize),
      pagination: { page, pageSize, total: all.length, totalPages: Math.ceil(all.length / pageSize) || 1 },
    };
  });

  /* POST /api/v1/pos/survival — 添加锚点 */
  app.post('/api/v1/pos/survival', async (request, reply) => {
    const body = CreateSurvivalAnchorSchema.parse(request.body);
    const tenantOS = getOS(request);
    const anchor = tenantOS.core.addSurvivalAnchor(body.label, body.kind, body.value, body.severity);
    return reply.status(201).send({ data: anchor });
  });

  /* PATCH /api/v1/pos/survival/:id — 更新锚点（L0 通过 UpdateGate 路由） */
  app.patch<{ Params: { id: string } }>('/api/v1/pos/survival/:id', async (request, reply) => {
    const { id } = request.params;
    const body = UpdateSurvivalAnchorSchema.parse(request.body);
    const tenantOS = getOS(request);

    const current = tenantOS.core.survival.getAll().find(a => a.id === id);
    if (!current) {
      throw new NotFoundError(`生存锚点 ${id} 不存在`, ErrorCode.NOT_FOUND_SURVIVAL_ANCHOR);
    }

    const delta = body.severity !== undefined ? body.severity - current.severity : 0;
    const result = tenantOS.updateGate.tryApply(
      'L0',
      'user_confirmation',
      id,
      JSON.stringify({ label: current.label, kind: current.kind, severity: current.severity }),
      JSON.stringify(body),
      delta,
      '用户更新生存锚点',
      () => { tenantOS.core.updateSurvivalAnchor(id, body); },
    );

    if (result.applied) {
      const updated = tenantOS.core.survival.getAll().find(a => a.id === id);
      if (!updated) throw new NotFoundError(`生存锚点 ${id} 不存在`, ErrorCode.NOT_FOUND_SURVIVAL_ANCHOR);
      return { data: updated };
    }
    return reply.status(202).send({ data: result.pendingUpdate, message: '变更需要确认' });
  });

  /* DELETE /api/v1/pos/survival/:id — 删除锚点 */
  app.delete<{ Params: { id: string } }>('/api/v1/pos/survival/:id', async (request) => {
    const { id } = request.params;
    const tenantOS = getOS(request);
    const deleted = tenantOS.core.deleteSurvivalAnchor(id);
    if (!deleted) {
      throw new NotFoundError(`生存锚点 ${id} 不存在`, ErrorCode.NOT_FOUND_SURVIVAL_ANCHOR);
    }
    return { data: { id, deleted: true } };
  });

  // ===== L2 决策风格 =====

  /* GET /api/v1/pos/decision-style — 获取决策风格 */
  app.get('/api/v1/pos/decision-style', async (request) => {
    const tenantOS = getOS(request);
    return { data: tenantOS.core.decisionStyle.get() };
  });

  /* PUT /api/v1/pos/decision-style — 设置决策风格 */
  app.put('/api/v1/pos/decision-style', async (request) => {
    const body = UpdateDecisionStyleSchema.parse(request.body);
    const tenantOS = getOS(request);
    const style = tenantOS.core.setDecisionStyle(body);
    return { data: style };
  });

  // ===== L3 认知模型 =====

  /* GET /api/v1/pos/cognitive-model — 获取认知模型 */
  app.get('/api/v1/pos/cognitive-model', async (request) => {
    const tenantOS = getOS(request);
    const model = tenantOS.core.cognitiveModel.get();
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
    const tenantOS = getOS(request);
    const model = tenantOS.core.setCognitiveModel({
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

  /* GET /api/v1/pos/pending-updates — 获取待确认更新（分页） */
  app.get('/api/v1/pos/pending-updates', async (request) => {
    const tenantOS = getOS(request);
    const all = tenantOS.updateGate.getPending();
    const { page, pageSize } = PaginationQuerySchema.parse(request.query);
    const offset = (page - 1) * pageSize;
    return {
      data: all.slice(offset, offset + pageSize),
      pagination: { page, pageSize, total: all.length, totalPages: Math.ceil(all.length / pageSize) || 1 },
    };
  });

  /* POST /api/v1/pos/pending-updates/:id/approve — 审批并应用 */
  app.post<{ Params: { id: string } }>('/api/v1/pos/pending-updates/:id/approve', async (request) => {
    const { id } = request.params;
    const tenantOS = getOS(request);
    const pending = tenantOS.updateGate.getById(id);
    if (!pending) {
      throw new NotFoundError(`待确认更新 ${id} 不存在`, ErrorCode.NOT_FOUND_PENDING_UPDATE);
    }
    applyPendingUpdate(pending, tenantOS);
    const update = tenantOS.updateGate.approve(id);
    return { data: update };
  });

  /* POST /api/v1/pos/pending-updates/:id/reject — 拒绝更新 */
  app.post<{ Params: { id: string } }>('/api/v1/pos/pending-updates/:id/reject', async (request) => {
    const { id } = request.params;
    const tenantOS = getOS(request);
    const update = tenantOS.updateGate.reject(id);
    if (!update) {
      throw new NotFoundError(`待确认更新 ${id} 不存在`, ErrorCode.NOT_FOUND_PENDING_UPDATE);
    }
    return { data: update };
  });

  // ===== 完整状态 =====

  /* GET /api/v1/pos/state — 获取完整 P-OS 五层状态 */
  app.get('/api/v1/pos/state', async (request) => {
    const tenantOS = getOS(request);
    const state = compilePersonaState(tenantOS.core);
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
  app.get('/api/v1/pos/state/summary', async (request) => {
    const tenantOS = getOS(request);
    const state = compilePersonaState(tenantOS.core);
    return { data: { summary: summarizeForPrompt(state) } };
  });
}

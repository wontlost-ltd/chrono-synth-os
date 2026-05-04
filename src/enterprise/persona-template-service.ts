/**
 * 岗位人格模板服务（P1-A）
 *
 * 职责：
 *  1. CRUD：列表 / 读取 / 创建 / 更新 / 删除自定义模板（内置模板只读）
 *  2. 实例化：从模板创建一个具体 persona_core，注入 behaviorBoundaries
 *     至 persona profile，并把 defaultValues 作为价值锚点初始知识
 *  3. 启动期同步：把内置模板内容刷新到 DB（增量升级，无需迁移）
 *
 * 设计：模板表不进入 TenantDatabase 自动重写——查询时显式包含调用者
 *      tenant_id 和内置哨兵 BUILTIN_TENANT_ID。
 */

import type { IDatabase } from '../storage/database.js';
import { unwrapDb, type UowOrDb } from '../storage/uow-helpers.js';
import type { PersonaCoreService } from '../persona-core/persona-core-service.js';
import type { PersonaCoreDetail } from '../persona-core/types.js';
import { generatePrefixedId } from '../utils/id-generator.js';
import { recordBusinessAuditLog } from '../audit/audit-log-store.js';
import {
  BUILTIN_TEMPLATE_SEEDS,
  BUILTIN_TENANT_ID,
  isValidCategory,
  renderTemplateString,
  type BehaviorBoundary,
  type PersonaTemplate,
  type PersonaTemplateCategory,
  type TemplateValueAnchor,
} from './persona-template-catalog.js';

export interface CreateTemplateInput {
  category: PersonaTemplateCategory;
  label: string;
  description?: string;
  defaultValues?: TemplateValueAnchor[];
  defaultNarrative?: string;
  behaviorBoundaries?: BehaviorBoundary[];
  requiredKnowledgeCategories?: string[];
}

export interface PatchTemplateInput {
  label?: string;
  description?: string;
  defaultValues?: TemplateValueAnchor[];
  defaultNarrative?: string;
  behaviorBoundaries?: BehaviorBoundary[];
  requiredKnowledgeCategories?: string[];
}

export interface InstantiateTemplateInput {
  tenantId: string;
  ownerUserId: string;
  templateId: string;
  displayName: string;
  overrideValues?: TemplateValueAnchor[];
  overrideNarrative?: string;
  /** 用于渲染模板文案中 {{variable}} 占位符的键值映射 */
  templateVariables?: Record<string, string>;
  initialKnowledge?: Array<{
    title: string;
    content: string;
    source?: string;
    tags?: string[];
    confidence?: number;
  }>;
}

export interface InstantiateTemplateResult {
  persona: PersonaCoreDetail;
  templateId: string;
  instantiatedFromCategory: PersonaTemplateCategory;
}

interface TemplateRow {
  id: string;
  tenant_id: string;
  category: string;
  label: string;
  description: string;
  default_values_json: string;
  default_narrative: string;
  behavior_boundaries_json: string;
  required_knowledge_categories_json: string;
  is_builtin: number;
  created_at: number;
  updated_at: number;
}

/** 错误类型：模板不存在 */
export class PersonaTemplateNotFoundError extends Error {
  constructor(templateId: string) {
    super(`Persona template not found: ${templateId}`);
    this.name = 'PersonaTemplateNotFoundError';
  }
}

/** 错误类型：尝试修改/删除内置模板 */
export class BuiltInTemplateImmutableError extends Error {
  constructor(templateId: string) {
    super(`Cannot modify or delete built-in template: ${templateId}`);
    this.name = 'BuiltInTemplateImmutableError';
  }
}

export class PersonaTemplateService {
  private readonly db: IDatabase | null;

  constructor(
    uowOrDb: UowOrDb,
    private readonly personaCoreService: PersonaCoreService,
  ) {
    this.db = unwrapDb(uowOrDb);
  }

  private requireDb(method: string): IDatabase {
    if (!this.db) {
      throw new Error(
        `PersonaTemplateService.${method} requires IDatabase entrance (raw SQL not yet routed via kernel commands)`,
      );
    }
    return this.db;
  }

  /** 启动期：把内置模板内容刷新到 DB（INSERT OR REPLACE） */
  syncBuiltins(): void {
    const now = Date.now();
    const stmt = this.requireDb('syncBuiltins').prepare<void>(
      `INSERT OR REPLACE INTO persona_templates
        (id, tenant_id, category, label, description,
         default_values_json, default_narrative, behavior_boundaries_json,
         required_knowledge_categories_json, is_builtin, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    );
    for (const seed of BUILTIN_TEMPLATE_SEEDS) {
      stmt.run(
        seed.id,
        seed.tenantId,
        seed.category,
        seed.label,
        seed.description,
        JSON.stringify(seed.defaultValues),
        seed.defaultNarrative,
        JSON.stringify(seed.behaviorBoundaries),
        JSON.stringify(seed.requiredKnowledgeCategories),
        now,
        now,
      );
    }
  }

  /** 列出当前租户可见的所有模板（内置 + 自定义） */
  list(tenantId: string): PersonaTemplate[] {
    const rows = this.requireDb('list').prepare<TemplateRow>(
      `SELECT * FROM persona_templates
        WHERE tenant_id = ? OR tenant_id = ?
        ORDER BY is_builtin DESC, category ASC, label ASC`,
    ).all(tenantId, BUILTIN_TENANT_ID);
    return rows.map(rowToTemplate);
  }

  /** 读取单个模板（必须属于调用者或内置） */
  get(tenantId: string, templateId: string): PersonaTemplate | null {
    const row = this.requireDb('get').prepare<TemplateRow>(
      `SELECT * FROM persona_templates
        WHERE id = ? AND (tenant_id = ? OR tenant_id = ?)`,
    ).get(templateId, tenantId, BUILTIN_TENANT_ID);
    return row ? rowToTemplate(row) : null;
  }

  /** 创建自定义模板 */
  create(tenantId: string, input: CreateTemplateInput): PersonaTemplate {
    if (!isValidCategory(input.category)) {
      throw new Error(`Invalid category: ${input.category}`);
    }
    const id = generatePrefixedId('tpl');
    const now = Date.now();
    const template: PersonaTemplate = {
      id,
      tenantId,
      category: input.category,
      label: input.label,
      description: input.description ?? '',
      defaultValues: input.defaultValues ?? [],
      defaultNarrative: input.defaultNarrative ?? '',
      behaviorBoundaries: input.behaviorBoundaries ?? [],
      requiredKnowledgeCategories: input.requiredKnowledgeCategories ?? [],
      isBuiltIn: false,
      createdAt: now,
      updatedAt: now,
    };

    this.requireDb('create').prepare<void>(
      `INSERT INTO persona_templates
        (id, tenant_id, category, label, description,
         default_values_json, default_narrative, behavior_boundaries_json,
         required_knowledge_categories_json, is_builtin, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    ).run(
      template.id,
      template.tenantId,
      template.category,
      template.label,
      template.description,
      JSON.stringify(template.defaultValues),
      template.defaultNarrative,
      JSON.stringify(template.behaviorBoundaries),
      JSON.stringify(template.requiredKnowledgeCategories),
      template.createdAt,
      template.updatedAt,
    );

    return template;
  }

  /** 更新自定义模板（拒绝内置） */
  update(tenantId: string, templateId: string, input: PatchTemplateInput): PersonaTemplate {
    const existing = this.get(tenantId, templateId);
    if (!existing) throw new PersonaTemplateNotFoundError(templateId);
    if (existing.isBuiltIn) throw new BuiltInTemplateImmutableError(templateId);

    const next: PersonaTemplate = {
      ...existing,
      label: input.label ?? existing.label,
      description: input.description ?? existing.description,
      defaultValues: input.defaultValues ?? existing.defaultValues,
      defaultNarrative: input.defaultNarrative ?? existing.defaultNarrative,
      behaviorBoundaries: input.behaviorBoundaries ?? existing.behaviorBoundaries,
      requiredKnowledgeCategories: input.requiredKnowledgeCategories ?? existing.requiredKnowledgeCategories,
      updatedAt: Date.now(),
    };

    this.requireDb('update').prepare<void>(
      `UPDATE persona_templates
          SET label = ?, description = ?,
              default_values_json = ?, default_narrative = ?,
              behavior_boundaries_json = ?, required_knowledge_categories_json = ?,
              updated_at = ?
        WHERE id = ? AND tenant_id = ?`,
    ).run(
      next.label,
      next.description,
      JSON.stringify(next.defaultValues),
      next.defaultNarrative,
      JSON.stringify(next.behaviorBoundaries),
      JSON.stringify(next.requiredKnowledgeCategories),
      next.updatedAt,
      next.id,
      tenantId,
    );

    return next;
  }

  /** 删除自定义模板（拒绝内置） */
  delete(tenantId: string, templateId: string): void {
    const existing = this.get(tenantId, templateId);
    if (!existing) throw new PersonaTemplateNotFoundError(templateId);
    if (existing.isBuiltIn) throw new BuiltInTemplateImmutableError(templateId);

    this.requireDb('delete').prepare<void>(
      'DELETE FROM persona_templates WHERE id = ? AND tenant_id = ?',
    ).run(templateId, tenantId);
  }

  /** 从模板实例化一个 persona_core */
  instantiate(input: InstantiateTemplateInput): InstantiateTemplateResult {
    const template = this.get(input.tenantId, input.templateId);
    if (!template) throw new PersonaTemplateNotFoundError(input.templateId);

    const vars = input.templateVariables ?? {};
    const valueAnchors = input.overrideValues ?? template.defaultValues;
    const renderedNarrative = renderTemplateString(
      input.overrideNarrative ?? template.defaultNarrative,
      vars,
    );
    const renderedBoundaries: BehaviorBoundary[] = template.behaviorBoundaries.map((b) => ({
      rule: b.rule,
      topic: renderTemplateString(b.topic, vars),
    }));

    /* 合成初始知识：模板的价值锚点 + 调用方提供的额外条目 */
    const valueKnowledge = valueAnchors.map((v) => ({
      title: `价值锚点：${v.label}`,
      content: `这是一项核心价值，权重 ${v.weight.toFixed(2)}。在做决策时优先考虑该价值。`,
      source: 'persona_template_seed',
      tags: ['value_anchor', template.category],
      confidence: Math.max(0, Math.min(1, v.weight)),
    }));
    const initialKnowledge = [...valueKnowledge, ...(input.initialKnowledge ?? [])];

    /* 把模板元信息注入 persona profile，对话引擎后续从这里读取行为约束 */
    const profile: Record<string, unknown> = {
      templateId: template.id,
      templateCategory: template.category,
      templateLabel: template.label,
      narrative: renderedNarrative,
      behaviorBoundaries: renderedBoundaries,
      requiredKnowledgeCategories: template.requiredKnowledgeCategories,
      templateVariables: vars,
    };

    const persona = this.personaCoreService.createPersona({
      tenantId: input.tenantId,
      ownerUserId: input.ownerUserId,
      displayName: input.displayName,
      profile,
      visibility: 'private',
      initialKnowledge,
    });

    if (this.db) {
      recordBusinessAuditLog(this.db, {
        tenantId: input.tenantId,
        actorType: 'user',
        actorId: input.ownerUserId,
        actionType: 'persona_template.instantiated',
        targetType: 'persona_core',
        targetId: persona.id,
        payload: {
          templateId: template.id,
          templateCategory: template.category,
          valueAnchorCount: valueAnchors.length,
          initialKnowledgeCount: initialKnowledge.length,
          templateVariableKeys: Object.keys(vars),
        },
      });
    }

    return {
      persona,
      templateId: template.id,
      instantiatedFromCategory: template.category,
    };
  }
}

function rowToTemplate(row: TemplateRow): PersonaTemplate {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    category: row.category as PersonaTemplateCategory,
    label: row.label,
    description: row.description,
    defaultValues: safeJsonArray<TemplateValueAnchor>(row.default_values_json),
    defaultNarrative: row.default_narrative,
    behaviorBoundaries: safeJsonArray<BehaviorBoundary>(row.behavior_boundaries_json),
    requiredKnowledgeCategories: safeJsonArray<string>(row.required_knowledge_categories_json),
    isBuiltIn: row.is_builtin === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function safeJsonArray<T>(json: string): T[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

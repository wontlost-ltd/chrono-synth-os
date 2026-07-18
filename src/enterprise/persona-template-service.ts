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

import type { SyncWriteUnitOfWork, PtplRow } from '@chrono/kernel';
import {
  ptplQueryList, ptplQueryById,
  ptplCmdUpsertBuiltin, ptplCmdInsert, ptplCmdUpdate, ptplCmdDelete,
} from '@chrono/kernel';
import { registerCoreSelfExecutors } from '../storage/executors/index.js';
import type { TenantDbResolver } from '../storage/tenant-db-resolver.js';
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

/**
 * 内部 db 取源：resolver 模式按 tenantId 解析对应 shard；UoW 模式固定该事务。
 * 与 PersonaCoreSource 同构（分片地基 Phase 0 双入口范式），facade 与共享的
 * PersonaCoreService 传同一 resolver 才能保证 instantiate 级联落同一 shard。
 */
interface TemplateSource {
  /** per-tenant 操作取 db（单库 / UoW 模式恒返同一 db）。 */
  forTenant(tenantId: string): SyncWriteUnitOfWork;
  /** cross-tenant fan-out 的所有 shard db（UoW 模式返 [tx]）。syncBuiltins 用。 */
  allDbs(): SyncWriteUnitOfWork[];
}

export class PersonaTemplateService {
  /**
   * 私有构造器（双入口化）：只收 source，配合 fromResolver/fromUnitOfWork。
   * source 化后 CRUD/syncBuiltins/instantiate 按需解析 db，而非构造期绑单一 tx。
   */
  private constructor(
    private readonly source: TemplateSource,
    private readonly personaCoreService: PersonaCoreService,
  ) {
    registerCoreSelfExecutors();
  }

  /**
   * resolver 模式：per-tenant 经 resolver.dbForTenant(tenantId) 选 shard db；
   * cross-tenant（syncBuiltins）经 allShardDbs() fan-out。
   */
  static fromResolver(resolver: TenantDbResolver, personaCoreService: PersonaCoreService): PersonaTemplateService {
    return new PersonaTemplateService(
      { forTenant: (tenantId) => resolver.dbForTenant(tenantId), allDbs: () => resolver.allShardDbs() },
      personaCoreService,
    );
  }

  /**
   * bound-UoW 模式：forTenant 忽略 tenantId 恒返该事务，allDbs()=[tx]（结构上不脱离事务）。
   */
  static fromUnitOfWork(tx: SyncWriteUnitOfWork, personaCoreService: PersonaCoreService): PersonaTemplateService {
    return new PersonaTemplateService({ forTenant: () => tx, allDbs: () => [tx] }, personaCoreService);
  }

  /** db-bound 读 helper（public get + update/delete/instantiate 共用，兑现「解析一次」）。 */
  private getFromDb(db: SyncWriteUnitOfWork, tenantId: string, templateId: string): PersonaTemplate | null {
    const row = db.queryOne(ptplQueryById({ templateId, tenantId, builtinTenantId: BUILTIN_TENANT_ID }));
    return row ? rowToTemplate(row) : null;
  }

  /** 启动期：把内置模板内容刷新到 DB（INSERT OR REPLACE）。
   *  cross-tenant fan-out：每 shard 一份（list/get 单-SQL `OR '__builtin__'` 要求内置模板
   *  与租户模板同 shard）。逐 shard 尝试聚合 errors（启动 seed 语义，任一失败则抛，非静默隔离）。 */
  syncBuiltins(): void {
    const now = Date.now();
    const errors: { shard: string; error: string }[] = [];
    const dbs = this.source.allDbs();
    for (let i = 0; i < dbs.length; i++) {
      try {
        for (const seed of BUILTIN_TEMPLATE_SEEDS) {
          dbs[i]!.execute(ptplCmdUpsertBuiltin({
            id: seed.id,
            tenantId: seed.tenantId,
            category: seed.category,
            label: seed.label,
            description: seed.description,
            defaultValuesJson: JSON.stringify(seed.defaultValues),
            defaultNarrative: seed.defaultNarrative,
            behaviorBoundariesJson: JSON.stringify(seed.behaviorBoundaries),
            requiredKnowledgeCategoriesJson: JSON.stringify(seed.requiredKnowledgeCategories),
            now,
          }));
        }
      } catch (err) {
        errors.push({ shard: String(i), error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (errors.length > 0) {
      throw new Error(
        `syncBuiltins 部分 shard 失败（启动 seed 须全成功）: ${errors.map((e) => `shard ${e.shard}: ${e.error}`).join('; ')}`,
      );
    }
  }

  /** 列出当前租户可见的所有模板（内置 + 自定义） */
  list(tenantId: string): PersonaTemplate[] {
    const rows = this.source.forTenant(tenantId).queryMany(ptplQueryList({ tenantId, builtinTenantId: BUILTIN_TENANT_ID }));
    return rows.map(rowToTemplate);
  }

  /** 读取单个模板（必须属于调用者或内置） */
  get(tenantId: string, templateId: string): PersonaTemplate | null {
    return this.getFromDb(this.source.forTenant(tenantId), tenantId, templateId);
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

    this.source.forTenant(tenantId).execute(ptplCmdInsert({
      id: template.id,
      tenantId: template.tenantId,
      category: template.category,
      label: template.label,
      description: template.description,
      defaultValuesJson: JSON.stringify(template.defaultValues),
      defaultNarrative: template.defaultNarrative,
      behaviorBoundariesJson: JSON.stringify(template.behaviorBoundaries),
      requiredKnowledgeCategoriesJson: JSON.stringify(template.requiredKnowledgeCategories),
      createdAt: template.createdAt,
      updatedAt: template.updatedAt,
    }));

    return template;
  }

  /** 更新自定义模板（拒绝内置） */
  update(tenantId: string, templateId: string, input: PatchTemplateInput): PersonaTemplate {
    const db = this.source.forTenant(tenantId);
    const existing = this.getFromDb(db, tenantId, templateId);
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

    db.execute(ptplCmdUpdate({
      id: next.id,
      tenantId,
      label: next.label,
      description: next.description,
      defaultValuesJson: JSON.stringify(next.defaultValues),
      defaultNarrative: next.defaultNarrative,
      behaviorBoundariesJson: JSON.stringify(next.behaviorBoundaries),
      requiredKnowledgeCategoriesJson: JSON.stringify(next.requiredKnowledgeCategories),
      updatedAt: next.updatedAt,
    }));

    return next;
  }

  /** 删除自定义模板（拒绝内置） */
  delete(tenantId: string, templateId: string): void {
    const db = this.source.forTenant(tenantId);
    const existing = this.getFromDb(db, tenantId, templateId);
    if (!existing) throw new PersonaTemplateNotFoundError(templateId);
    if (existing.isBuiltIn) throw new BuiltInTemplateImmutableError(templateId);

    db.execute(ptplCmdDelete({ templateId, tenantId }));
  }

  /** 从模板实例化一个 persona_core */
  instantiate(input: InstantiateTemplateInput): InstantiateTemplateResult {
    const db = this.source.forTenant(input.tenantId);
    const template = this.getFromDb(db, input.tenantId, input.templateId);
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

    recordBusinessAuditLog(db, {
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

    return {
      persona,
      templateId: template.id,
      instantiatedFromCategory: template.category,
    };
  }
}

function rowToTemplate(row: PtplRow): PersonaTemplate {
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

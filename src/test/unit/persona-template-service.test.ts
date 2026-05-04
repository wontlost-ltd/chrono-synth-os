/**
 * 单元测试：PersonaTemplateService（P1-A）
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ChronoSynthOS } from '../../chrono-synth-os.js';
import { SilentLogger } from '../../utils/logger.js';
import { TestClock } from '../../utils/clock.js';
import { PersonaCoreService } from '../../persona-core/persona-core-service.js';
import {
  PersonaTemplateService,
  PersonaTemplateNotFoundError,
  BuiltInTemplateImmutableError,
} from '../../enterprise/persona-template-service.js';
import { BUILTIN_TEMPLATE_SEEDS } from '../../enterprise/persona-template-catalog.js';

describe('PersonaTemplateService', () => {
  let os: ChronoSynthOS;
  let service: PersonaTemplateService;
  const TEST_USER_ID = 'user_test_persona_owner';

  beforeEach(() => {
    os = new ChronoSynthOS({ clock: new TestClock(1000), logger: new SilentLogger() });
    os.start();
    const personaCoreService = new PersonaCoreService(os.getDatabase());
    service = new PersonaTemplateService(os.getDatabase(), personaCoreService);
    service.syncBuiltins();

    /* persona_core.owner_user_id 引用 users 表，instantiate 测试需要先建用户 */
    os.getDatabase().prepare<void>(
      `INSERT OR IGNORE INTO users (id, email, password_hash, role, tenant_id, created_at, updated_at)
       VALUES (?, ?, 'pw', 'admin', 'tenant_a', 1000, 1000)`,
    ).run(TEST_USER_ID, `${TEST_USER_ID}@test.com`);
  });

  afterEach(() => os.close());

  it('list 包含全部 6 个内置模板', () => {
    const templates = service.list('tenant_a');
    const builtins = templates.filter((t) => t.isBuiltIn);
    assert.equal(builtins.length, BUILTIN_TEMPLATE_SEEDS.length);
    const categories = new Set(builtins.map((t) => t.category));
    assert.ok(categories.has('customer_service'));
    assert.ok(categories.has('engineer'));
    assert.ok(categories.has('legal'));
    assert.ok(categories.has('sales'));
    assert.ok(categories.has('hr'));
    assert.ok(categories.has('finance'));
  });

  it('create 自定义模板被同租户列出，不被其他租户列出', () => {
    const tplA = service.create('tenant_a', {
      category: 'engineer',
      label: 'Acme 工程师',
      description: '内部工程团队定制',
    });
    assert.ok(!tplA.isBuiltIn);
    assert.equal(tplA.tenantId, 'tenant_a');

    const listA = service.list('tenant_a').filter((t) => !t.isBuiltIn);
    const listB = service.list('tenant_b').filter((t) => !t.isBuiltIn);
    assert.equal(listA.length, 1);
    assert.equal(listB.length, 0, '租户 B 不应看到租户 A 的自定义模板');
  });

  it('update 拒绝修改内置模板', () => {
    const builtin = service.list('tenant_a').find((t) => t.isBuiltIn);
    assert.ok(builtin);
    assert.throws(
      () => service.update('tenant_a', builtin.id, { label: '篡改' }),
      BuiltInTemplateImmutableError,
    );
  });

  it('delete 拒绝删除内置模板', () => {
    const builtin = service.list('tenant_a').find((t) => t.isBuiltIn);
    assert.ok(builtin);
    assert.throws(
      () => service.delete('tenant_a', builtin.id),
      BuiltInTemplateImmutableError,
    );
  });

  it('update 不存在的模板报错', () => {
    assert.throws(
      () => service.update('tenant_a', 'tpl_nonexistent', { label: 'x' }),
      PersonaTemplateNotFoundError,
    );
  });

  it('instantiate 创建 persona_core 并写入业务审计', () => {
    const result = service.instantiate({
      tenantId: 'tenant_a',
      ownerUserId: TEST_USER_ID,
      templateId: 'tpl_builtin_customer_service',
      displayName: 'Acme 客服-001',
    });

    assert.ok(result.persona.id.startsWith('pcore_'));
    assert.equal(result.templateId, 'tpl_builtin_customer_service');
    assert.equal(result.instantiatedFromCategory, 'customer_service');

    const profile = result.persona.profile as Record<string, unknown>;
    assert.equal(profile.templateId, 'tpl_builtin_customer_service');
    assert.equal(profile.templateCategory, 'customer_service');
    assert.ok(Array.isArray(profile.behaviorBoundaries));
    assert.ok((profile.behaviorBoundaries as unknown[]).length > 0);

    /* 校验审计日志 */
    const auditRows = os.getDatabase().prepare<{ action_type: string; target_id: string }>(
      `SELECT action_type, target_id FROM audit_log
        WHERE event_kind = 'business' AND action_type = 'persona_template.instantiated'
        ORDER BY created_at DESC LIMIT 1`,
    ).all();
    assert.equal(auditRows.length, 1);
    assert.equal(auditRows[0].target_id, result.persona.id);
  });

  it('instantiate overrideValues 覆盖默认价值锚点', () => {
    const result = service.instantiate({
      tenantId: 'tenant_a',
      ownerUserId: TEST_USER_ID,
      templateId: 'tpl_builtin_engineer',
      displayName: '自定义工程师',
      overrideValues: [{ label: '极简主义', weight: 0.95 }],
    });

    /* 初始知识中应包含被覆盖的价值锚点 */
    const knowledge = result.persona.knowledgeItems;
    const valueAnchors = knowledge.filter((k) => k.title.startsWith('价值锚点：'));
    assert.equal(valueAnchors.length, 1);
    assert.ok(valueAnchors[0].title.includes('极简主义'));
  });
});

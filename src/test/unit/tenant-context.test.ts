import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTenantId, runWithTenant, getTenantId, DEFAULT_TENANT_ID } from '../../multi-tenant/tenant-context.js';

describe('TenantContext', () => {
  describe('normalizeTenantId', () => {
    it('空值返回默认租户', () => {
      assert.equal(normalizeTenantId(undefined), DEFAULT_TENANT_ID);
      assert.equal(normalizeTenantId(null), DEFAULT_TENANT_ID);
      assert.equal(normalizeTenantId(''), DEFAULT_TENANT_ID);
      assert.equal(normalizeTenantId('  '), DEFAULT_TENANT_ID);
    });

    it('合法 ID 原样返回', () => {
      assert.equal(normalizeTenantId('tenant-1'), 'tenant-1');
      assert.equal(normalizeTenantId('my_tenant'), 'my_tenant');
      assert.equal(normalizeTenantId('ABC123'), 'ABC123');
    });

    it('非法 ID 抛出 RangeError', () => {
      assert.throws(() => normalizeTenantId('a'.repeat(65)), RangeError);
      assert.throws(() => normalizeTenantId('tenant id'), RangeError); /* 含空格 */
      assert.throws(() => normalizeTenantId('tenant@id'), RangeError); /* 含特殊字符 */
    });
  });

  describe('runWithTenant / getTenantId', () => {
    it('上下文外返回默认租户', () => {
      assert.equal(getTenantId(), DEFAULT_TENANT_ID);
    });

    it('上下文内返回指定租户', () => {
      runWithTenant('tenant-x', () => {
        assert.equal(getTenantId(), 'tenant-x');
      });
    });

    it('嵌套上下文内层覆盖外层', () => {
      runWithTenant('outer', () => {
        assert.equal(getTenantId(), 'outer');
        runWithTenant('inner', () => {
          assert.equal(getTenantId(), 'inner');
        });
        assert.equal(getTenantId(), 'outer');
      });
    });

    it('支持异步场景', async () => {
      await new Promise<void>((resolve) => {
        runWithTenant('async-tenant', () => {
          setTimeout(() => {
            assert.equal(getTenantId(), 'async-tenant');
            resolve();
          }, 10);
        });
      });
    });
  });
});

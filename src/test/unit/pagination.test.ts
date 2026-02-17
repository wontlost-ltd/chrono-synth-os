import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parsePagination, paginate } from '../../server/plugins/pagination.js';

describe('分页系统', () => {
  describe('parsePagination', () => {
    it('默认值：page=1, pageSize=20', () => {
      const p = parsePagination({});
      assert.equal(p.page, 1);
      assert.equal(p.pageSize, 20);
    });

    it('解析有效的 page 和 pageSize', () => {
      const p = parsePagination({ page: '3', pageSize: '10' });
      assert.equal(p.page, 3);
      assert.equal(p.pageSize, 10);
    });

    it('page 最小为 1', () => {
      const p = parsePagination({ page: '0' });
      assert.equal(p.page, 1);
    });

    it('pageSize 最大为 100', () => {
      const p = parsePagination({ pageSize: '200' });
      assert.equal(p.pageSize, 100);
    });

    it('无效值回退到默认', () => {
      const p = parsePagination({ page: 'abc', pageSize: 'xyz' });
      assert.equal(p.page, 1);
      assert.equal(p.pageSize, 20);
    });
  });

  describe('paginate', () => {
    const items = Array.from({ length: 50 }, (_, i) => i + 1);

    it('返回第一页数据', () => {
      const result = paginate(items, { page: 1, pageSize: 10 });
      assert.deepEqual(result.data, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      assert.equal(result.pagination.total, 50);
      assert.equal(result.pagination.totalPages, 5);
      assert.equal(result.pagination.page, 1);
      assert.equal(result.pagination.pageSize, 10);
    });

    it('返回中间页数据', () => {
      const result = paginate(items, { page: 3, pageSize: 10 });
      assert.deepEqual(result.data, [21, 22, 23, 24, 25, 26, 27, 28, 29, 30]);
    });

    it('最后一页可能不满', () => {
      const result = paginate(items, { page: 6, pageSize: 10 });
      assert.deepEqual(result.data, []);
    });

    it('空数组返回空结果和 totalPages=1', () => {
      const result = paginate([], { page: 1, pageSize: 10 });
      assert.deepEqual(result.data, []);
      assert.equal(result.pagination.total, 0);
      assert.equal(result.pagination.totalPages, 1);
    });

    it('pageSize 大于总数时返回所有数据', () => {
      const result = paginate([1, 2, 3], { page: 1, pageSize: 100 });
      assert.deepEqual(result.data, [1, 2, 3]);
      assert.equal(result.pagination.totalPages, 1);
    });
  });
});

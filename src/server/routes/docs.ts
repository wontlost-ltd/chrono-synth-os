/**
 * API 文档端点
 * 返回所有可用端点的描述和 schema 信息
 */

import type { FastifyInstance } from 'fastify';

const API_DOCS = {
  version: '0.4.0',
  endpoints: [
    {
      method: 'GET',
      path: '/healthz',
      description: '轻量探活检查',
      response_schema: { status: 'string' },
    },
    {
      method: 'GET',
      path: '/readyz',
      description: '深度就绪检查（含数据库断路器状态和 OS 状态）',
      response_schema: { status: 'string', components: 'object' },
    },
    {
      method: 'GET',
      path: '/metrics',
      description: '运行时指标（JSON 格式）',
      response_schema: { uptime_seconds: 'number', requests: 'object', business: 'object', system: 'object' },
    },
    {
      method: 'GET',
      path: '/metrics/prometheus',
      description: '运行时指标（Prometheus text exposition 格式）',
      response_schema: { content_type: 'text/plain; version=0.0.4' },
    },
    {
      method: 'POST',
      path: '/api/v1/values',
      description: '创建核心价值',
      request_schema: { label: 'string', weight: 'number (0-1)' },
      response_schema: { data: '{ id, label, weight }' },
    },
    {
      method: 'GET',
      path: '/api/v1/values',
      description: '获取所有核心价值（默认分页：?page=1&pageSize=20）',
      response_schema: { data: 'CoreValue[]', pagination: '{ page, pageSize, total, totalPages }' },
    },
    {
      method: 'PATCH',
      path: '/api/v1/values/:id',
      description: '更新核心价值权重',
      request_schema: { weight: 'number (0-1)' },
      response_schema: { data: '{ id, label, weight }' },
    },
    {
      method: 'POST',
      path: '/api/v1/memories',
      description: '创建记忆节点',
      request_schema: { kind: 'episodic|semantic|procedural', content: 'string', valence: 'number (-1~1)', salience: 'number (0-1)' },
      response_schema: { data: 'MemoryNode' },
    },
    {
      method: 'GET',
      path: '/api/v1/memories',
      description: '获取所有记忆节点（默认分页：?page=1&pageSize=20）',
      response_schema: { data: 'MemoryNode[]', pagination: '{ page, pageSize, total, totalPages }' },
    },
    {
      method: 'POST',
      path: '/api/v1/memories/link',
      description: '关联两个记忆节点',
      request_schema: { source: 'string', target: 'string', relation: 'string', strength: 'number (0-1)' },
      response_schema: { data: 'MemoryEdge' },
    },
    {
      method: 'PUT',
      path: '/api/v1/narrative',
      description: '更新系统叙事',
      request_schema: { content: 'string' },
      response_schema: { data: '{ content, previous }' },
    },
    {
      method: 'GET',
      path: '/api/v1/narrative',
      description: '获取当前叙事',
      response_schema: { data: '{ content }' },
    },
    {
      method: 'POST',
      path: '/api/v1/personas/fork',
      description: '从核心价值分叉新人格',
      request_schema: { label: 'string', resourceQuota: 'number (0-1, 默认 0.2)' },
      response_schema: { data: 'PersonaVersion' },
    },
    {
      method: 'POST',
      path: '/api/v1/personas/simulate',
      description: '运行人格模拟',
      request_schema: { personaId: 'string', scenario: '{ id, description, params }' },
      response_schema: { data: 'SimulationResult' },
    },
    {
      method: 'PATCH',
      path: '/api/v1/personas/:id/status',
      description: '更新人格状态',
      request_schema: { status: 'active|paused|completed|failed' },
      response_schema: { data: '{ id, status, updated }' },
    },
    {
      method: 'GET',
      path: '/api/v1/personas',
      description: '获取所有人格（支持分页：?page=1&pageSize=20）',
      response_schema: { data: 'PersonaVersion[]', pagination: '{ page, pageSize, total, totalPages }' },
    },
    {
      method: 'GET',
      path: '/api/v1/personas/:id',
      description: '获取单个人格详情',
      response_schema: { data: 'PersonaVersion' },
    },
    {
      method: 'POST',
      path: '/api/v1/snapshots',
      description: '创建系统快照',
      request_schema: { reason: 'scheduled|manual|pre_evolution|shutdown (默认 manual)' },
      response_schema: { data: '{ id, reason, createdAt }' },
    },
    {
      method: 'GET',
      path: '/api/v1/snapshots',
      description: '获取快照列表（支持分页：?page=1&pageSize=20）',
      response_schema: { data: 'SnapshotInfo[]', pagination: '{ page, pageSize, total, totalPages }' },
    },
    {
      method: 'POST',
      path: '/api/v1/snapshots/:id/restore',
      description: '从快照恢复系统状态',
      response_schema: { data: '{ restored, snapshotId }' },
    },
    {
      method: 'POST',
      path: '/api/v1/operations/evolution/run',
      description: '运行演化周期',
      response_schema: { data: '{ mergedCount, beforeSnapshotId, afterSnapshotId }' },
    },
    {
      method: 'POST',
      path: '/api/v1/operations/regulation/run',
      description: '运行调控周期',
      request_schema: { strategy: 'equal|fitness_weighted|priority_based (可选)' },
      response_schema: { data: '{ status, strategy }' },
    },
    {
      method: 'GET',
      path: '/api/v1/conflicts',
      description: '获取所有未解决冲突（默认分页：?page=1&pageSize=20）',
      response_schema: { data: 'Conflict[]', pagination: '{ page, pageSize, total, totalPages }' },
    },
    {
      method: 'PATCH',
      path: '/api/v1/conflicts/:id/resolve',
      description: '解决冲突',
      request_schema: { resolution: 'string' },
      response_schema: { data: '{ id, resolved, resolution }' },
    },
    {
      method: 'GET',
      path: '/api/v1/audit',
      description: '查询审计日志',
      request_schema: { limit: 'number (可选, 默认 100, 最大 1000)' },
      response_schema: { data: 'AuditEntry[]' },
    },
    {
      method: 'GET',
      path: '/api/v1/docs',
      description: 'API 文档（本端点）',
      response_schema: { data: '{ version, endpoints }' },
    },
    {
      method: 'GET',
      path: '/ws',
      description: 'WebSocket 实时事件流（认证启用时需要 X-API-Key header 或 ?apiKey= 查询参数）',
      request_schema: { type: 'subscribe|unsubscribe|pong', event: 'string (事件名)' },
      response_schema: { type: 'connected|subscribed|unsubscribed|event|ping' },
    },
  ],
};

export function registerDocsRoutes(app: FastifyInstance): void {
  app.get('/api/v1/docs', async () => {
    return { data: API_DOCS };
  });
}

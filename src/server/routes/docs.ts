/**
 * API 文档端点
 * 返回所有可用端点的描述和 schema 信息
 */

import type { FastifyInstance } from 'fastify';

const API_DOCS = {
  version: '2.0.0',
  endpoints: [
    /* ===== 基础设施 ===== */
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
      description: '运行时指标（JSON 格式，含 WebSocket 连接数）',
      response_schema: { uptime_seconds: 'number', requests: 'object', business: 'object', system: 'object' },
    },
    {
      method: 'GET',
      path: '/metrics/prometheus',
      description: '运行时指标（Prometheus text exposition 格式）',
      response_schema: { content_type: 'text/plain; version=0.0.4' },
    },

    /* ===== 核心价值 ===== */
    {
      method: 'POST',
      path: '/api/v1/values',
      description: '创建核心价值',
      request_schema: { label: 'string', weight: 'number (0-1)', timeDiscount: 'number (0-1, 可选, 默认 0.5)', emotionAmplifier: 'number (>=0, 可选, 默认 1.0)' },
      response_schema: { data: '{ id, label, weight, timeDiscount, emotionAmplifier }' },
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
      description: '更新核心价值权重（小 delta 直接应用返回 200；大 delta 经 UpdateGate 评估后可能返回 202 + 待确认提案）',
      request_schema: { weight: 'number (0-1)' },
      response_schema: { data: '{ id, label, weight } | PendingUpdate (202)' },
    },

    /* ===== 记忆系统 ===== */
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
      method: 'POST',
      path: '/api/v1/memories/decay',
      description: '触发全量记忆衰减',
      response_schema: { data: '{ decayed: string[], count: number }' },
    },
    {
      method: 'POST',
      path: '/api/v1/memories/consolidate',
      description: '触发记忆固化',
      response_schema: { data: '{ consolidated: string[], count: number }' },
    },
    {
      method: 'GET',
      path: '/api/v1/memories/working-set',
      description: '获取工作记忆',
      response_schema: { data: 'WorkingMemorySlot[]' },
    },
    {
      method: 'GET',
      path: '/api/v1/memories/:id/related',
      description: '获取相关记忆（?depth=2）',
      response_schema: { data: 'RelatedMemory[]' },
    },
    {
      method: 'POST',
      path: '/api/v1/memories/:id/activate',
      description: '触发扩散激活',
      response_schema: { data: '{ activations: ActivationResult[], count: number }' },
    },

    /* ===== 叙事 ===== */
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

    /* ===== P-OS 人格操作系统 ===== */
    {
      method: 'GET',
      path: '/api/v1/pos/survival',
      description: '列出所有 L0 生存锚点',
      response_schema: { data: 'SurvivalAnchor[]' },
    },
    {
      method: 'POST',
      path: '/api/v1/pos/survival',
      description: '添加 L0 生存锚点',
      request_schema: { label: 'string', kind: 'constraint|threshold|must_have', value: 'unknown', severity: 'number (1-5)' },
      response_schema: { data: 'SurvivalAnchor' },
    },
    {
      method: 'PATCH',
      path: '/api/v1/pos/survival/:id',
      description: '更新 L0 生存锚点（L0 变更始终经 UpdateGate 确认，返回 202 + 待确认提案）',
      request_schema: { label: 'string?', kind: 'string?', value: 'unknown?', severity: 'number?' },
      response_schema: { data: 'SurvivalAnchor | PendingUpdate (202)' },
    },
    {
      method: 'DELETE',
      path: '/api/v1/pos/survival/:id',
      description: '删除 L0 生存锚点',
      response_schema: { data: '{ deleted: true }' },
    },
    {
      method: 'GET',
      path: '/api/v1/pos/decision-style',
      description: '获取 L2 决策风格',
      response_schema: { data: 'DecisionStyle' },
    },
    {
      method: 'PUT',
      path: '/api/v1/pos/decision-style',
      description: '设置 L2 决策风格',
      request_schema: { riskAppetite: 'number', timeHorizon: 'number', explorationBias: 'number', lossAversion: 'number', deliberationDepth: 'number', regretSensitivity: 'number' },
      response_schema: { data: 'DecisionStyle' },
    },
    {
      method: 'GET',
      path: '/api/v1/pos/cognitive-model',
      description: '获取 L3 认知模型',
      response_schema: { data: 'CognitiveModel' },
    },
    {
      method: 'PUT',
      path: '/api/v1/pos/cognitive-model',
      description: '设置 L3 认知模型',
      request_schema: { beliefs: 'Record<string, number>', biasWeights: 'Record<string, number>', attributionStyle: 'number', growthMindset: 'number' },
      response_schema: { data: 'CognitiveModel' },
    },
    {
      method: 'GET',
      path: '/api/v1/pos/state',
      description: '获取完整 P-OS 五层状态 + prompt-ready 摘要',
      response_schema: { data: '{ state: PersonaOSState, summary: string }' },
    },
    {
      method: 'GET',
      path: '/api/v1/pos/state/summary',
      description: '获取 prompt-ready 五层人格状态文本摘要',
      response_schema: { data: '{ summary: string }' },
    },
    {
      method: 'GET',
      path: '/api/v1/pos/pending-updates',
      description: '获取待确认的 L0/L1 更新列表',
      response_schema: { data: 'PendingUpdate[]' },
    },
    {
      method: 'POST',
      path: '/api/v1/pos/pending-updates/:id/approve',
      description: '审批并应用待确认更新',
      response_schema: { data: 'PendingUpdate' },
    },
    {
      method: 'POST',
      path: '/api/v1/pos/pending-updates/:id/reject',
      description: '拒绝待确认更新',
      response_schema: { data: 'PendingUpdate' },
    },

    /* ===== 人格分叉与模拟 ===== */
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

    /* ===== 决策引擎 ===== */
    {
      method: 'GET',
      path: '/api/v1/decisions',
      description: '获取所有决策案例（支持分页：?page=1&pageSize=20）',
      response_schema: { data: 'DecisionCase[]', pagination: '{ page, pageSize, total, totalPages }' },
    },
    {
      method: 'POST',
      path: '/api/v1/decisions',
      description: '创建决策案例',
      request_schema: { title: 'string', description: 'string', alternatives: 'string[]?', constraints: 'string[]?', context: '{ timeHorizonMonths?, stakeholders?, riskTolerance? }?' },
      response_schema: { data: 'DecisionCase' },
    },
    {
      method: 'POST',
      path: '/api/v1/decisions/:id/simulate',
      description: '运行蒙特卡洛决策模拟（异步）',
      response_schema: { data: 'DecisionResult' },
    },
    {
      method: 'GET',
      path: '/api/v1/decisions/:id/runs/:runId',
      description: '获取模拟结果',
      response_schema: { data: 'DecisionResult' },
    },
    {
      method: 'POST',
      path: '/api/v1/decisions/:id/feedback',
      description: '用户反馈校准',
      request_schema: { runId: 'string', selectedAlternative: 'string', satisfaction: 'number (1-5)', notes: 'string?' },
      response_schema: { data: '{ recorded: true }' },
    },

    /* ===== 引导流程 ===== */
    {
      method: 'POST',
      path: '/api/v1/onboarding/start',
      description: '创建引导会话',
      response_schema: { data: '{ sessionId, status, currentStep }' },
    },
    {
      method: 'POST',
      path: '/api/v1/onboarding/step/:step',
      description: '提交引导步骤数据',
      request_schema: { sessionId: 'string', data: 'object (步骤相关)' },
      response_schema: { data: '{ sessionId, status, currentStep }' },
    },
    {
      method: 'GET',
      path: '/api/v1/onboarding/status/:sessionId',
      description: '获取引导会话状态',
      response_schema: { data: 'OnboardingSession' },
    },
    {
      method: 'POST',
      path: '/api/v1/onboarding/questionnaire',
      description: '提交性格问卷（推断 L0/L2/L3）',
      request_schema: { sessionId: 'string', responses: 'QuestionnaireResponse[]' },
      response_schema: { data: '{ applied: true, inferred: object }' },
    },
    {
      method: 'POST',
      path: '/api/v1/onboarding/import',
      description: '导入外部数据（日记、决策记录等）',
      request_schema: { sessionId: 'string', source: 'journal|decisions|values', entries: 'ImportEntry[]' },
      response_schema: { data: '{ imported: number, memoriesCreated: number }' },
    },

    /* ===== 可视化 ===== */
    {
      method: 'GET',
      path: '/api/v1/values/visualization',
      description: '价值径向图数据（节点 + 边 + 布局提示）',
      response_schema: { data: '{ nodes: ValueNode[], edges: ValueEdge[], layout: string }' },
    },
    {
      method: 'GET',
      path: '/api/v1/decisions/:id/fingerprint',
      description: '决策指纹时间线',
      response_schema: { data: '{ dimensions: FingerprintDimension[] }' },
    },

    /* ===== 隐私与信任 ===== */
    {
      method: 'POST',
      path: '/api/v1/privacy/export',
      description: '导出所有数据（JSON 格式）',
      response_schema: { data: '{ exportId, format, content }' },
    },
    {
      method: 'DELETE',
      path: '/api/v1/privacy/data',
      description: '删除当前租户所有数据（GDPR 合规，按 tenant_id 隔离）',
      response_schema: { data: '{ deleted: true, timestamp: number }' },
    },
    {
      method: 'GET',
      path: '/api/v1/privacy/audit-trail',
      description: '数据使用审计日志',
      response_schema: { data: 'AuditEntry[]' },
    },

    /* ===== 异步任务 ===== */
    {
      method: 'GET',
      path: '/api/v1/tasks/:taskId',
      description: '查询异步任务状态（租户隔离）',
      response_schema: { data: '{ id, type, status, result, error, createdAt, updatedAt }' },
    },

    /* ===== 快照与演化 ===== */
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
      description: '运行演化周期（含差异报告和后悔概率）',
      response_schema: { data: '{ mergedCount, beforeSnapshotId, afterSnapshotId, diffReport: EvolutionDiffReport }' },
    },
    {
      method: 'POST',
      path: '/api/v1/operations/regulation/run',
      description: '运行调控周期',
      request_schema: { strategy: 'equal|fitness_weighted|priority_based (可选)' },
      response_schema: { data: '{ status, strategy }' },
    },

    /* ===== 人生模拟 ===== */
    {
      method: 'POST',
      path: '/api/v1/simulations/life',
      description: '创建人生模拟（异步，至少 2 条路径，horizonYears ≤ 30）',
      request_schema: { paths: 'LifePath[] (≥2)', horizonYears: 'number (1-30)', age: 'number?', stressTestConfig: '{ enabled, incomeFreezeYears?, marketDownturnFactor?, healthShock? }?' },
      response_schema: { data: '{ simulationId, taskId, status: "accepted" }' },
    },
    {
      method: 'GET',
      path: '/api/v1/simulations/:id',
      description: '查询模拟状态（含摘要、推荐路径、各路径评分）',
      response_schema: { data: '{ simulationId, status, summary?: { recommendedPathId, paths: [{ pathId, compositeScore, regretProbability }] } }' },
    },
    {
      method: 'GET',
      path: '/api/v1/simulations/:id/paths/:pathId',
      description: '获取路径时间线详情（年度快照：财富、情绪、健康、家庭、价值权重）',
      response_schema: { data: '{ pathId, label, timeline: YearState[], branches: BranchResult[] }' },
    },
    {
      method: 'POST',
      path: '/api/v1/simulations/:id/stress-test',
      description: '基于已有模拟创建压力测试变体',
      request_schema: { variantLabel: 'string', overrides: '{ marketDownturnFactor?, incomeFreezeYears?, healthShock? }' },
      response_schema: { data: '{ simulationId, baseSimulationId, status: "accepted" }' },
    },

    /* ===== 人生模拟可视化 ===== */
    {
      method: 'GET',
      path: '/api/v1/simulations/:id/visualization/overview',
      description: '仪表盘概览（推荐路径 + 评分摘要 + 回顾结论）',
      response_schema: { data: '{ simulationId, status, recommendedPathId, retrospective, paths, meta }' },
    },
    {
      method: 'GET',
      path: '/api/v1/simulations/:id/visualization/paths',
      description: '多路径时间序列对比（?metrics=wealth,healthIndex&resolution=year|2y|5y）',
      response_schema: { data: '{ simulationId, metrics, resolution, series: [{ pathId, label, points, stats }] }' },
    },
    {
      method: 'GET',
      path: '/api/v1/simulations/:id/visualization/branches/:pathId',
      description: '分支概率结构图（决策树/桑基图数据，含 graph nodes/edges）',
      response_schema: { data: '{ simulationId, pathId, pivotYear, baseTimeline, branches, graph: { nodes, edges } }' },
    },
    {
      method: 'GET',
      path: '/api/v1/simulations/:id/visualization/stress-comparison',
      description: '基线 vs 压力测试变体差分（compositeScore/regretProbability delta）',
      response_schema: { data: '{ baseSimulationId, baseSummary, variants: [{ simulationId, deltas }] }' },
    },
    {
      method: 'GET',
      path: '/api/v1/simulations/:id/visualization/milestones',
      description: '里程碑聚合（峰值/谷值/阈值穿越事件，?metrics=wealth,healthIndex）',
      response_schema: { data: '{ simulationId, metrics, milestones: [{ pathId, events, summary }] }' },
    },

    /* ===== 冲突管理 ===== */
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

    /* ===== 审计 ===== */
    {
      method: 'GET',
      path: '/api/v1/audit',
      description: '查询审计日志（含 API Key 哈希追溯）',
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
      description: 'WebSocket 实时事件流（支持 X-Tenant-Id 多租户，认证启用时需要 X-API-Key）',
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

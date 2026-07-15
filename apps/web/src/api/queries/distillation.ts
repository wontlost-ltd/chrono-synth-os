import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../client';

/* 人格蒸馏审批域（ADR-0047）——LLM 老师蒸馏出的候选变更需 owner 人工 approve/reject 才编译进内核。
 * owner-only JWT，per-persona。响应均单键 {data} 信封 → apiFetch<T> 已自动解包。 */

export type ArtifactKind =
  | 'rule' | 'value_shift' | 'memory_edge' | 'decision_style_patch'
  | 'cognitive_model_patch' | 'response_template' | 'narrative_patch';

export type ArtifactSource =
  | 'reflection' | 'conversation' | 'knowledge_import' | 'onboarding' | 'perception';

export type ArtifactStatus =
  | 'candidate' | 'approved' | 'compiled' | 'rejected' | 'rolled_back';

export interface ArtifactEvidence {
  type: 'memory' | 'conversation' | 'knowledge' | 'pattern' | 'test';
  id: string;
  score: number;
}

/** 一个蒸馏工件（toView 暴露的字段）。 */
export interface DistillArtifact {
  id: string;
  kind: ArtifactKind;
  source: ArtifactSource;
  status: ArtifactStatus;
  confidence: number;
  payload: unknown;
  evidence: ArtifactEvidence[];
  createdAt: number;
  compiledAt: number | null;
}

export interface ArtifactList {
  items: DistillArtifact[];
  total: number;
}

const base = (personaId: string): string => `/api/v1/persona-core/${encodeURIComponent(personaId)}/distillation`;

/** 待审批候选（status=candidate）。 */
export function useDistillCandidates(personaId: string) {
  return useQuery({
    queryKey: ['distillation', 'candidates', personaId],
    queryFn: ({ signal }) => apiFetch<ArtifactList>(`${base(personaId)}/candidates`, { signal }),
    enabled: !!personaId,
  });
}

/** 全部工件（审计历史，含 approved/compiled/rejected/rolled_back）。 */
export function useDistillArtifacts(personaId: string) {
  return useQuery({
    queryKey: ['distillation', 'artifacts', personaId],
    queryFn: ({ signal }) => apiFetch<ArtifactList>(`${base(personaId)}/artifacts`, { signal }),
    enabled: !!personaId,
  });
}

function invalidate(qc: ReturnType<typeof useQueryClient>, personaId: string): void {
  qc.invalidateQueries({ queryKey: ['distillation', 'candidates', personaId] });
  qc.invalidateQueries({ queryKey: ['distillation', 'artifacts', personaId] });
}

/** 批准工件 → 编译进内核（高影响治理操作；404 未找到 / 409 状态非法）。 */
export function useApproveArtifact(personaId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (artifactId: string) =>
      apiFetch<DistillArtifact>(`${base(personaId)}/${encodeURIComponent(artifactId)}/approve`, { method: 'POST' }),
    onSuccess: () => invalidate(qc, personaId),
  });
}

/** 拒绝工件（须填原因）。 */
export function useRejectArtifact(personaId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ artifactId, reason }: { artifactId: string; reason: string }) =>
      apiFetch<DistillArtifact>(`${base(personaId)}/${encodeURIComponent(artifactId)}/reject`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      }),
    onSuccess: () => invalidate(qc, personaId),
  });
}

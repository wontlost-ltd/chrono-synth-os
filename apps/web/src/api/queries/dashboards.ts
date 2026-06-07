import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../client';

export interface ValueRadarPoint {
  label: string;
  current: number;
  d7?: number;
  d30?: number;
}

export interface DecisionTrendPoint {
  ts: number;
  count: number;
}

export interface MemoryStackPoint {
  ts: number;
  episodic: number;
  semantic: number;
  procedural: number;
}

export interface ToolMixSlice {
  toolId: string;
  count: number;
}

export type DriftAlertLevel = 'ok' | 'warning' | 'critical';

export interface DriftTimelinePoint {
  reportId: string;
  analyzedAt: number;
  overallDriftScore: number;
  alertLevel: DriftAlertLevel;
}

export interface PersonaHealthPayload {
  personaId: string;
  values: ValueRadarPoint[];
  decisionTrend: DecisionTrendPoint[];
  memoryStack: MemoryStackPoint[];
  toolMix: ToolMixSlice[];
  driftTimeline: DriftTimelinePoint[];
  generatedAt: number;
}

export function usePersonaHealth(personaId: string, enabled = true) {
  return useQuery({
    queryKey: ['dashboards', 'persona', personaId],
    enabled: enabled && personaId.length > 0,
    queryFn: ({ signal }) => {
      const path = `/api/v1/admin/dashboards/persona/${encodeURIComponent(personaId)}`;
      return apiFetch<PersonaHealthPayload>(path, { signal });
    },
    staleTime: 5 * 60 * 1000,
  });
}

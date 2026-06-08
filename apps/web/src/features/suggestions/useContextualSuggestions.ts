/**
 * useContextualSuggestions — recommend the next 1-3 actions based on
 * the user's current context (route, persona state, recent activity).
 *
 * Pure-function rules engine. No LLM call — that comes later via the
 * /api/v1/suggestions endpoint when latency / cost are acceptable.
 * The hook surface won't change when the implementation swaps; the
 * shape of `Suggestion` is the contract.
 *
 * Ranking: each rule emits suggestions with a 0..1 score. The top N
 * across all rules wins. Sources include "you have 0 personas",
 * "your latest simulation has unread results", "you haven't enabled
 * 2FA". Most rules are stateless w.r.t. server data — they read from
 * the existing react-query caches.
 */

import { useMemo } from 'react';
import { useLocation } from 'react-router-dom';
import { usePersonas } from '../../api/queries/personas';
import { useKnowledgeSources } from '../../api/queries/knowledgeSources';
import { useUserLevel } from '../growth/useUserLevel';

export interface Suggestion {
  id: string;
  /** Translation key for the headline */
  titleKey: string;
  /** Translation key for the longer body */
  bodyKey?: string;
  /** Internal route to navigate to when accepted */
  to?: string;
  /** Optional payload variables interpolated into the i18n strings */
  vars?: Record<string, string | number>;
  /** Score in [0, 1]; the engine picks top N. */
  score: number;
}

interface SuggestionContext {
  pathname: string;
  level: string;
  hasPersonas: boolean;
  hasKnowledge: boolean;
}

/* Rule = (ctx) → Suggestion[]. Rules are pure; easy to unit-test. */
type Rule = (ctx: SuggestionContext) => Suggestion[];

const rules: ReadonlyArray<Rule> = [
  // Empty-persona: top of mind for new users
  (ctx) => (ctx.hasPersonas ? [] : [{
    id: 'create_first_persona',
    titleKey: 'suggestions.firstPersona.title',
    bodyKey: 'suggestions.firstPersona.body',
    to: '/personas',
    score: 1.0,
  }]),

  // Empty-knowledge: nudges users to add structure once they have ≥1 persona
  (ctx) => (ctx.hasPersonas && !ctx.hasKnowledge ? [{
    id: 'add_first_knowledge',
    titleKey: 'suggestions.firstKnowledge.title',
    bodyKey: 'suggestions.firstKnowledge.body',
    to: '/knowledge-sources',
    score: 0.85,
  }] : []),

  // Route-aware: when on dashboard, surface "view drift report"
  (ctx) => (ctx.pathname === '/dashboard' && ctx.level >= 'L2' ? [{
    id: 'view_drift',
    titleKey: 'suggestions.viewDrift.title',
    to: '/admin/safety/drift',
    score: 0.4,
  }] : []),

  // L3+ users get the agent-tool nudge
  (ctx) => (ctx.level >= 'L3' ? [{
    id: 'grant_first_tool',
    titleKey: 'suggestions.firstTool.title',
    to: '/admin/tool-permissions',
    score: 0.6,
  }] : []),
];

interface SuggestionsResult {
  suggestions: Suggestion[];
  /** Total candidates before top-N truncation; useful for "more suggestions" UX */
  totalCandidates: number;
}

export function useContextualSuggestions(maxSuggestions = 3): SuggestionsResult {
  const location = useLocation();
  const personas = usePersonas();
  const knowledge = useKnowledgeSources();
  const { level } = useUserLevel();

  return useMemo(() => {
    const ctx: SuggestionContext = {
      pathname: location.pathname,
      level,
      hasPersonas: (personas.data?.length ?? 0) > 0,
      hasKnowledge: (knowledge.data?.length ?? 0) > 0,
    };

    const all = rules.flatMap((r) => r(ctx));
    const ranked = [...all].sort((a, b) => b.score - a.score);
    return {
      suggestions: ranked.slice(0, maxSuggestions),
      totalCandidates: all.length,
    };
  }, [location.pathname, level, personas.data, knowledge.data, maxSuggestions]);
}

/* Pure helpers for testing — exported only because the rules engine is
 * easier to unit-test by feeding contexts directly. */
export function _runRulesForTest(ctx: SuggestionContext): Suggestion[] {
  return rules.flatMap((r) => r(ctx));
}

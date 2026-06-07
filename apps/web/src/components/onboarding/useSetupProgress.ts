/**
 * useSetupProgress — derives the SetupChecklist `completed` flags from
 * existing list queries.
 *
 * The host app already paginates personas / knowledge sources / tool
 * permissions, so we reuse those queries and just check `length > 0`.
 * No new API surface required.
 *
 * The hook is intentionally silent on auth — if the user isn't signed in,
 * react-query returns errors which we treat as "not yet completed". The
 * caller (AppShell) is already responsible for not rendering on
 * /login or /register.
 */

import { useMemo } from 'react';
import { usePersonas } from '../../api/queries/personas';
import { useKnowledgeSources } from '../../api/queries/knowledgeSources';
import { useToolPermissions } from '../../api/queries/agent-tools';
import { useAuth } from '../../hooks/useAuth';
import { DEFAULT_SETUP_STEPS, type SetupChecklistStep } from './SetupChecklist';

export function useSetupProgress(): SetupChecklistStep[] {
  const { isAuthenticated, role } = useAuth();
  const personas = usePersonas();
  const knowledgeSources = useKnowledgeSources();
  /* tool permissions are admin-only; non-admin users mark the step
   * complete by default so the checklist isn't permanently stuck. */
  const toolPermissions = useToolPermissions(role === 'admin');

  return useMemo(() => {
    if (!isAuthenticated) {
      return DEFAULT_SETUP_STEPS.map((s) => ({ ...s, completed: false }));
    }

    const hasPersonas = (personas.data?.length ?? 0) > 0;
    const hasKnowledge = (knowledgeSources.data?.length ?? 0) > 0;
    const hasToolPermission = role === 'admin'
      ? (toolPermissions.data?.length ?? 0) > 0
      : true;

    return DEFAULT_SETUP_STEPS.map((s) => {
      switch (s.id) {
        case 'create_persona':
          return { ...s, completed: hasPersonas };
        case 'add_knowledge':
          return { ...s, completed: hasKnowledge };
        case 'grant_tools':
          return { ...s, completed: hasToolPermission };
        case 'first_conversation':
          /* Real signal would be conversation_messages table; for now we
           * proxy through "has at least one persona" because conversations
           * require a persona to start. Replace once a dedicated query exists. */
          return { ...s, completed: hasPersonas };
        case 'invite_team':
          /* Single-tenant deployments don't have invite flow; mark complete
           * to keep the checklist closeable. Tighten once SCIM / org
           * membership is exposed in the UI. */
          return { ...s, completed: true };
        default:
          return { ...s, completed: false };
      }
    });
  }, [
    isAuthenticated,
    role,
    personas.data,
    knowledgeSources.data,
    toolPermissions.data,
  ]);
}

/**
 * RBAC declarative matrix.
 *
 * Plan: poc-to-enterprise-ga-2026-v7.3.md §3.7 P1-W-rbac
 *
 * Why a matrix vs. ad-hoc requireRole() calls scattered through routes:
 *  - One file documents every protected action; auditors read this
 *    instead of grepping for requireRole().
 *  - Compile-time guarantees on the action key — typos can't sneak past.
 *  - Workers (TaskQueue, ConversationRetentionWorker, etc.) need the
 *    same gate without going through Fastify; this matrix is the
 *    canonical source they consult.
 *
 * Action naming convention: `<domain>.<resource>.<verb>`
 *   - read-only verbs:   get, list, search, export
 *   - write verbs:       create, update, delete, rotate, restore
 *   - admin verbs:       deny-jti, compromise-key, force-delete, impersonate
 */

import type { UserRole } from '../types/auth.js';

export type RbacAction =
  /* tenant data CRUD */
  | 'persona.read' | 'persona.create' | 'persona.update' | 'persona.delete'
  | 'memory.read' | 'memory.create' | 'memory.delete'
  | 'value.read' | 'value.update'
  /* identity */
  | 'user.read' | 'user.invite' | 'user.deactivate' | 'user.impersonate'
  | 'apikey.list' | 'apikey.create' | 'apikey.revoke'
  /* admin / break-glass surface */
  | 'auth.keys.rotate' | 'auth.keys.compromise' | 'auth.keys.deny-jti'
  | 'compliance.evidence.export' | 'compliance.evidence.read'
  | 'legal-hold.place' | 'legal-hold.release' | 'legal-hold.list'
  /* billing */
  | 'billing.read' | 'billing.update-plan'
  /* worker context */
  | 'worker.run' | 'worker.replay'
;

/**
 * The matrix. role → set of actions. `admin` may inherit from `member`
 * explicitly in the table (one row per action), but we list them
 * fully so the table is self-documenting at audit time.
 */
const MATRIX: Readonly<Record<UserRole, ReadonlySet<RbacAction>>> = {
  admin: new Set<RbacAction>([
    /* admin gets everything currently defined */
    'persona.read', 'persona.create', 'persona.update', 'persona.delete',
    'memory.read', 'memory.create', 'memory.delete',
    'value.read', 'value.update',
    'user.read', 'user.invite', 'user.deactivate', 'user.impersonate',
    'apikey.list', 'apikey.create', 'apikey.revoke',
    'auth.keys.rotate', 'auth.keys.compromise', 'auth.keys.deny-jti',
    'compliance.evidence.export', 'compliance.evidence.read',
    'legal-hold.place', 'legal-hold.release', 'legal-hold.list',
    'billing.read', 'billing.update-plan',
    'worker.run', 'worker.replay',
  ]),
  member: new Set<RbacAction>([
    'persona.read', 'persona.create', 'persona.update',
    'memory.read', 'memory.create', 'memory.delete',
    'value.read', 'value.update',
    'user.read',
    'apikey.list', 'apikey.create',
    'billing.read',
  ]),
  viewer: new Set<RbacAction>([
    'persona.read', 'memory.read', 'value.read', 'user.read', 'billing.read',
    'compliance.evidence.read',
  ]),
  service: new Set<RbacAction>([
    /* Service-account tokens used by workers. Locked down to data plane
     * reads + the dedicated worker verbs. */
    'persona.read', 'memory.read', 'value.read',
    'worker.run', 'worker.replay',
    'compliance.evidence.read',
  ]),
};

/** Returns true if the role is permitted to perform the action. */
export function hasPermission(role: UserRole, action: RbacAction): boolean {
  return MATRIX[role]?.has(action) ?? false;
}

/** List every action a role can perform — used by admin UI + auditors. */
export function actionsForRole(role: UserRole): readonly RbacAction[] {
  const set = MATRIX[role];
  if (!set) return [];
  return Array.from(set).sort();
}

/**
 * Snapshot of the entire matrix as a 2D table — primary auditor view.
 * Rows = actions, columns = roles, value = true/false.
 */
export function matrixTable(): Array<{ action: RbacAction; admin: boolean; member: boolean; viewer: boolean; service: boolean }> {
  /* Union of all actions across roles; sort for deterministic output. */
  const allActions = new Set<RbacAction>();
  for (const set of Object.values(MATRIX)) {
    for (const a of set) allActions.add(a);
  }
  return Array.from(allActions).sort().map(action => ({
    action,
    admin: MATRIX.admin.has(action),
    member: MATRIX.member.has(action),
    viewer: MATRIX.viewer.has(action),
    service: MATRIX.service.has(action),
  }));
}

/**
 * Worker-side gate. Throws if the actor's role can't perform the action.
 * Workers don't have Fastify reply / request, so they call this
 * directly. Caller decides whether to log, retry, or fail the job.
 */
export class RbacDeniedError extends Error {
  readonly code = 'RBAC_DENIED' as const;
  constructor(readonly role: UserRole, readonly action: RbacAction) {
    super(`role=${role} cannot perform action=${action}`);
    this.name = 'RbacDeniedError';
  }
}

export function assertPermitted(role: UserRole, action: RbacAction): void {
  if (!hasPermission(role, action)) throw new RbacDeniedError(role, action);
}

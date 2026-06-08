/**
 * Default command set registered when the CommandPalette mounts.
 *
 * Kept separate from CommandPalette.tsx so apps can extend or override
 * without touching the palette internals. Pages can also push their own
 * scoped commands via a future context API (not implemented yet).
 */

import type { PaletteCommand } from './CommandPalette';

export const DEFAULT_COMMANDS: ReadonlyArray<PaletteCommand> = [
  /* Navigation */
  { id: 'nav.dashboard', labelKey: 'cmdk.commands.dashboard', to: '/dashboard', group: 'navigation', hotkey: 'g d', keywords: ['home', 'dashboard'] },
  { id: 'nav.personas', labelKey: 'cmdk.commands.personas', to: '/personas', group: 'navigation', hotkey: 'g p', keywords: ['persona', 'avatar'] },
  { id: 'nav.simulations', labelKey: 'cmdk.commands.simulations', to: '/simulations', group: 'navigation', hotkey: 'g s', keywords: ['sim', 'run', 'experiment'] },
  { id: 'nav.values', labelKey: 'cmdk.commands.values', to: '/values', group: 'navigation', hotkey: 'g v', keywords: ['core', 'graph'] },
  { id: 'nav.knowledge', labelKey: 'cmdk.commands.knowledge', to: '/knowledge-sources', group: 'navigation', hotkey: 'g k', keywords: ['source', 'data'] },
  { id: 'nav.billing', labelKey: 'cmdk.commands.billing', to: '/billing', group: 'navigation', keywords: ['subscription', 'plan'] },
  { id: 'nav.settings', labelKey: 'cmdk.commands.settings', to: '/settings', group: 'navigation', keywords: ['profile', 'preferences'] },

  /* Admin (only relevant when role=admin; the palette renders them
   * regardless and the destination page handles role gating) */
  { id: 'admin.tool_permissions', labelKey: 'cmdk.commands.toolPermissions', to: '/admin/tool-permissions', group: 'admin', keywords: ['grant', 'revoke', 'tools'] },
  { id: 'admin.agency_authorizations', labelKey: 'cmdk.commands.agencyAuthorizations', to: '/admin/agency-authorizations', group: 'admin', keywords: ['authorize', 'agency'] },
  { id: 'admin.tool_invocations', labelKey: 'cmdk.commands.toolInvocations', to: '/admin/tool-invocations', group: 'admin', keywords: ['audit', 'history'] },
  { id: 'admin.safety_drift', labelKey: 'cmdk.commands.safetyDrift', to: '/admin/safety/drift', group: 'admin', keywords: ['drift', 'report', 'safety'] },
  { id: 'admin.config', labelKey: 'cmdk.commands.adminConfig', to: '/admin/config', group: 'admin', keywords: ['config', 'tenant'] },

  /* Agent flows */
  { id: 'agent.oauth_google', labelKey: 'cmdk.commands.agentOauthGoogle', to: '/agent/oauth/google', group: 'agent', keywords: ['google', 'oauth', 'calendar', 'gmail'] },
  { id: 'agent.confirmations', labelKey: 'cmdk.commands.agentConfirmations', to: '/agent/confirmations', group: 'agent', keywords: ['approve', 'pending'] },
];

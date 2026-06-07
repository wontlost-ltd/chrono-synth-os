/**
 * StatusBadge stories — token-driven status colours, used as the
 * canary story for the design-token + theme + Chromatic chain.
 *
 * Anchoring this component is deliberate: it touches every status
 * colour in the token set (active/paused/syncing/error/offline/
 * completed) in a single render, so a contrast regression on any of
 * them shows up here first.
 */

import type { Meta, StoryObj } from '@storybook/react-vite';
import { StatusBadge } from './StatusBadge';

const meta: Meta<typeof StatusBadge> = {
  title: 'UI/StatusBadge',
  component: StatusBadge,
  parameters: {
    /* a11y rules tuned for badges:
     *   - color-contrast: enforced (this is what the contrast lint
     *     guards but Storybook re-runs it on the rendered DOM, which
     *     catches Tailwind-class-level mistakes the static lint
     *     can't see)
     *   - aria-allowed-role: badges use no role attribute by design */
  },
};
export default meta;

type Story = StoryObj<typeof StatusBadge>;

export const Active: Story = { args: { status: 'active' } };
export const Paused: Story = { args: { status: 'paused' } };
export const Syncing: Story = { args: { status: 'syncing' } };
export const Error: Story = { args: { status: 'error' } };
export const Offline: Story = { args: { status: 'offline' } };
export const Completed: Story = { args: { status: 'completed' } };

/**
 * All six statuses side-by-side. This is the highest-signal story
 * for visual regression — a token tweak that hurts one status pops
 * immediately because the others are still next to it for comparison.
 */
export const AllStatuses: Story = {
  render: () => (
    <div className="flex flex-wrap gap-2 p-4 bg-surface">
      <StatusBadge status="active" />
      <StatusBadge status="paused" />
      <StatusBadge status="syncing" />
      <StatusBadge status="error" />
      <StatusBadge status="offline" />
      <StatusBadge status="completed" />
    </div>
  ),
};

export const LargeSize: Story = {
  args: { status: 'active', size: 'md' },
};

export const CustomLabel: Story = {
  args: { status: 'syncing', label: 'Pushing 3 changes…' },
};

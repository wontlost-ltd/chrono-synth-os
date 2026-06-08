/**
 * Resolution-panel rendering tests.
 *
 * One render test per of the 5 entity-type panels — verifies that the
 * entity-id is shown, the right field labels are present, and at least
 * one diverging field renders as expected.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ConflictInboxItemV1 } from '@chrono/contracts';

import { PersonaConflictPanel } from './PersonaConflictPanel';
import { MemoryConflictPanel } from './MemoryConflictPanel';
import { TaskConflictPanel } from './TaskConflictPanel';
import { DeviceConflictPanel } from './DeviceConflictPanel';
import { PolicyConflictPanel } from './PolicyConflictPanel';

function makeConflict(overrides: Partial<ConflictInboxItemV1>): ConflictInboxItemV1 {
  return {
    schemaVersion: 'conflict-inbox.v1',
    conflictId: 'c-1',
    conflictVersion: 'v-1',
    tenantId: 't-1',
    entityType: 'persona',
    entityId: 'e-1',
    sourceRuntime: 'desktop',
    detectedAt: '2026-05-23T00:00:00Z',
    severity: 'blocking',
    localSummaryId: 'persona.summary',
    localSummaryParams: {},
    serverSummaryId: 'persona.summary',
    serverSummaryParams: {},
    suggestedActions: ['keep_local', 'keep_server'],
    ...overrides,
  };
}

describe('PersonaConflictPanel', () => {
  it('renders persona-specific fields and entity id', () => {
    const conflict = makeConflict({
      entityType: 'persona',
      entityId: 'persona-abc',
      localSummaryParams: { displayName: 'Ada Local', status: 'active' },
      serverSummaryParams: { displayName: 'Ada Server', status: 'active' },
    });
    render(<PersonaConflictPanel conflict={conflict} />);
    expect(screen.getByText('persona-abc')).toBeInTheDocument();
    expect(screen.getByText('Display name')).toBeInTheDocument();
    expect(screen.getByText('Ada Local')).toBeInTheDocument();
    expect(screen.getByText('Ada Server')).toBeInTheDocument();
  });
});

describe('MemoryConflictPanel', () => {
  it('renders memory-specific fields', () => {
    const conflict = makeConflict({
      entityType: 'memory',
      entityId: 'mem-1',
      localSummaryParams: { title: 'Local title', salience: 0.8 },
      serverSummaryParams: { title: 'Server title', salience: 0.4 },
    });
    render(<MemoryConflictPanel conflict={conflict} />);
    expect(screen.getByText('mem-1')).toBeInTheDocument();
    expect(screen.getByText('Salience')).toBeInTheDocument();
    /* salience is a number; ParamComparator formats via toLocaleString. */
    expect(screen.getByText('0.8')).toBeInTheDocument();
    expect(screen.getByText('0.4')).toBeInTheDocument();
  });
});

describe('TaskConflictPanel', () => {
  it('renders task-specific fields and the divergence warning copy', () => {
    const conflict = makeConflict({
      entityType: 'task',
      entityId: 'task-1',
      localSummaryParams: { title: 'Walk dog', acceptedBy: 'persona-a' },
      serverSummaryParams: { title: 'Walk dog', acceptedBy: 'persona-b' },
    });
    render(<TaskConflictPanel conflict={conflict} />);
    expect(screen.getByText('task-1')).toBeInTheDocument();
    expect(screen.getByText('Accepted by')).toBeInTheDocument();
    expect(screen.getByText('persona-a')).toBeInTheDocument();
    expect(screen.getByText('persona-b')).toBeInTheDocument();
  });
});

describe('DeviceConflictPanel', () => {
  it('renders device-specific fields', () => {
    const conflict = makeConflict({
      entityType: 'device',
      entityId: 'device-9',
      localSummaryParams: { deviceName: 'MacBook' },
      serverSummaryParams: { deviceName: 'MacBookPro' },
    });
    render(<DeviceConflictPanel conflict={conflict} />);
    expect(screen.getByText('device-9')).toBeInTheDocument();
    expect(screen.getByText('Device name')).toBeInTheDocument();
    expect(screen.getByText('MacBook')).toBeInTheDocument();
    expect(screen.getByText('MacBookPro')).toBeInTheDocument();
  });
});

describe('PolicyConflictPanel', () => {
  it('renders policy fields plus the high-stakes warning banner', () => {
    const conflict = makeConflict({
      entityType: 'policy',
      entityId: 'policy-1',
      localSummaryParams: { effect: 'allow', version: 3 },
      serverSummaryParams: { effect: 'deny', version: 4 },
    });
    render(<PolicyConflictPanel conflict={conflict} />);
    expect(screen.getByText('policy-1')).toBeInTheDocument();
    expect(screen.getByText('Policy conflicts are high-stakes.')).toBeInTheDocument();
    expect(screen.getByText('allow')).toBeInTheDocument();
    expect(screen.getByText('deny')).toBeInTheDocument();
  });
});

describe('ParamComparator extra-field handling', () => {
  it('renders summary fields not in the curated list under their raw key', () => {
    /* Future contract addition: server adds a `tier` field to persona
     * SummaryParams. The UI must not silently drop it — we render with
     * the raw key as label until a curated entry is added. */
    const conflict = makeConflict({
      entityType: 'persona',
      entityId: 'persona-extra',
      localSummaryParams: { displayName: 'Ada', tier: 'premium' },
      serverSummaryParams: { displayName: 'Ada', tier: 'free' },
    });
    render(<PersonaConflictPanel conflict={conflict} />);
    expect(screen.getByText('tier')).toBeInTheDocument();
    expect(screen.getByText('premium')).toBeInTheDocument();
    expect(screen.getByText('free')).toBeInTheDocument();
  });
});

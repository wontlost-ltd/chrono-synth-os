import { describe, it, expect, vi } from 'vitest';

/* The TitleBar imports getCurrentWindow() at module-load time and calls
 * the result for window controls. We mock the entire @tauri-apps/api/window
 * module so the test environment doesn't need a real Tauri runtime. */
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    close: vi.fn(),
    minimize: vi.fn(),
    toggleMaximize: vi.fn(),
  }),
}));

import { render, screen } from '@testing-library/react';
import { TitleBar } from './TitleBar';

describe('TitleBar', () => {
  it('renders three window-control buttons with aria-labels', () => {
    render(<TitleBar />);
    expect(screen.getByRole('button', { name: 'Close window' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Minimize window' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Maximize window' })).toBeInTheDocument();
  });

  it('renders the app name', () => {
    render(<TitleBar />);
    expect(screen.getByText('ChronoSynth')).toBeInTheDocument();
  });
});

import { describe, it, expect, vi } from 'vitest';

/* Mock the bridge so the test runs without a Tauri runtime. */
vi.mock('../bridge/tauri-commands', () => ({
  markFirstRunCompleted: vi.fn(async () => undefined),
}));
vi.mock('../bridge/http-client', () => ({
  setApiBaseUrl: vi.fn(),
}));

import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { OnboardingPage } from './OnboardingPage';
import { markFirstRunCompleted } from '../bridge/tauri-commands';
import { setApiBaseUrl } from '../bridge/http-client';

function renderInRouter() {
  return render(
    <MemoryRouter initialEntries={['/onboarding']}>
      <Routes>
        <Route path="/onboarding" element={<OnboardingPage />} />
        <Route path="/" element={<div>HOME</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('OnboardingPage', () => {
  it('renders the welcome step on mount', () => {
    renderInRouter();
    expect(screen.getByRole('heading', { name: 'Welcome' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Get started' })).toBeInTheDocument();
  });

  it('progress bar reflects 3-step structure', () => {
    renderInRouter();
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuemax', '3');
    expect(bar).toHaveAttribute('aria-valuenow', '1');
  });

  it('Get started moves to mode-select', () => {
    renderInRouter();
    fireEvent.click(screen.getByRole('button', { name: 'Get started' }));
    expect(screen.getByRole('heading', { name: 'Pick a mode' })).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '2');
  });

  it('local-only mode advances without requiring URL', () => {
    renderInRouter();
    fireEvent.click(screen.getByRole('button', { name: 'Get started' }));
    fireEvent.click(screen.getByRole('button', { name: /Local-only/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByRole('heading', { name: "You're set" })).toBeInTheDocument();
    /* Local mode shouldn't write the API base URL. */
    expect(setApiBaseUrl).not.toHaveBeenCalled();
  });

  it('cloud mode requires a valid URL before continuing', () => {
    renderInRouter();
    fireEvent.click(screen.getByRole('button', { name: 'Get started' }));
    fireEvent.click(screen.getByRole('button', { name: /Sync with ChronoSynth OS/i }));
    /* No URL entered → Continue surfaces a validation error. */
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/Please enter a chrono-synth-os URL/);
    expect(setApiBaseUrl).not.toHaveBeenCalled();
  });

  it('cloud mode accepts a valid URL and writes it to the API client', () => {
    renderInRouter();
    fireEvent.click(screen.getByRole('button', { name: 'Get started' }));
    fireEvent.click(screen.getByRole('button', { name: /Sync with ChronoSynth OS/i }));
    const input = screen.getByLabelText('Server URL');
    fireEvent.change(input, { target: { value: 'https://chrono.example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByRole('heading', { name: "You're set" })).toBeInTheDocument();
    expect(setApiBaseUrl).toHaveBeenCalledWith('https://chrono.example.com');
  });

  it('Open ChronoSynth marks first-run complete', async () => {
    renderInRouter();
    fireEvent.click(screen.getByRole('button', { name: 'Get started' }));
    fireEvent.click(screen.getByRole('button', { name: /Local-only/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open ChronoSynth' }));
    /* markFirstRunCompleted is async but we don't need to await — the
     * mock resolves synchronously and the test asserts the call site. */
    await Promise.resolve();
    expect(markFirstRunCompleted).toHaveBeenCalledTimes(1);
  });
});

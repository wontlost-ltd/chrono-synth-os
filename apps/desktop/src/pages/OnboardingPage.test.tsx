import { describe, it, expect, vi } from 'vitest';

/* Mock the bridge so the test runs without a Tauri runtime. */
vi.mock('../bridge/tauri-commands', () => ({
  markFirstRunCompleted: vi.fn(async () => undefined),
}));
vi.mock('../bridge/http-client', () => ({
  setApiCredentials: vi.fn(async () => undefined),
}));

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { OnboardingPage } from './OnboardingPage';
import { markFirstRunCompleted } from '../bridge/tauri-commands';
import { setApiCredentials } from '../bridge/http-client';

/* App 现在直接渲染 OnboardingPage（无 router），故测试也不再包 MemoryRouter。 */
function renderOnboarding() {
  return render(<OnboardingPage />);
}

describe('OnboardingPage', () => {
  it('renders the welcome step on mount', () => {
    renderOnboarding();
    expect(screen.getByRole('heading', { name: 'Welcome' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Get started' })).toBeInTheDocument();
  });

  it('progress bar reflects 3-step structure', () => {
    renderOnboarding();
    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuemax', '3');
    expect(bar).toHaveAttribute('aria-valuenow', '1');
  });

  it('Get started moves to mode-select', () => {
    renderOnboarding();
    fireEvent.click(screen.getByRole('button', { name: 'Get started' }));
    expect(screen.getByRole('heading', { name: 'Pick a mode' })).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '2');
  });

  it('local-only mode advances without requiring URL', () => {
    renderOnboarding();
    fireEvent.click(screen.getByRole('button', { name: 'Get started' }));
    fireEvent.click(screen.getByRole('button', { name: /Local-only/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByRole('heading', { name: "You're set" })).toBeInTheDocument();
    /* Local mode shouldn't touch API credentials. */
    expect(setApiCredentials).not.toHaveBeenCalled();
  });

  it('cloud mode requires a valid URL before continuing', () => {
    renderOnboarding();
    fireEvent.click(screen.getByRole('button', { name: 'Get started' }));
    fireEvent.click(screen.getByRole('button', { name: /Sync with ChronoSynth OS/i }));
    /* No URL entered → Continue surfaces a validation error. */
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/Please enter a chrono-synth-os URL/);
    expect(setApiCredentials).not.toHaveBeenCalled();
  });

  it('cloud mode accepts a valid URL and writes it to the API client', async () => {
    renderOnboarding();
    fireEvent.click(screen.getByRole('button', { name: 'Get started' }));
    fireEvent.click(screen.getByRole('button', { name: /Sync with ChronoSynth OS/i }));
    const input = screen.getByLabelText('Server URL');
    fireEvent.change(input, { target: { value: 'https://chrono.example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    /* handleModeNext 是 async（await 清缓存后才进 done），故 waitFor。 */
    await waitFor(() =>
      expect(setApiCredentials).toHaveBeenCalledWith({ baseUrl: 'https://chrono.example.com' }),
    );
    expect(screen.getByRole('heading', { name: "You're set" })).toBeInTheDocument();
  });

  it('Open ChronoSynth marks first-run complete', async () => {
    renderOnboarding();
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

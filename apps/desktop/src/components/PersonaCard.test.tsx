import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PersonaCard } from './PersonaCard';
import type { PersonaRow } from '@/bridge/tauri-commands';

const basePersona: PersonaRow = {
  persona_id: 'p1',
  display_name: 'Ada Lovelace',
  status: 'active',
  visibility: 'private',
  growth_index: 1234.5,
  reputation: 87.3,
  wallet_id: 'w1',
  wallet_balance: 250.5,
  updated_at: '2025-01-01T00:00:00Z',
  synced_at: 1735689600000,
};

describe('PersonaCard', () => {
  it('renders display name + initial avatar', () => {
    render(<PersonaCard persona={basePersona} />);
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByText('A')).toBeInTheDocument();
  });

  it('rounds and locale-formats growth index + reputation', () => {
    render(<PersonaCard persona={basePersona} />);
    expect(screen.getByText(/1,235/)).toBeInTheDocument(); // growth_index rounded
    expect(screen.getByText(/Rep 87/)).toBeInTheDocument();
  });

  it('formats wallet balance as USD when present', () => {
    render(<PersonaCard persona={basePersona} />);
    expect(screen.getByText('$250.50')).toBeInTheDocument();
  });

  it('omits the wallet balance row when balance is null', () => {
    const { container } = render(
      <PersonaCard persona={{ ...basePersona, wallet_balance: null }} />
    );
    expect(container.textContent).not.toMatch(/\$/);
  });

  it('shows ? avatar fallback when display_name is whitespace', () => {
    render(<PersonaCard persona={{ ...basePersona, display_name: '   ' }} />);
    expect(screen.getByText('?')).toBeInTheDocument();
  });
});

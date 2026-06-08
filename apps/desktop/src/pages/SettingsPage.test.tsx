import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SettingsPage } from './SettingsPage';

describe('SettingsPage', () => {
  it('renders heading + placeholder', () => {
    render(<SettingsPage />);
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByText(/App settings coming soon/)).toBeInTheDocument();
  });
});

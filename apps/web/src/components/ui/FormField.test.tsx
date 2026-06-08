import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FormField } from './FormField';

describe('FormField', () => {
  it('renders label', () => {
    render(
      <FormField label="Email">
        {(props) => <input {...props} type="email" />}
      </FormField>
    );
    expect(screen.getByText('Email')).toBeInTheDocument();
  });

  it('passes generated id to children', () => {
    render(
      <FormField label="Name">
        {(props) => <input {...props} type="text" data-testid="input" />}
      </FormField>
    );
    const input = screen.getByTestId('input');
    expect(input.id).toBeTruthy();
    const label = screen.getByText('Name');
    expect(label.getAttribute('for')).toBe(input.id);
  });

  it('shows error message with role=alert', () => {
    render(
      <FormField label="Name" error="Required">
        {(props) => <input {...props} type="text" />}
      </FormField>
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Required');
  });

  it('sets aria-invalid when error is present', () => {
    render(
      <FormField label="Name" error="Bad">
        {(props) => <input {...props} type="text" data-testid="input" />}
      </FormField>
    );
    expect(screen.getByTestId('input').getAttribute('aria-invalid')).toBe('true');
  });

  it('renders description text', () => {
    render(
      <FormField label="Name" description="Enter your full name">
        {(props) => <input {...props} type="text" />}
      </FormField>
    );
    expect(screen.getByText('Enter your full name')).toBeInTheDocument();
  });

  it('shows required indicator', () => {
    render(
      <FormField label="Name" required>
        {(props) => <input {...props} type="text" />}
      </FormField>
    );
    expect(screen.getByText('*')).toBeInTheDocument();
  });
});

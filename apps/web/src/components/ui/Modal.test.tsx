import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Modal } from './Modal';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe('Modal', () => {
  it('renders nothing when closed', () => {
    render(<Modal open={false} onClose={vi.fn()}>Content</Modal>);
    expect(screen.queryByText('Content')).not.toBeInTheDocument();
  });

  it('renders content when open', () => {
    render(<Modal open={true} onClose={vi.fn()}>Hello Modal</Modal>);
    expect(screen.getByText('Hello Modal')).toBeInTheDocument();
  });

  it('renders title with proper id linkage', () => {
    render(<Modal open={true} onClose={vi.fn()} title="My Title">Body</Modal>);
    const title = screen.getByText('My Title');
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-labelledby')).toBe(title.id);
  });

  it('calls onClose when clicking backdrop', () => {
    const onClose = vi.fn();
    render(<Modal open={true} onClose={onClose}>Body</Modal>);
    const backdrop = document.querySelector('[aria-hidden="true"]');
    fireEvent.click(backdrop!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when pressing Escape', () => {
    const onClose = vi.fn();
    render(<Modal open={true} onClose={onClose}>Body</Modal>);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('has role=dialog and aria-modal=true', () => {
    render(<Modal open={true} onClose={vi.fn()}>Body</Modal>);
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
  });

  it('renders footer when provided', () => {
    render(<Modal open={true} onClose={vi.fn()} footer={<button>Save</button>}>Body</Modal>);
    expect(screen.getByText('Save')).toBeInTheDocument();
  });
});

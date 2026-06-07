import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Tabs } from './Tabs';

const items = [
  { id: 'a', label: 'Tab A' },
  { id: 'b', label: 'Tab B' },
  { id: 'c', label: 'Tab C', disabled: true },
];

describe('Tabs', () => {
  it('renders all tab buttons', () => {
    render(<Tabs value="a" onChange={vi.fn()} items={items} renderPanel={id => <div>{id} content</div>} />);
    expect(screen.getByText('Tab A')).toBeInTheDocument();
    expect(screen.getByText('Tab B')).toBeInTheDocument();
    expect(screen.getByText('Tab C')).toBeInTheDocument();
  });

  it('marks the active tab as selected', () => {
    render(<Tabs value="a" onChange={vi.fn()} items={items} renderPanel={id => <div>{id} content</div>} />);
    const tabA = screen.getByText('Tab A');
    expect(tabA.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('Tab B').getAttribute('aria-selected')).toBe('false');
  });

  it('calls onChange when clicking a tab', () => {
    const onChange = vi.fn();
    render(<Tabs value="a" onChange={onChange} items={items} renderPanel={id => <div>{id} content</div>} />);
    fireEvent.click(screen.getByText('Tab B'));
    expect(onChange).toHaveBeenCalledWith('b');
  });

  it('renders the active panel', () => {
    render(<Tabs value="a" onChange={vi.fn()} items={items} renderPanel={id => <div>{id} content</div>} />);
    expect(screen.getByText('a content')).toBeInTheDocument();
  });

  it('has correct ARIA attributes on tab and panel', () => {
    render(<Tabs value="a" onChange={vi.fn()} items={items} renderPanel={id => <div>{id} content</div>} />);
    const tab = screen.getByText('Tab A');
    expect(tab.getAttribute('role')).toBe('tab');
    expect(tab.getAttribute('aria-controls')).toBe('tabpanel-a');
    expect(tab.id).toBe('tab-a');

    const panel = document.getElementById('tabpanel-a');
    expect(panel).toBeInTheDocument();
    expect(panel?.getAttribute('role')).toBe('tabpanel');
    expect(panel?.getAttribute('aria-labelledby')).toBe('tab-a');
  });

  it('supports ArrowRight keyboard navigation', () => {
    const onChange = vi.fn();
    render(<Tabs value="a" onChange={onChange} items={items} renderPanel={id => <div>{id} content</div>} />);
    const tablist = screen.getByRole('tablist');
    fireEvent.keyDown(tablist, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenCalledWith('b');
  });

  it('disables disabled tabs', () => {
    render(<Tabs value="a" onChange={vi.fn()} items={items} renderPanel={id => <div>{id} content</div>} />);
    expect(screen.getByText('Tab C')).toBeDisabled();
  });
});

import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
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

  it('初始聚焦落在第一个表单字段而非关闭按钮', () => {
    render(
      <Modal open={true} onClose={vi.fn()} title="T">
        <input aria-label="field" />
      </Modal>,
    );
    expect(document.activeElement).toBe(screen.getByLabelText('field'));
  });

  it('父组件 re-render（内联 onClose 新引用）不抢走输入框焦点（焦点 bug 回归）', () => {
    /*
     * 复现报告的 bug：调用方常把 onClose 写成内联箭头，每次 render 新引用。用户在 modal 输入
     * 触发父 re-render，若初始聚焦 effect 随 onClose 变化而重跑，会把焦点强拉回第一个可聚焦元素
     * （关闭按钮），导致无法输入。此测试用一个每次 render 传新 onClose 的 Harness 模拟。
     */
    function Harness() {
      const [, setTick] = useState(0);
      return (
        <Modal open={true} onClose={() => {}} title="T">
          <input aria-label="title-input" onChange={() => setTick((n) => n + 1)} />
        </Modal>
      );
    }
    render(<Harness />);
    const input = screen.getByLabelText('title-input') as HTMLInputElement;
    act(() => { input.focus(); });
    expect(document.activeElement).toBe(input);

    /* 模拟输入 → 触发 setState → 父组件 re-render（onClose 变新引用） */
    act(() => { fireEvent.change(input, { target: { value: 'a' } }); });
    act(() => { fireEvent.change(input, { target: { value: 'ab' } }); });

    /* 焦点必须仍在输入框，不得被拉回关闭按钮 */
    expect(document.activeElement).toBe(input);
  });
});

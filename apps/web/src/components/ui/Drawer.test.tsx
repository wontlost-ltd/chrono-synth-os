import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { Drawer } from './Drawer';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe('Drawer', () => {
  it('renders nothing when closed', () => {
    render(<Drawer open={false} onClose={vi.fn()}>Content</Drawer>);
    expect(screen.queryByText('Content')).not.toBeInTheDocument();
  });

  it('renders children when open', () => {
    render(<Drawer open onClose={vi.fn()} title="T">Content</Drawer>);
    expect(screen.getByText('Content')).toBeInTheDocument();
  });

  /*
   * ⚠️ 审计 #417：与 Modal 的「焦点抢夺」是**同一个 bug**——Modal.tsx 早已修好并有
   * 回归用例，Drawer 没跟上，且它 0 测试 0 story，所以无人察觉。
   *
   * 调用方常把 onClose 写成内联箭头（每次 render 新引用）。此前 Drawer 的
   * handleKeyDown 依赖 [onClose]、聚焦 effect 又依赖 [open, handleKeyDown]
   * ⇒ 用户每输入一个字 → 父 re-render → effect 重跑 → 焦点被强拉回关闭按钮，
   * **根本无法输入**。
   */
  it('父组件 re-render（内联 onClose 新引用）不抢走输入框焦点（审计 #417 回归）', () => {
    function Harness() {
      const [, setTick] = useState(0);
      return (
        <Drawer open onClose={() => {}} title="T">
          <input aria-label="drawer-input" onChange={() => setTick((n) => n + 1)} />
        </Drawer>
      );
    }
    render(<Harness />);
    const input = screen.getByLabelText('drawer-input') as HTMLInputElement;
    act(() => { input.focus(); });
    expect(document.activeElement).toBe(input);

    /* 模拟连续输入 → 每次都触发父 re-render（onClose 变新引用）。 */
    act(() => { fireEvent.change(input, { target: { value: 'a' } }); });
    act(() => { fireEvent.change(input, { target: { value: 'ab' } }); });
    act(() => { fireEvent.change(input, { target: { value: 'abc' } }); });

    /* 变异实测：把 effect 依赖改回 [open, handleKeyDown] → 焦点变成关闭按钮，本断言转红。 */
    expect(document.activeElement).toBe(input);
  });

  it('Escape 关闭（onClose 用最新引用，不因 ref 化而失效）', () => {
    const onClose = vi.fn();
    render(<Drawer open onClose={onClose} title="T">Content</Drawer>);
    act(() => { fireEvent.keyDown(document, { key: 'Escape' }); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  /* onCloseRef 化后最容易犯的错是「永远调用第一次传入的 onClose」——
   * 这条锁住 ref 确实随 prop 更新（否则父组件换了回调会静默失效）。 */
  it('onClose 更新后 Escape 调用的是最新回调', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<Drawer open onClose={first} title="T">Content</Drawer>);
    rerender(<Drawer open onClose={second} title="T">Content</Drawer>);
    act(() => { fireEvent.keyDown(document, { key: 'Escape' }); });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

/* TitleBar 跟随系统窗口装饰（decorations:true）：macOS 渲染一条品牌延伸条（原生交通灯由系统画）；
 * 非 macOS 返回 null（系统画完整原生标题栏，避免双标题栏）。平台由 navigator.userAgent 判定。 */

function setUserAgent(ua: string): void {
  Object.defineProperty(window.navigator, 'userAgent', { value: ua, configurable: true });
}

afterEach(() => {
  cleanup();
  vi.resetModules();
});

describe('TitleBar（跟随系统窗口装饰）', () => {
  it('macOS：渲染品牌延伸条（品牌名 + 可拖动区），无自定义窗口按钮（用系统原生交通灯）', async () => {
    setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)');
    const { TitleBar } = await import('./TitleBar');
    render(<TitleBar />);
    /* 品牌名在（macOS 分支渲染）。 */
    expect(screen.getByText('ChronoSynth')).toBeInTheDocument();
    /* 无自定义窗口按钮（系统原生交通灯代替）。 */
    expect(screen.queryByRole('button', { name: 'Close window' })).not.toBeInTheDocument();
  });

  it('非 macOS（Windows）：不渲染（系统画完整原生标题栏，避免双标题栏）', async () => {
    setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
    const { TitleBar } = await import('./TitleBar');
    const { container } = render(<TitleBar />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText('ChronoSynth')).not.toBeInTheDocument();
  });
});

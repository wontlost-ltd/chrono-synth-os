/* 窗口装饰跟随系统（decorations:true）：
 *   - macOS：titleBarStyle:Overlay + hiddenTitle → 系统画原生圆角窗口 + 原生交通灯（透明覆盖在内容上）。
 *     本组件只留一条**内容延伸区**：左侧给原生交通灯让位（pl-20），放品牌名，整条作 drag region。
 *   - Windows/Linux：系统画完整原生标题栏（自带按钮）——本组件**不渲染**，避免双标题栏。
 * 不再有自定义窗口按钮（用系统原生），也不需要 window 控制权限。 */

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent);

export function TitleBar() {
  /* 非 macOS：系统原生标题栏已含标题+按钮，不渲染自定义条（否则双标题栏）。 */
  if (!IS_MAC) return null;

  /* macOS Overlay：一条与原生交通灯等高的品牌条。整条作 drag region（Overlay 模式需自定义 drag region）；
   * 品牌名**窗口居中**（绝对居中，不受左侧交通灯让位影响）。 */
  return (
    <header
      data-tauri-drag-region
      className="relative flex h-9 shrink-0 items-center justify-center border-b border-chrono-border bg-chrono-surface"
    >
      <div className="pointer-events-none flex items-center gap-2">
        <span className="h-4 w-4 rounded-full bg-chrono-primary shadow-sm shadow-chrono-primary/40" />
        <span className="text-sm font-semibold text-chrono-text-primary">ChronoSynth</span>
      </div>
    </header>
  );
}

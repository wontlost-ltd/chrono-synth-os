import { useEffect, useRef, useId, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

interface DrawerProps {
  open: boolean;
  side?: 'right' | 'left';
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
}

const FOCUSABLE = 'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function Drawer({ open, side = 'right', onClose, title, children }: DrawerProps) {
  const drawerRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const { t } = useTranslation();
  const titleId = useId();

  /*
   * ⚠️ 审计 #417（与 Modal.tsx:23-31 同一个 bug，那边早已修好、这边没跟上）：
   * onClose 常被调用方写成内联箭头（每次 render 新引用）。此前 handleKeyDown 依赖
   * [onClose]、聚焦 effect 又依赖 [open, handleKeyDown] ⇒ 用户每输入一个字
   * → 父组件 re-render → effect 重跑 → `querySelector(FOCUSABLE).focus()`
   * 把焦点强拉回第一个可聚焦元素（关闭按钮），**用户根本无法输入**；
   * 且 `previousFocusRef` 被当前焦点反复覆写，关闭后的焦点还原也一并失效。
   *
   * 实测：输入一个字符后 activeElement 从 <input> 变成 <button aria-label="dismiss">。
   *
   * 修法同 Modal：用 ref 持有最新 onClose，聚焦/监听器 effect **只依赖 [open]**，
   * 仅在 open 切换时跑一次，绝不随 render 重跑。
   */
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current = document.activeElement as HTMLElement;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onCloseRef.current(); return; }
      if (e.key !== 'Tab') return;

      const focusable = drawerRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (!focusable?.length) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;

      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    drawerRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = '';
      previousFocusRef.current?.focus();
    };
  }, [open]);

  if (!open) return null;

  const positionClass = side === 'right' ? 'right-0' : 'left-0';

  return createPortal(
    <div className="fixed inset-0 z-50 flex">
      <div className="fixed inset-0 bg-black/40" aria-hidden="true" onClick={onClose} />
      <div
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        className={`absolute top-0 ${positionClass} z-10 flex h-full w-full max-w-md flex-col bg-surface-elevated shadow-lg`}
      >
        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          {title && <h2 id={titleId} className="text-lg font-semibold text-text-primary">{title}</h2>}
          <button type="button" onClick={onClose} className="ml-auto rounded p-1 text-text-secondary hover:bg-surface" aria-label={t('common.dismiss')}>✕</button>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-4">{children}</div>
      </div>
    </div>,
    document.body
  );
}

import { useEffect, useRef, useId, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  children: ReactNode;
}

const SIZE_MAP = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl' } as const;
const FOCUSABLE = '[autofocus],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function Modal({ open, onClose, title, footer, size = 'md', children }: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const { t } = useTranslation();
  const titleId = useId();

  /*
   * Bug 修复（焦点抢夺）：onClose 常被调用方写成内联箭头（每次 render 新引用）。若把它直接放进
   * 初始聚焦 effect 的依赖，会导致用户每输入一个字 → 父组件 re-render → effect 重跑 →
   * dialogRef.querySelector(FOCUSABLE).focus() 把焦点强拉回第一个可聚焦元素（关闭按钮），
   * 用户根本无法输入。修法：用 ref 持有最新 onClose，初始聚焦/监听器 effect **只依赖 [open]**，
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
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])'
      );
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
    /* 初始聚焦优先落在第一个表单字段（input/textarea/select）而非标题栏的关闭按钮，
     * 让用户打开 modal 即可直接输入；无字段时回退到首个可聚焦元素。 */
    const dialog = dialogRef.current;
    const firstField = dialog?.querySelector<HTMLElement>(
      'input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[autofocus]'
    );
    (firstField ?? dialog?.querySelector<HTMLElement>(FOCUSABLE))?.focus();
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = '';
      previousFocusRef.current?.focus();
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="fixed inset-0 bg-black/40" aria-hidden="true" onClick={onClose} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        className={`relative z-10 w-full ${SIZE_MAP[size]} rounded-xl bg-surface-elevated shadow-lg`}
      >
        {title && (
          <div className="flex items-center justify-between border-b border-border px-6 py-4">
            <h2 id={titleId} className="text-lg font-semibold text-text-primary">{title}</h2>
            <button type="button" onClick={onClose} className="rounded p-1 text-text-secondary hover:bg-surface" aria-label={t('common.dismiss')}>✕</button>
          </div>
        )}
        <div className="px-6 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-border px-6 py-3">{footer}</div>}
      </div>
    </div>,
    document.body
  );
}

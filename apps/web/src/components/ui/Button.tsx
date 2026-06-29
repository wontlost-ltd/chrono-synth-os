import type { ButtonHTMLAttributes, ReactNode } from 'react';

/**
 * 统一按钮组件。
 *
 * 此前全站 162 个 <button> 全是 inline class，主/次/危险/成功各页各写一套，
 * 还散落 bg-green-600 / bg-indigo-600 等**硬编码彩虹色**（绕过设计 token，破坏品牌一致性，
 * 用户无法建立「哪种按钮=什么语义」的心智）。本组件收敛为 5 个语义 variant + 3 档 size，
 * 全部走设计 token（--color-primary/error/success 等），消灭硬编码颜色。
 *
 * 禁用态：native disabled + 全局 `button:disabled{cursor:not-allowed}`（globals.css）已覆盖光标；
 * 这里再补 disabled:opacity-50 统一变暗。
 */
type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'success' | 'ghost';
type ButtonSize = 'sm' | 'md' | 'lg';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  children: ReactNode;
}

/* variant → 语义色（全部走 token，零硬编码 hex）。
 * success/danger 用状态色 token；secondary 描边；ghost 无背景仅 hover。
 * success/danger 用实色按钮专用 fill token（与 badge 文本色 success/danger 解耦，dark 主题需更深以承载白字）。
 * hover 策略：白字按钮 hover 必须**变深**保持白字对比≥AA——primary hover 用 --color-primary-active
 * （白字 6.7:1 过 AA）而非 --color-primary-light（更亮的蓝，白字 light 3.68/dark 2.54 不达标——
 * Codex 交叉审查发现：默认态改 AA 但 hover 态反而退回不合格）。success/danger 无 -dark token，
 * 用 opacity-90 轻暗（在已 AA 的实色上轻暗仍安全）。 */
const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-white hover:bg-primary-active',
  secondary: 'border border-border text-text-primary hover:bg-surface',
  danger: 'bg-error-fill text-white hover:opacity-90',
  success: 'bg-success-fill text-white hover:opacity-90',
  ghost: 'text-text-secondary hover:bg-surface hover:text-text-primary',
};

const SIZE_CLASS: Record<ButtonSize, string> = {
  sm: 'px-3 py-1 text-xs',
  md: 'px-4 py-2 text-sm',
  lg: 'px-5 py-2.5 text-base',
};

export function Button({
  variant = 'primary',
  size = 'md',
  type = 'button',
  className = '',
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${VARIANT_CLASS[variant]} ${SIZE_CLASS[size]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

export type { ButtonVariant, ButtonSize };

/**
 * 安全错误分类横幅
 * 根据错误类型显示不同的指引：配额超限、限流、策略违规、通用错误
 */
import { useTranslation } from 'react-i18next';

export type SafetyErrorKind = 'quota' | 'rate_limit' | 'policy' | 'generic';

interface SafetyErrorBannerProps {
  kind: SafetyErrorKind;
  message: string;
  retryAfter?: number;
  onDismiss?: () => void;
}

/* 此函数对后端 *返回内容* 做关键字匹配以做错误归类。
 * 后端错误消息可能是中文或英文，匹配字符串本身不是 UI 文案 —
 * 不需要走 t()，反而 i18n 会把它"翻译"成无法匹配的版本。
 * 当后端切到结构化 error code 后这个函数会被替换为 code-based 分类。 */
function classifyError(message: string): SafetyErrorKind {
  const lower = message.toLowerCase();
  if (lower.includes('quota') || lower.includes('配额')) return 'quota'; // i18n-allow-cjk: backend keyword match
  if (lower.includes('rate') || lower.includes('限流') || lower.includes('频繁')) return 'rate_limit'; // i18n-allow-cjk: backend keyword match
  if (lower.includes('policy') || lower.includes('安全策略') || lower.includes('注入')) return 'policy'; // i18n-allow-cjk: backend keyword match
  return 'generic';
}

const KIND_STYLES: Record<SafetyErrorKind, { bg: string; border: string; icon: string }> = {
  quota: { bg: 'bg-warning/10', border: 'border-warning/30', icon: 'text-warning' },
  rate_limit: { bg: 'bg-accent/10', border: 'border-accent/30', icon: 'text-accent' },
  policy: { bg: 'bg-error/10', border: 'border-error/30', icon: 'text-error' },
  generic: { bg: 'bg-warning/10', border: 'border-warning/30', icon: 'text-warning' },
};

export function SafetyErrorBanner({ kind, message, retryAfter, onDismiss }: SafetyErrorBannerProps) {
  const { t } = useTranslation();
  const styles = KIND_STYLES[kind];

  return (
    <div
      className={`flex items-start gap-3 rounded-lg border ${styles.border} ${styles.bg} px-4 py-3`}
      role="alert"
    >
      <div className="flex-1 min-w-0">
        <p className={`text-sm font-medium ${styles.icon}`}>
          {t(`safetyError.${kind}Title`)}
        </p>
        <p className="mt-0.5 text-xs text-text-secondary">{message}</p>
        {kind === 'rate_limit' && retryAfter != null && (
          <p className="mt-1 text-xs text-text-secondary">
            {t('safetyError.retryAfter', { seconds: retryAfter })}
          </p>
        )}
        {kind === 'quota' && (
          <a href="/billing" className="mt-1 inline-block text-xs font-medium text-primary hover:underline">
            {t('safetyError.upgradePlan')}
          </a>
        )}
      </div>
      {onDismiss && (
        <button
          onClick={onDismiss}
          className="shrink-0 text-text-secondary hover:text-text-primary"
          aria-label={t('common.dismiss')}
        >
          &times;
        </button>
      )}
    </div>
  );
}

/** 自动分类错误消息并返回对应的 kind */
SafetyErrorBanner.classifyError = classifyError;

import { useTranslation } from 'react-i18next';

interface Step {
  id: string;
  label: string;
  description?: string;
}

interface StepperProps {
  steps: Step[];
  currentId: string;
}

export function Stepper({ steps, currentId }: StepperProps) {
  const { t } = useTranslation();
  const currentIdx = steps.findIndex(s => s.id === currentId);

  return (
    <nav aria-label={t('stepper.ariaLabel')}>
      <ol className="flex flex-col gap-2 sm:flex-row sm:gap-0">
        {/* a11y 配色说明：upcoming 态原本用调色板刻度 neutral-2/neutral-3 当
          * 边框与文字色，在 dark canvas 上分别只有 2.63 / 4.18——前者不达非文本
          * AA(3.0)、后者不达 14px 正文 AA(4.5)。已全部换成语义 token：
          * 文字 text-text-secondary(9.46)、边框与连接线 border-strong / bg-border-strong(4.18)。
          * 注意 neutral-* 是调色板刻度、非语义文本色，不应直接当正文色用。 */}
        {steps.map((step, idx) => {
          const status = idx < currentIdx ? 'complete' : idx === currentIdx ? 'current' : 'upcoming';
          const isLast = idx === steps.length - 1;

          return (
            <li
              key={step.id}
              className="flex flex-1 items-center"
              aria-current={status === 'current' ? 'step' : undefined}
            >
              <div className="flex items-center gap-2">
                <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-medium
                  ${status === 'complete' ? 'bg-primary text-white' : ''}
                  ${status === 'current' ? 'border-2 border-primary text-primary-text' : ''}
                  ${status === 'upcoming' ? 'border-2 border-border-strong text-text-secondary' : ''}`}
                >
                  {status === 'complete' ? '✓' : idx + 1}
                </div>
                <div className="min-w-0">
                  {/* 未到达步骤的标签是 14px 正文，需 AA 4.5：neutral-3(#64748B)
                    * 在 dark canvas 上仅 4.18 不达标（text-tertiary 4.38 同样差一点），
                    * 故用 text-secondary(9.46)。neutral-* 是调色板刻度、非语义文本
                    * token，本就不该直接当正文色用。 */}
                  <p className={`text-sm font-medium ${status === 'upcoming' ? 'text-text-secondary' : 'text-text-primary'}`}>
                    {step.label}
                  </p>
                  {step.description && (
                    <p className="text-xs text-text-secondary">{step.description}</p>
                  )}
                </div>
              </div>
              {/* 连接线与圆圈边框原同为 neutral-2(#475569)，在 dark canvas 上 2.63
                * 不达非文本 AA(3.0)。axe 抓不到它（axe-core 只有 color-contrast 文本
                * 规则、无非文本对比度规则），故靠人工核对换成 border-strong(4.18)。 */}
              {!isLast && (
                <div className={`mx-3 hidden h-0.5 flex-1 sm:block ${idx < currentIdx ? 'bg-primary' : 'bg-border-strong'}`} />
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

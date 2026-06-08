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
                  ${status === 'current' ? 'border-2 border-primary text-primary' : ''}
                  ${status === 'upcoming' ? 'border-2 border-neutral-2 text-neutral-3' : ''}`}
                >
                  {status === 'complete' ? '✓' : idx + 1}
                </div>
                <div className="min-w-0">
                  <p className={`text-sm font-medium ${status === 'upcoming' ? 'text-neutral-3' : 'text-text-primary'}`}>
                    {step.label}
                  </p>
                  {step.description && (
                    <p className="text-xs text-text-secondary">{step.description}</p>
                  )}
                </div>
              </div>
              {!isLast && (
                <div className={`mx-3 hidden h-0.5 flex-1 sm:block ${idx < currentIdx ? 'bg-primary' : 'bg-neutral-2'}`} />
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

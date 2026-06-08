import { useId, type ReactNode } from 'react';

interface FormFieldProps {
  label: string;
  description?: string;
  error?: string;
  required?: boolean;
  children: (props: { id: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean }) => ReactNode;
}

export function FormField({ label, description, error, required, children }: FormFieldProps) {
  const base = useId();
  const inputId = `${base}-input`;
  const descId = description ? `${base}-desc` : undefined;
  const errorId = error ? `${base}-error` : undefined;
  const describedBy = [descId, errorId].filter(Boolean).join(' ') || undefined;

  return (
    <div className="space-y-1.5">
      <label htmlFor={inputId} className="block text-sm font-medium text-text-primary">
        {label}
        {required && <span className="ml-0.5 text-warning">*</span>}
      </label>
      {description && (
        <p id={descId} className="text-xs text-text-secondary">{description}</p>
      )}
      {children({ id: inputId, 'aria-describedby': describedBy, 'aria-invalid': !!error })}
      {error && (
        <p id={errorId} role="alert" className="text-xs text-warning">{error}</p>
      )}
    </div>
  );
}

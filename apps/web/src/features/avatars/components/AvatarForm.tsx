import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormField } from '../../../components/ui/FormField';

const KINDS = ['general', 'work', 'social', 'family', 'creative'] as const;

type AvatarKind = typeof KINDS[number];

interface AvatarFormProps {
  initial?: { label: string; kind: AvatarKind };
  onSubmit: (data: { label: string; kind: AvatarKind }) => void;
  loading?: boolean;
}

export function AvatarForm({ initial, onSubmit, loading }: AvatarFormProps) {
  const { t } = useTranslation();
  const [label, setLabel] = useState(initial?.label ?? '');
  const [kind, setKind] = useState<AvatarKind>(initial?.kind ?? 'general');
  const [error, setError] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!label.trim()) { setError(t('avatars.labelRequired')); return; }
    onSubmit({ label: label.trim(), kind });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <FormField label={t('avatars.labelField')} required error={error}>
        {(props) => (
          <input
            {...props}
            type="text"
            value={label}
            onChange={e => { setLabel(e.target.value); setError(''); }}
            className="w-full rounded-lg border border-border px-3 py-2 text-sm"
            maxLength={50}
          />
        )}
      </FormField>

      <FormField label={t('avatars.kindField')}>
        {(props) => (
          <select
            {...props}
            value={kind}
            onChange={e => setKind(e.target.value as AvatarKind)}
            className="w-full rounded-lg border border-border px-3 py-2 text-sm"
          >
            {KINDS.map(k => (
              <option key={k} value={k}>{t(`avatars.kind.${k}`)}</option>
            ))}
          </select>
        )}
      </FormField>

      <button
        type="submit"
        disabled={loading}
        className="w-full rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-light disabled:opacity-50"
      >
        {loading ? t('common.loading') : (initial ? t('avatars.save') : t('avatars.create'))}
      </button>
    </form>
  );
}

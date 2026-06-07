import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useRegister } from '../api/queries/auth';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

export function Register() {
  const { t } = useTranslation();
  useDocumentTitle(t('register.title'));
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const navigate = useNavigate();
  const register = useRegister();

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (password !== confirm) return;
    register.mutate({ email, password }, {
      onSuccess: () => navigate('/dashboard', { replace: true }),
    });
  }

  const mismatch = confirm.length > 0 && password !== confirm;

  return (
    <main className="flex min-h-dvh items-center justify-center bg-surface p-4">
      <div className="w-full max-w-sm rounded-xl border border-border bg-surface-elevated p-8 shadow-sm">
        <h1 className="mb-6 text-center text-2xl font-bold text-primary">{t('register.title')}</h1>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="email" className="mb-1 block text-sm font-medium text-text-secondary">
              {t('register.emailLabel')}
            </label>
            <input
              id="email"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
          <div>
            <label htmlFor="password" className="mb-1 block text-sm font-medium text-text-secondary">
              {t('register.passwordLabel')}
            </label>
            <input
              id="password"
              type="password"
              required
              minLength={8}
              autoComplete="new-password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
          <div>
            <label htmlFor="confirm" className="mb-1 block text-sm font-medium text-text-secondary">
              {t('register.confirmPasswordLabel')}
            </label>
            <input
              id="confirm"
              type="password"
              required
              autoComplete="new-password"
              value={confirm}
              onChange={e => setConfirm(e.target.value)}
              aria-invalid={mismatch || undefined}
              className={`w-full rounded-lg border bg-surface px-3 py-2 text-sm focus:outline-none focus:ring-1 ${
                mismatch
                  ? 'border-warning focus:border-warning focus:ring-warning'
                  : 'border-border focus:border-primary focus:ring-primary'
              }`}
            />
            {mismatch && <p className="mt-1 text-xs text-warning">{t('register.passwordMismatch')}</p>}
          </div>
          {register.error && (
            <p className="text-sm text-warning" role="alert">{register.error.message}</p>
          )}
          <button
            type="submit"
            disabled={register.isPending || mismatch}
            className="w-full rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-light disabled:opacity-50"
          >
            {register.isPending ? t('register.registering') : t('register.registerButton')}
          </button>
        </form>
        <p className="mt-4 text-center text-sm text-text-secondary">
          {t('register.hasAccount')}
          <Link to="/login" className="ml-1 font-medium text-primary hover:underline">
            {t('register.login')}
          </Link>
        </p>
      </div>
    </main>
  );
}

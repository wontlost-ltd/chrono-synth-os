import { useState, type FormEvent } from 'react';
import { login } from '../auth.js';

/** 登录页（alpha）：邮箱 + 密码 → /api/v1/auth/login，成功后由 App 切到主界面。 */
export function LoginView(): JSX.Element {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(email.trim(), password);
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="view view--login">
      <section className="card">
        <h2 className="card__title">登录</h2>
        <form className="login" onSubmit={onSubmit}>
          <label className="login__field">
            <span>邮箱</span>
            <input
              type="email" autoComplete="email" required
              value={email} onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label className="login__field">
            <span>密码</span>
            <input
              type="password" autoComplete="current-password" required
              value={password} onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          {error && <p className="login__error" role="alert">{error}</p>}
          <button className="login__submit" type="submit" disabled={busy}>
            {busy ? '登录中…' : '登录'}
          </button>
        </form>
        <p className="muted">个人版账号登录后即可查看你的数字人。</p>
      </section>
    </section>
  );
}

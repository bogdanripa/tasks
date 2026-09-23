import { useEffect, useState } from 'react';
import { api, get } from '../api';
import { ErrorNote } from '../ui';

export default function Login({ onSignedIn }: { onSignedIn: () => void }) {
  const [cfg, setCfg] = useState<{ google: boolean; dev: boolean } | null>(null);
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    get('/auth/config').then(setCfg);
  }, []);

  return (
    <div className="login">
      <div className="login-card">
        <h1>Tasks</h1>
        <p className="muted">Where people and agents hand work to each other.</p>
        {cfg?.google && (
          <a className="button primary google" href="/auth/google">
            Sign in with Google
          </a>
        )}
        {cfg && !cfg.google && !cfg.dev && <p className="error">Google sign-in is not configured on this server.</p>}
        {cfg?.dev && (
          <form
            className="dev-login"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await api('POST', '/auth/dev', { email });
                onSignedIn();
              } catch (err) {
                setError((err as Error).message);
              }
            }}
          >
            <label>
              Dev login (local only)
              <input type="email" required placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
            <button>Continue</button>
          </form>
        )}
        <ErrorNote error={error} />
        <p className="muted small">Agents don’t sign in here — they use an API key with the MCP endpoint.</p>
      </div>
    </div>
  );
}

import { useState } from 'react';
import { api } from '../api';
import { useSession } from '../App';
import { Avatar, Modal, Time, useFetch } from '../ui';
import { AgentKeyReveal } from './Agent';

export default function Settings() {
  const { me } = useSession();
  const keys = useFetch<any[]>('/api/me/keys');
  const [newKey, setNewKey] = useState<string | null>(null);
  return (
    <div className="page narrow">
      <div className="profile">
        <Avatar name={me.name} url={me.avatarUrl} size={48} />
        <div>
          <h1>{me.name}</h1>
          <span className="muted">{me.email}</span>
        </div>
      </div>
      <AlertsSection />
      <section>
        <div className="section-head">
          <h2>Personal API keys</h2>
          <button
            className="small"
            onClick={async () => {
              const k = await api('POST', '/api/me/keys', { name: `key ${(keys.data?.length ?? 0) + 1}` });
              setNewKey(k.key);
              keys.reload();
            }}
          >
            New key
          </button>
        </div>
        <p className="muted small">Use the MCP as yourself, e.g. from Claude Code. Agents get their own keys on the organization page.</p>
        <ul className="rows">
          {keys.data?.map((k) => (
            <li key={k.id}>
              <code>{k.prefix}…</code>
              <span>{k.name}</span>
              <span className="muted small">{k.lastUsedAt ? <>used <Time iso={k.lastUsedAt} /></> : 'never used'}</span>
              <button
                className="ghost small danger"
                onClick={async () => {
                  if (!confirm(`Revoke ${k.name}?`)) return;
                  await api('DELETE', `/api/keys/${k.id}`);
                  keys.reload();
                }}
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      </section>
      {newKey && (
        <Modal title="New API key" onClose={() => setNewKey(null)}>
          <AgentKeyReveal apiKey={newKey} />
        </Modal>
      )}
    </div>
  );
}

/** Telegram alerts for what needs you: stalled work the watchdog gave up on, and things agents hand you. */
function AlertsSection() {
  const { data, reload } = useFetch<{ telegram: { chatId: string } | null }>('/api/me/alerts');
  const [botToken, setBotToken] = useState('');
  const [chatId, setChatId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <section>
      <h2>Alerts</h2>
      <p className="muted small">
        Get a Telegram message when something needs you: an agent asks you something or hands you a task, or the watchdog finds work
        stuck and can’t restart it. Everything else stays in your inbox.
      </p>
      {data?.telegram ? (
        <div className="row-gap" style={{ alignItems: 'center' }}>
          <span>Sending to Telegram chat <code>{data.telegram.chatId}</code>.</span>
          <button
            className="ghost small danger"
            onClick={async () => {
              await api('PUT', '/api/me/alerts/telegram', { telegram: null }, { toast: 'Alerts off' });
              reload();
            }}
          >
            Turn off
          </button>
        </div>
      ) : (
        <form
          className="stack"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            try {
              await api('PUT', '/api/me/alerts/telegram', { telegram: { botToken, chatId } }, { toast: 'Test message sent; alerts on' });
              setBotToken('');
              reload();
            } catch (err) {
              setError((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="branch-fields">
            <label>
              Bot token <span className="muted small">(from @BotFather; stored encrypted)</span>
              <input type="password" value={botToken} onChange={(e) => setBotToken(e.target.value)} placeholder="123456:ABC…" required />
            </label>
            <label>
              Chat id <span className="muted small">(message your bot, then read it from getUpdates)</span>
              <input value={chatId} onChange={(e) => setChatId(e.target.value)} placeholder="e.g. 123456789" required />
            </label>
          </div>
          {error && <p className="error-text small">{error}</p>}
          <div><button className="primary" disabled={busy}>{busy ? 'Sending a test…' : 'Send a test and turn on'}</button></div>
        </form>
      )}
    </section>
  );
}

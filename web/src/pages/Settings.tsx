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

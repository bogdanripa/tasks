import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api';
import { CopyField, ErrorNote, Modal, Time, RefLink, useFetch } from '../ui';

export function McpInstructions({ apiKey }: { apiKey: string }) {
  const url = `${location.origin}/mcp`;
  return (
    <div className="stack">
      <p className="small">Add it to Claude Code:</p>
      <CopyField value={`claude mcp add --transport http tasks ${url} --header "Authorization: Bearer ${apiKey}"`} />
      <p className="small">Or any MCP client (Streamable HTTP):</p>
      <pre className="code">{JSON.stringify({ mcpServers: { tasks: { type: 'http', url, headers: { Authorization: `Bearer ${apiKey}` } } } }, null, 2)}</pre>
    </div>
  );
}

export function AgentKeyReveal({ apiKey, webhookSecret }: { apiKey: string; webhookSecret?: string | null }) {
  return (
    <div className="stack">
      <p className="warn">Copy the API key now. It won’t be shown again.</p>
      <CopyField value={apiKey} />
      {webhookSecret && (
        <>
          <p className="small">
            Webhook signing secret. Verify <code>X-Tasks-Signature</code> = <code>sha256=HMAC(secret, timestamp + "." + body)</code>:
          </p>
          <CopyField value={webhookSecret} />
        </>
      )}
      <McpInstructions apiKey={apiKey} />
    </div>
  );
}

export default function AgentPage() {
  const { id } = useParams();
  const { data, error, reload } = useFetch<any>(`/api/agents/${id}`);
  const [webhook, setWebhook] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [showSecret, setShowSecret] = useState(false);

  if (error) return <div className="page"><ErrorNote error={error} /></div>;
  if (!data) return <div className="page muted">Loading…</div>;
  const { agent, keys, deliveries } = data;
  const hook = webhook ?? agent.webhookUrl ?? '';

  return (
    <div className="page narrow">
      <h1>{agent.name} <span className="badge agent">agent</span></h1>

      <section>
        <h2>Webhook</h2>
        <p className="muted small">Receives a signed POST whenever this agent is assigned work, commented on, or unblocked. Without one, the agent calls <code>wait_for_work</code> or <code>get_inbox</code> over MCP.</p>
        <form
          className="inline-form"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await api('PATCH', `/api/agents/${id}`, { webhookUrl: hook || null });
              setWebhook(null);
              setSaveError(null);
              reload();
            } catch (err) {
              setSaveError((err as Error).message);
            }
          }}
        >
          <input placeholder="https://…" value={hook} onChange={(e) => setWebhook(e.target.value)} />
          <button>Save</button>
        </form>
        <ErrorNote error={saveError} />
        {agent.webhookUrl && (
          <p className="small">
            Signing secret:{' '}
            {showSecret ? <code>{agent.webhookSecret}</code> : <button className="link" onClick={() => setShowSecret(true)}>reveal</button>}
          </p>
        )}
      </section>

      <section>
        <div className="section-head">
          <h2>API keys</h2>
          <button
            className="small"
            onClick={async () => {
              const k = await api('POST', `/api/agents/${id}/keys`, { name: `key ${keys.length + 1}` });
              setNewKey(k.key);
              reload();
            }}
          >
            New key
          </button>
        </div>
        <ul className="rows">
          {keys.map((k: any) => (
            <li key={k.id}>
              <code>{k.prefix}…</code>
              <span>{k.name}</span>
              <span className="muted small">{k.lastUsedAt ? <>used <Time iso={k.lastUsedAt} /></> : 'never used'}</span>
              <button
                className="ghost small danger"
                onClick={async () => {
                  if (!confirm(`Revoke ${k.name}? Anything using it stops working.`)) return;
                  await api('DELETE', `/api/keys/${k.id}`);
                  reload();
                }}
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2>Recent notifications</h2>
        {deliveries.length === 0 && <p className="muted">None yet.</p>}
        <ul className="rows">
          {deliveries.map((n: any) => (
            <li key={n.id}>
              <span>{n.reason.replace(/_/g, ' ')}</span>
              {n.itemRef && <RefLink refStr={n.itemRef} />}
              <span className={`delivery ${n.deliveryStatus ?? 'inbox'}`} title={n.lastError ?? ''}>
                {n.deliveryStatus ?? 'inbox only'}
                {n.attempts > 1 && ` (${n.attempts} tries)`}
              </span>
              <span className="muted small">{n.readAt ? 'read' : 'unread'}</span>
              <Time iso={n.createdAt} />
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

import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
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

type Mode = 'routine' | 'webhook' | 'poll';

export default function AgentPage() {
  const { id } = useParams();
  const { data, error, reload } = useFetch<any>(`/api/agents/${id}`);
  const [mode, setMode] = useState<Mode | null>(null);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const navigate = useNavigate();

  // Queue and runs change while agents work.
  useEffect(() => {
    const t = setInterval(() => document.visibilityState === 'visible' && reload(), 10_000);
    return () => clearInterval(t);
  }, [reload]);

  if (error) return <div className="page"><ErrorNote error={error} /></div>;
  if (!data) return <div className="page muted">Loading…</div>;
  const { agent, keys, deliveries, runs, queue, pause, routine } = data;
  const current: Mode = agent.routineUrl ? 'routine' : agent.webhookUrl ? 'webhook' : 'poll';
  const shown = mode ?? current;

  return (
    <div className="page narrow">
      {renaming === null ? (
        <h1 onClick={() => setRenaming(agent.name)} title="Click to rename" style={{ cursor: 'text' }}>
          {agent.name} <span className="badge agent">agent</span>
        </h1>
      ) : (
        <form
          className="inline-form"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await api('PATCH', `/api/agents/${id}`, { name: renaming.trim() });
              setRenaming(null);
              reload();
            } catch (err) {
              alert((err as Error).message);
            }
          }}
        >
          <input autoFocus value={renaming} onChange={(e) => setRenaming(e.target.value)} className="title-input" />
          <button className="primary">Rename</button>
          <button type="button" className="ghost" onClick={() => setRenaming(null)}>Cancel</button>
        </form>
      )}

      <section>
        <h2>How this agent gets work</h2>
        <div className="segmented" role="tablist">
          {([['routine', 'Claude routine'], ['webhook', 'Webhook'], ['poll', 'MCP polling']] as [Mode, string][]).map(([m, label]) => (
            <button key={m} className={shown === m ? 'on' : ''} onClick={() => setMode(m)}>
              {label}
              {current === m && ' ✓'}
            </button>
          ))}
        </div>
        {shown === 'routine' && <RoutineSetup agent={agent} routine={routine} onSaved={() => { setMode(null); reload(); }} />}
        {shown === 'webhook' && <WebhookSetup agent={agent} onSaved={() => { setMode(null); reload(); }} />}
        {shown === 'poll' && (
          <div className="stack setup">
            <p className="small">The agent connects to the Tasks MCP with an API key and calls <code>wait_for_work</code> (or <code>get_inbox</code>) to pick up assignments.</p>
            {current !== 'poll' && (
              <button
                className="small"
                onClick={async () => {
                  await api('PATCH', `/api/agents/${id}`, { routineUrl: null, webhookUrl: null });
                  setMode(null);
                  reload();
                }}
              >
                Switch to polling
              </button>
            )}
          </div>
        )}
      </section>

      {current === 'routine' && (
        <section>
          <h2>Runs</h2>
          {pause && <p className="warn">Routine runs in this organization are paused until {new Date(pause.until).toLocaleTimeString()} (Anthropic rate limit). Updates keep queuing.</p>}
          <p className="small muted">
            One run at a time. {queue.updates > 0
              ? <>Queued: {queue.updates} update{queue.updates > 1 ? 's' : ''} on {queue.items} task{queue.items > 1 ? 's' : ''}{queue.nextAt && <>, next check <Time iso={queue.nextAt} /></>}.</>
              : 'Nothing queued.'}
          </p>
          {runs.length === 0 && <p className="muted">No runs yet. Assign a task to {agent.name} to start one.</p>}
          <ul className="rows">
            {runs.map((r: any) => (
              <li key={r.id}>
                <RunState run={r} />
                {r.itemRef && <RefLink refStr={r.itemRef} />}
                <span className="grow muted small">{r.error ?? r.reasons.map((x: string) => x.replace(/_/g, ' ')).join(', ')}</span>
                {r.sessionUrl && <a href={r.sessionUrl} target="_blank" rel="noreferrer" className="small">session ↗</a>}
                <Time iso={r.createdAt} />
              </li>
            ))}
          </ul>
        </section>
      )}

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
        <p className="muted small">For MCP or webhook agents. Routine runs get their own short-lived token each time.</p>
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
              <DeliveryState n={n} mode={current} />
              <span className="muted small">{n.readAt ? 'read' : 'unread'}</span>
              <Time iso={n.createdAt} />
            </li>
          ))}
        </ul>
      </section>

      <section className="danger-zone">
        <div>
          <h2>Delete agent</h2>
          <p className="muted small">Revokes its keys, stops its webhook or routine and unassigns its open items. Its past comments and history stay.</p>
        </div>
        <button
          className="danger"
          onClick={async () => {
            if (!confirm(`Delete ${agent.name}? This can't be undone.`)) return;
            const res = await api('DELETE', `/api/agents/${id}`);
            alert(`${agent.name} was deleted${res.unassigned ? ` and ${res.unassigned} open item${res.unassigned > 1 ? 's were' : ' was'} unassigned` : ''}.`);
            navigate(`/${agent.orgSlug}`);
          }}
        >
          Delete…
        </button>
      </section>

      {newKey && (
        <Modal title="New API key" onClose={() => setNewKey(null)}>
          <AgentKeyReveal apiKey={newKey} />
        </Modal>
      )}
    </div>
  );
}

const SKIP_REASONS: Record<string, string> = {
  'in backlog': 'in Backlog',
  'not assigned to this agent': 'no longer assigned',
  throttled: 'run limit reached',
  'agent deleted': 'agent deleted',
};

/** What happened, or will happen, to one notification's ping. */
function DeliveryState({ n, mode }: { n: any; mode: Mode }) {
  const [cls, label] = ((): [string, string] => {
    switch (n.deliveryStatus) {
      case 'pending': {
        if (n.itemInBacklog) return ['', 'in Backlog · won’t ping'];
        const secs = Math.round((new Date(n.nextAttemptAt).getTime() - Date.now()) / 1000);
        if (secs <= 0) return ['pending', 'sending…'];
        const wait = secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`;
        return ['pending', n.attempts > 0 ? `retrying in ${wait}` : `pings in ${wait}`];
      }
      case 'delivered':
        return ['delivered', mode === 'routine' ? 'run started' : 'sent'];
      case 'skipped':
        return ['', `skipped · ${SKIP_REASONS[n.lastError] ?? n.lastError ?? 'not sent'}`];
      case 'failed':
        return ['failed', n.attempts > 1 ? `failed after ${n.attempts} tries` : 'failed'];
      default:
        return ['', 'inbox only'];
    }
  })();
  return (
    <span className={`delivery ${cls}`} title={n.lastError ?? ''}>
      {label}
    </span>
  );
}

function RunState({ run }: { run: any }) {
  if (run.status === 'failed') return <span className="delivery failed">failed</span>;
  if (run.finishedAt) return <span className="delivery delivered">done</span>;
  const last = new Date(run.lastUsedAt ?? run.createdAt).getTime();
  return Date.now() - last < 20 * 60_000 ? <span className="delivery pending">running</span> : <span className="delivery">timed out</span>;
}

function RoutineSetup({ agent, routine, onSaved }: { agent: any; routine: any; onSaved: () => void }) {
  const [url, setUrl] = useState<string>(agent.routineUrl ?? '');
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="stack setup">
      <p className="small">
        Changes to a task assigned to {agent.name} start a run of its routine once the task has been quiet for a couple of minutes, one run at a time
        (tasks in Backlog never do). The run gets the task and a
        short-lived token that acts as {agent.name}, does the work, comments and sets the task’s status.
      </p>
      <ol className="steps small">
        <li>
          At <a href="https://claude.ai/code/routines" target="_blank" rel="noreferrer">claude.ai/code/routines</a>, create a routine for this agent, with the trigger <b>Call via API</b>. Add the connectors it needs for its job.
        </li>
        <li>
          Paste these Instructions, then replace the last line with this agent’s role:
          <pre className="code">{routine.instructions}</pre>
          <CopyField value={routine.instructions} buttonOnly />
        </li>
        <li>
          In the routine’s cloud environment, set <b>Network access</b> to <b>Custom</b> and allow <code>{routine.allowDomain}</code>. Without it, the run can’t reach Tasks.
        </li>
        <li>Save the routine, then paste its API URL and token here:</li>
      </ol>
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api('PATCH', `/api/agents/${agent.id}`, { routineUrl: url, ...(token ? { routineToken: token } : {}) });
            setToken('');
            setError(null);
            onSaved();
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      >
        <label>
          Routine API URL
          <input required placeholder="https://api.anthropic.com/v1/claude_code/routines/…/fire" value={url} onChange={(e) => setUrl(e.target.value)} />
        </label>
        <label>
          Routine API token
          <input
            type="password"
            required={!agent.hasRoutineToken}
            placeholder={agent.hasRoutineToken ? 'Saved. Paste a new one to replace it.' : 'sk-ant-oat01-…'}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            autoComplete="off"
          />
          <span className="hint">Stored encrypted. It’s only ever sent to Anthropic, to start runs.</span>
        </label>
        <ErrorNote error={error} />
        <div className="actions">
          <button className="primary">Save routine</button>
        </div>
      </form>
    </div>
  );
}

function WebhookSetup({ agent, onSaved }: { agent: any; onSaved: () => void }) {
  const [hook, setHook] = useState<string>(agent.webhookUrl ?? '');
  const [error, setError] = useState<string | null>(null);
  const [showSecret, setShowSecret] = useState(false);
  return (
    <div className="stack setup">
      <p className="small">Receives a signed POST whenever this agent is assigned work, commented on or unblocked.</p>
      <form
        className="inline-form"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api('PATCH', `/api/agents/${agent.id}`, { webhookUrl: hook || null, routineUrl: null });
            setError(null);
            onSaved();
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      >
        <input placeholder="https://…" value={hook} onChange={(e) => setHook(e.target.value)} />
        <button>Save</button>
      </form>
      <ErrorNote error={error} />
      {agent.webhookUrl && (
        <p className="small">
          Signing secret:{' '}
          {showSecret ? <code>{agent.webhookSecret}</code> : <button className="link" onClick={() => setShowSecret(true)}>reveal</button>}
        </p>
      )}
    </div>
  );
}

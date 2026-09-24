import { useState } from 'react';
import { api } from '../api';
import { ErrorNote, useFetch } from '../ui';

type Connector = {
  id: string;
  name: string;
  url: string;
  auth: 'none' | 'header' | 'oauth';
  headerName: string | null;
  hasHeaderValue: boolean;
  oauthConnected: boolean;
  allowedTools: string[] | null;
  scope: 'org' | 'project' | 'agent';
  projectKey: string | null;
  enabled?: boolean;
};
type Tool = { name: string; description: string; allowed: boolean };

/**
 * MCP connectors at one level: the org (every agent), a project (agents working on its items) or one agent.
 * A run gets all three. `base` is the level's API path, e.g. /api/orgs/acme.
 */
export function ConnectorsSection({ base, level }: { base: string; level: 'org' | 'project' | 'agent' }) {
  const { data, error, reload } = useFetch<{ connectors: Connector[]; inherited: Connector[]; available?: Connector[] }>(`${base}/connectors`);
  const [adding, setAdding] = useState(false);
  const intro = {
    org: 'MCP servers for the whole organization. Each agent switches on the ones it uses (Agent → Connectors).',
    project: 'MCP servers for this project. Agents that switch one on get it only while working on this project’s items.',
    agent: 'MCP servers only this agent uses.',
  }[level];

  if (error) return <ErrorNote error={error} />;
  if (!data) return <p className="muted">Loading…</p>;
  return (
    <div className="stack">
      {level === 'agent' && <UseConnectors agentBase={base} available={data.available ?? []} onChange={reload} />}
      {level === 'agent' && <h3 className="connectors-own">Only this agent</h3>}
      <p className="muted small">
        {intro} Their tools are named after the connector, e.g. <code>pironman__apps_list</code>. Choose which tools agents may use, so a
        connector can be shared without its dangerous tools. (Agents on Claude Code routines use connectors set up in claude.ai instead.)
      </p>
      {level === 'project' && data.inherited.length > 0 && (
        <p className="small">
          The organization’s connectors (each agent switches them on): {data.inherited.map((c) => <code key={c.id} className="inherited">{c.name}</code>)}
        </p>
      )}
      {data.connectors.length === 0 && !adding && <p className="muted">No connectors here yet.</p>}
      <ul className="rows connectors">
        {data.connectors.map((c) => <ConnectorRow key={c.id} c={c} onChange={reload} />)}
      </ul>
      {adding ? (
        <AddConnector base={base} onDone={() => { setAdding(false); reload(); }} onCancel={() => setAdding(false)} />
      ) : (
        <div><button className="small" onClick={() => setAdding(true)}>Add connector</button></div>
      )}
    </div>
  );
}

/** Switches for the org's and projects' connectors: which ones this agent uses. */
function UseConnectors({ agentBase, available, onChange }: { agentBase: string; available: Connector[]; onChange: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <div className="stack">
      <h3>From the organization and projects</h3>
      {available.length === 0 ? (
        <p className="muted small">None defined yet. Add them in Organization or Project settings → Connectors, then switch them on here.</p>
      ) : (
        <div className="switch-list">
          {available.map((c) => (
            <label key={c.id} className={`switch-row ${c.enabled ? 'on' : ''}`}>
              <input
                type="checkbox"
                role="switch"
                checked={!!c.enabled}
                disabled={busy === c.id}
                onChange={async (e) => {
                  setBusy(c.id);
                  try {
                    await api('PUT', `${agentBase}/connectors/${c.id}`, { enabled: e.target.checked }, { toast: e.target.checked ? `${c.name} on` : `${c.name} off` });
                    onChange();
                  } finally {
                    setBusy(null);
                  }
                }}
              />
              <span className="switch" aria-hidden />
              <b>{c.name}</b>
              <span className="muted small">
                {c.scope === 'project' ? `project ${c.projectKey}, only on its items` : 'organization'} ·{' '}
                {c.allowedTools ? `${c.allowedTools.length} tools` : 'all tools'}
              </span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

function ConnectorRow({ c, onChange }: { c: Connector; onChange: () => void }) {
  const [tools, setTools] = useState<Tool[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [header, setHeader] = useState<string | null>(null);

  const loadTools = async () => {
    setBusy(true);
    setError(null);
    try {
      const t = await api<Tool[]>('POST', `/api/connectors/${c.id}/test`);
      setTools(t);
      setPicked(new Set(t.filter((x) => x.allowed).map((x) => x.name)));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const status =
    c.auth === 'oauth' ? (c.oauthConnected ? 'signed in' : 'not signed in') : c.auth === 'header' ? `${c.headerName} header` : 'no auth';

  return (
    <li className="connector">
      <div className="connector-head">
        <b>{c.name}</b>
        <span className="muted small grow connector-url">{c.url}</span>
        <span className={`small ${c.auth === 'oauth' && !c.oauthConnected ? 'error-text' : 'muted'}`}>{status}</span>
        <span className="small muted">{c.allowedTools ? `${c.allowedTools.length} tools allowed` : 'all tools'}</span>
        {c.auth === 'oauth' && <a className="button small" href={`/api/connectors/${c.id}/oauth`}>{c.oauthConnected ? 'Reconnect' : 'Connect'}</a>}
        {c.auth === 'header' && <button className="ghost small" onClick={() => setHeader(header === null ? '' : null)}>Change key</button>}
        <button className="ghost small" onClick={() => (tools ? setTools(null) : loadTools())} disabled={busy}>
          {busy ? 'Connecting…' : tools ? 'Hide tools' : 'Test & tools'}
        </button>
        <button
          className="ghost small danger"
          onClick={async () => {
            if (!confirm(`Remove the ${c.name} connector? Agents lose its tools.`)) return;
            await api('DELETE', `/api/connectors/${c.id}`);
            onChange();
          }}
        >
          Remove
        </button>
      </div>
      {header !== null && (
        <form
          className="row-gap"
          onSubmit={async (e) => {
            e.preventDefault();
            await api('PATCH', `/api/connectors/${c.id}`, { headerValue: header });
            setHeader(null);
            onChange();
          }}
        >
          <input type="password" value={header} onChange={(e) => setHeader(e.target.value)} placeholder={`New ${c.headerName} value, e.g. Bearer …`} autoFocus />
          <button className="primary small" disabled={!header.trim()}>Save</button>
        </form>
      )}
      <ErrorNote error={error} />
      {tools && (
        <div className="stack connector-tools">
          <div className="row-gap" style={{ alignItems: 'center' }}>
            <span className="small">
              Connected. {tools.length} tools; agents may use {picked.size}.
            </span>
            <button className="link small" onClick={() => setPicked(new Set(tools.map((t) => t.name)))}>All</button>
            <button className="link small" onClick={() => setPicked(new Set())}>None</button>
          </div>
          <div className="tool-list">
            {tools.map((t) => (
              <label key={t.name} className="tool-option">
                <input
                  type="checkbox"
                  checked={picked.has(t.name)}
                  onChange={(e) => {
                    const next = new Set(picked);
                    if (e.target.checked) next.add(t.name);
                    else next.delete(t.name);
                    setPicked(next);
                  }}
                />
                <span>
                  <code>{t.name}</code> <span className="muted small">{t.description}</span>
                </span>
              </label>
            ))}
          </div>
          <div>
            <button
              className="primary small"
              onClick={async () => {
                const all = picked.size === tools.length;
                await api('PATCH', `/api/connectors/${c.id}`, { allowedTools: all ? null : [...picked] });
                onChange();
              }}
            >
              Save allowed tools
            </button>
            <span className="muted small"> All selected means new tools the server adds later are allowed too.</span>
          </div>
        </div>
      )}
    </li>
  );
}

function AddConnector({ base, onDone, onCancel }: { base: string; onDone: () => void; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [auth, setAuth] = useState<'none' | 'header' | 'oauth'>('header');
  const [headerName, setHeaderName] = useState('Authorization');
  const [headerValue, setHeaderValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="stack add-connector"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        try {
          await api('POST', `${base}/connectors`, { name, url, auth, headerName, headerValue: auth === 'header' ? headerValue : undefined });
          onDone();
        } catch (err) {
          setError((err as Error).message);
        }
      }}
    >
      <div className="branch-fields">
        <label>
          Name <span className="muted small">(prefixes its tools)</span>
          <input value={name} onChange={(e) => setName(e.target.value.toLowerCase())} placeholder="pironman" required />
        </label>
        <label>
          MCP server URL <span className="muted small">(Streamable HTTP or SSE)</span>
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…/mcp" required />
        </label>
      </div>
      <label>
        Authentication
        <select value={auth} onChange={(e) => setAuth(e.target.value as any)}>
          <option value="header">API key in a header</option>
          <option value="oauth">OAuth (sign in after adding)</option>
          <option value="none">None</option>
        </select>
      </label>
      {auth === 'header' && (
        <div className="branch-fields">
          <label>
            Header
            <input value={headerName} onChange={(e) => setHeaderName(e.target.value)} />
          </label>
          <label>
            Value <span className="muted small">(stored encrypted, never shown again)</span>
            <input type="password" value={headerValue} onChange={(e) => setHeaderValue(e.target.value)} placeholder="Bearer …" required />
          </label>
        </div>
      )}
      {auth === 'oauth' && <p className="muted small">After adding it, click Connect to sign in with the server.</p>}
      <ErrorNote error={error} />
      <div className="row-gap">
        <button className="primary">Add connector</button>
        <button type="button" className="ghost" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

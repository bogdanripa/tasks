import { useState } from 'react';
import { api } from '../api';
import { ErrorNote, Time, useFetch } from '../ui';

const KINDS: [string, string][] = [
  ['anthropic', 'Anthropic'],
  ['openai', 'OpenAI'],
  ['google', 'Google Gemini'],
  ['xai', 'xAI Grok'],
  ['openai-compatible', 'OpenAI-compatible (OpenRouter, local…)'],
];

/** Org settings tab: LLM provider keys for agents that Tasks runs itself. */
export function ProvidersSection({ org }: { org: string }) {
  const { data, reload } = useFetch<any[]>(`/api/orgs/${org}/ai-providers`);
  const [provider, setProvider] = useState('anthropic');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [models, setModels] = useState<Record<string, string[] | string>>({});

  return (
    <div className="stack">
      <p className="muted small">
        API keys for the models your agents can run on when <b>Tasks runs them</b> (an agent’s Connection tab → Run in Tasks). Keys are checked
        with the provider, stored encrypted, and never shown again.
      </p>
      {data?.length === 0 && <p className="muted">No providers yet.</p>}
      <ul className="rows">
        {data?.map((p) => (
          <li key={p.id} style={{ flexWrap: 'wrap' }}>
            <b>{p.label}</b>
            <span className="muted small">{KINDS.find(([k]) => k === p.provider)?.[1] ?? p.provider}{p.baseUrl && ` · ${p.baseUrl}`}</span>
            <span className="muted small grow">
              {p.agents ? `${p.agents} agent${p.agents > 1 ? 's' : ''}` : 'unused'} · added <Time iso={p.createdAt} />
            </span>
            <button
              className="ghost small"
              onClick={async () => {
                try {
                  setModels({ ...models, [p.id]: await api('GET', `/api/orgs/${org}/ai-providers/${p.id}/models`) });
                } catch (e) {
                  setModels({ ...models, [p.id]: (e as Error).message });
                }
              }}
            >
              Test
            </button>
            <button
              className="ghost small danger"
              onClick={async () => {
                if (!confirm(`Remove ${p.label}? Agents using it stop until you choose another provider.`)) return;
                await api('DELETE', `/api/orgs/${org}/ai-providers/${p.id}`);
                reload();
              }}
            >
              Remove
            </button>
            {models[p.id] && (
              <div className="small" style={{ flexBasis: '100%' }}>
                {typeof models[p.id] === 'string' ? (
                  <span className="error">{models[p.id] as string}</span>
                ) : (
                  <span className="muted">Works. {(models[p.id] as string[]).length} models, e.g. {(models[p.id] as string[]).slice(0, 6).join(', ')}</span>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>

      <form
        className="stack provider-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await api('POST', `/api/orgs/${org}/ai-providers`, {
              provider, apiKey, label: label || undefined, baseUrl: provider === 'openai-compatible' ? baseUrl : undefined,
            });
            setApiKey('');
            setLabel('');
            setBaseUrl('');
            setError(null);
            reload();
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <h3>Add a provider</h3>
        <div className="two-col" style={{ gap: 12 }}>
          <label>
            Provider
            <select value={provider} onChange={(e) => setProvider(e.target.value)}>
              {KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </label>
          <label>
            <span>Name<span className="muted"> (optional)</span></span>
            <input value={label} placeholder={KINDS.find(([k]) => k === provider)?.[1]} onChange={(e) => setLabel(e.target.value)} />
          </label>
        </div>
        {provider === 'openai-compatible' && (
          <label>
            Base URL
            <input required value={baseUrl} placeholder="https://openrouter.ai/api/v1" onChange={(e) => setBaseUrl(e.target.value)} />
          </label>
        )}
        <label>
          API key
          <input required type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
        </label>
        <ErrorNote error={error} />
        <div className="actions">
          <button className="primary" disabled={busy}>{busy ? 'Checking…' : 'Add provider'}</button>
        </div>
      </form>
    </div>
  );
}

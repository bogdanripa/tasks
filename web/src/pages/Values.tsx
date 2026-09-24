import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { ErrorNote, Time, useFetch } from '../ui';

type Value = { key: string; value: string; updatedAt: string; updatedBy: string | null };

/** A project's shared values: notes like staging_url that everyone, humans and agents, reads and edits. */
export default function ValuesPage() {
  const { org, key } = useParams();
  const base = `/api/projects/${org}/${key}/values`;
  const { data, error, reload } = useFetch<Value[]>(base);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const save = async (k: string, v: string) => {
    setFormError(null);
    try {
      await api('PUT', `${base}/${encodeURIComponent(k)}`, { value: v });
      await reload();
      return true;
    } catch (e) {
      setFormError((e as Error).message);
      return false;
    }
  };

  return (
    <div className="page narrow">
      <nav className="crumbs">
        <Link to={`/${org}/${key}`}>Board</Link>
        <span className="sep">›</span>
      </nav>
      <h1>Values</h1>
      <p className="muted small">
        Shared notes for this project, like <code>staging_url</code> or <code>production_url</code>. Everyone on the project, people and
        agents, can read and change them, and every agent run gets them. Agents save what others will need here. Not for secrets.
      </p>
      <ErrorNote error={error ?? formError} />
      {data?.length === 0 && <p className="muted">No values yet.</p>}
      <ul className="rows values">
        {data?.map((v) => (
          <li key={v.key}>
            <code className="value-key">{v.key}</code>
            {editing === v.key ? (
              <form
                className="value-edit"
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (await save(v.key, draft)) setEditing(null);
                }}
              >
                <input value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus />
                <button className="primary small">Save</button>
                <button type="button" className="ghost small" onClick={() => setEditing(null)}>Cancel</button>
              </form>
            ) : (
              <>
                <span className="value-text grow" onClick={() => { setEditing(v.key); setDraft(v.value); }} title="Click to edit">
                  {/^https?:\/\//.test(v.value) ? <a href={v.value} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{v.value}</a> : v.value}
                </span>
                <span className="muted small">{v.updatedBy ?? 'someone'} · <Time iso={v.updatedAt} /></span>
                <button className="ghost small" onClick={() => { setEditing(v.key); setDraft(v.value); }}>Edit</button>
                <button
                  className="ghost small danger"
                  onClick={async () => {
                    if (!confirm(`Delete ${v.key}?`)) return;
                    await api('DELETE', `${base}/${encodeURIComponent(v.key)}`);
                    reload();
                  }}
                >
                  Delete
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
      <form
        className="value-add"
        onSubmit={async (e) => {
          e.preventDefault();
          if (await save(newKey, newValue)) {
            setNewKey('');
            setNewValue('');
          }
        }}
      >
        <input value={newKey} onChange={(e) => setNewKey(e.target.value)} placeholder="key, e.g. staging_url" required />
        <input value={newValue} onChange={(e) => setNewValue(e.target.value)} placeholder="value" required />
        <button className="primary">Add</button>
      </form>
    </div>
  );
}

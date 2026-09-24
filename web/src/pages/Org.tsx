import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useSession } from '../App';
import { Avatar, ErrorNote, KindBadge, Modal, SkillChip, useFetch } from '../ui';

export default function OrgPage() {
  const { org } = useParams();
  const { me, refreshMe } = useSession();
  const { data, error, reload } = useFetch<any>(`/api/orgs/${org}`);
  const navigate = useNavigate();
  const [newProject, setNewProject] = useState(false);

  if (error) return <div className="page"><ErrorNote error={error} /></div>;
  if (!data) return <div className="page muted">Loading…</div>;
  const admin = data.org.role !== 'member';
  const humans = data.members.filter((m: any) => m.kind === 'human');
  const agents = data.members.filter((m: any) => m.kind === 'agent');
  const leave = async () => {
    if (!confirm(`Leave ${data.org.name}? Your open items here will be unassigned.`)) return;
    try {
      await api('DELETE', `/api/orgs/${org}/members/${me.id}`);
      await refreshMe();
      navigate('/');
    } catch (e) {
      alert((e as Error).message);
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <h1>{data.org.name}</h1>
        <div className="row-gap">
          {admin && <Link to={`/${org}/settings`} className="button">Settings</Link>}
          {admin && <button className="primary" onClick={() => setNewProject(true)}>New project</button>}
        </div>
      </div>

      <section>
        <h2>Projects</h2>
        {data.projects.length === 0 && <p className="muted">No projects yet.</p>}
        <div className="cards">
          {data.projects.map((p: any) => (
            <Link key={p.id} to={`/${org}/${p.key}`} className="card project-card">
              <b>{p.name}</b>
              {p.description && <span className="muted clamp">{p.description}</span>}
              <span className="muted small">{p.openItems} open</span>
            </Link>
          ))}
        </div>
      </section>

      <div className="two-col">
        <section>
          <h2>People</h2>
          <ul className="people">
            {humans.map((m: any) => (
              <li key={m.id}>
                <Avatar name={m.name} url={m.avatarUrl} />
                <span>{m.name}</span>
                <span className="role">{m.role}</span>
                {m.id === me.id && <button className="ghost small" onClick={leave}>Leave</button>}
              </li>
            ))}
          </ul>
        </section>
        <section>
          <h2>Agents</h2>
          {agents.length === 0 && <p className="muted">No agents yet.{admin && <> Add one in <Link to={`/${org}/settings`}>settings</Link>.</>}</p>}
          <ul className="people">
            {agents.map((m: any) => (
              <li key={m.id}>
                <Avatar name={m.name} kind="agent" />
                {admin ? <Link to={`/agents/${m.id}`}>{m.name}</Link> : <span>{m.name}</span>}
                <KindBadge kind="agent" />
                {m.skills?.map((sk: string) => <SkillChip key={sk} skill={sk} />)}
                {!m.connected && <NotConnected agent={m} admin={admin} />}
              </li>
            ))}
          </ul>
        </section>
      </div>

      {newProject && (
        <FormModal
          title="New project"
          fields={[
            { name: 'name', label: 'Name', placeholder: 'Website' },
            { name: 'key', label: 'Key', placeholder: 'WEB', hint: 'Prefix for item refs, e.g. WEB-12', optional: true, derive: { from: 'name', fn: defaultProjectKey } },
            { name: 'description', label: 'Description', optional: true },
            ...(data.agentReady
              ? [{ name: 'forAgents', label: 'Set up for your agent team', type: 'checkbox', checked: true, hint: 'New issues in Todo go to your product agent, and the guidelines start from the agent pipeline template.' }]
              : []),
          ]}
          note="You can change its columns and guidelines in the project’s settings."
          onClose={() => setNewProject(false)}
          onSubmit={async (v) => {
            await api('POST', `/api/orgs/${org}/projects`, {
              name: v.name,
              // Only send a key the user typed; otherwise the server derives it and avoids collisions.
              key: v.key && v.key.toUpperCase() !== defaultProjectKey(v.name) ? v.key.toUpperCase() : undefined,
              description: v.description || undefined,
              setup: data.agentReady ? (v.forAgents === 'true' ? 'agents' : 'blank') : undefined,
            });
            reload();
          }}
        />
      )}
    </div>
  );
}

/** Shown next to an agent that has no routine, webhook or used API key, so it can't receive work. */
export function NotConnected({ agent, admin }: { agent: any; admin: boolean }) {
  return (
    <span className="not-connected">
      <span className="warn-icon" tabIndex={0} aria-label="Not connected: can’t receive work yet">!</span>
      <span className="tip" role="tooltip">
        <b>Not connected:</b> can’t receive work yet. Run it in Tasks, or give it a Claude Code routine, a webhook or an API key for the MCP.
      </span>
      {admin && <Link to={`/agents/${agent.id}`} className="button small">Connect</Link>}
    </span>
  );
}

type Field = {
  name: string;
  label: string;
  placeholder?: string;
  hint?: string;
  optional?: boolean;
  type?: string;
  /** For type "checkbox": whether it starts checked. Its value is "true" or "false". */
  checked?: boolean;
  /** Prefill from another field until the user edits this one. */
  derive?: { from: string; fn: (value: string) => string };
};

/** Mirrors the server's default: first three letters/digits of the name, uppercased. */
export function defaultProjectKey(name: string) {
  const clean = name.normalize('NFD').replace(/[^A-Za-z0-9]/g, '').replace(/^[0-9]+/, '').toUpperCase();
  return clean.length >= 2 ? clean.slice(0, 3) : '';
}

export function FormModal(props: {
  title: string;
  fields: Field[];
  submitLabel?: string;
  note?: string;
  danger?: boolean;
  onClose: () => void;
  onSubmit: (values: Record<string, string>) => Promise<void>;
}) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(props.fields.filter((f) => f.type === 'checkbox').map((f) => [f.name, String(!!f.checked)])),
  );
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const change = (name: string, value: string) => {
    const next = { ...values, [name]: value };
    for (const f of props.fields) if (f.derive?.from === name && !touched.has(f.name)) next[f.name] = f.derive.fn(value);
    setValues(next);
  };
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={props.title} onClose={props.onClose}>
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await props.onSubmit(values);
            props.onClose();
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {props.fields.map((f, i) => f.type === 'checkbox' ? (
          <label key={f.name} className="check-row">
            <input type="checkbox" checked={values[f.name] === 'true'} onChange={(e) => setValues({ ...values, [f.name]: String(e.target.checked) })} />
            <span>{f.label}{f.hint && <span className="hint"> {f.hint}</span>}</span>
          </label>
        ) : (
          <label key={f.name}>
            <span>
              {f.label}
              {f.optional && !f.derive && <span className="muted"> (optional)</span>}
            </span>
            <input
              autoFocus={i === 0}
              type={f.type ?? 'text'}
              required={!f.optional}
              placeholder={f.placeholder}
              value={values[f.name] ?? ''}
              onChange={(e) => {
                if (f.derive) setTouched(new Set(touched).add(f.name));
                change(f.name, e.target.value);
              }}
            />
            {f.hint && <span className="hint">{f.hint}</span>}
          </label>
        ))}
        {props.note && <p className="muted small">{props.note}</p>}
        <ErrorNote error={error} />
        <div className="actions">
          <button type="button" className="ghost" onClick={props.onClose}>Cancel</button>
          <button className={props.danger ? 'danger-solid' : 'primary'} disabled={busy}>{props.submitLabel ?? 'Create'}</button>
        </div>
      </form>
    </Modal>
  );
}

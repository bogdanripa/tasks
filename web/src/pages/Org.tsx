import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useSession } from '../App';
import { Avatar, ErrorNote, KindBadge, Modal, useFetch } from '../ui';
import { AgentKeyReveal } from './Agent';

export default function OrgPage() {
  const { org } = useParams();
  const { refreshMe } = useSession();
  const { data, error, reload } = useFetch<any>(`/api/orgs/${org}`);
  const navigate = useNavigate();
  const [modal, setModal] = useState<'project' | 'invite' | 'agent' | 'delete' | null>(null);
  const [newAgent, setNewAgent] = useState<any>(null);

  if (error) return <div className="page"><ErrorNote error={error} /></div>;
  if (!data) return <div className="page muted">Loading…</div>;
  const admin = data.org.role !== 'member';
  const humans = data.members.filter((m: any) => m.kind === 'human');
  const agents = data.members.filter((m: any) => m.kind === 'agent');

  return (
    <div className="page">
      <div className="page-head">
        <h1>{data.org.name}</h1>
        {admin && <button className="primary" onClick={() => setModal('project')}>New project</button>}
      </div>

      <section>
        <h2>Projects</h2>
        {data.projects.length === 0 && <p className="muted">No projects yet.</p>}
        <div className="cards">
          {data.projects.map((p: any) => (
            <Link key={p.id} to={`/${org}/${p.key}`} className="card project-card">
              <span className="project-key">{p.key}</span>
              <b>{p.name}</b>
              {p.description && <span className="muted clamp">{p.description}</span>}
              <span className="muted small">{p.openItems} open</span>
            </Link>
          ))}
        </div>
      </section>

      <div className="two-col">
        <section>
          <div className="section-head">
            <h2>People</h2>
            {admin && <button className="small" onClick={() => setModal('invite')}>Invite</button>}
          </div>
          <ul className="people">
            {humans.map((m: any) => (
              <li key={m.id}>
                <Avatar name={m.name} url={m.avatarUrl} />
                <span>{m.name}</span>
                <span className="muted small">{m.email}</span>
                <span className="role">{m.role}</span>
              </li>
            ))}
            {data.invites.map((i: any) => (
              <li key={i.email} className="pending">
                <Avatar />
                <span>{i.email}</span>
                <span className="muted small">invited</span>
                <span className="role">{i.role}</span>
              </li>
            ))}
          </ul>
        </section>

        <section>
          <div className="section-head">
            <h2>Agents</h2>
            {admin && <button className="small" onClick={() => setModal('agent')}>New agent</button>}
          </div>
          {agents.length === 0 && <p className="muted">No agents yet. Agents sign in with an API key and work through MCP.</p>}
          <ul className="people">
            {agents.map((m: any) => (
              <li key={m.id}>
                <Avatar name={m.name} kind="agent" />
                {admin ? <Link to={`/agents/${m.id}`}>{m.name}</Link> : <span>{m.name}</span>}
                <span className="muted small">{m.hasWebhook ? 'webhook' : 'polls via MCP'}</span>
                <KindBadge kind="agent" />
              </li>
            ))}
          </ul>
        </section>
      </div>

      {data.org.role === 'owner' && (
        <section className="danger-zone">
          <div>
            <h2>Delete organization</h2>
            <p className="muted small">Permanently removes every project, item, comment, history entry and agent in {data.org.name}. Links from other organizations’ items to these items are removed too.</p>
          </div>
          <button className="danger" onClick={() => setModal('delete')}>Delete…</button>
        </section>
      )}

      {modal === 'delete' && (
        <FormModal
          title={`Delete ${data.org.name}?`}
          fields={[{ name: 'confirm', label: `Type "${data.org.slug}" to confirm`, placeholder: data.org.slug }]}
          submitLabel="Delete permanently"
          danger
          note="This cannot be undone. The organization's agents stop working immediately."
          onClose={() => setModal(null)}
          onSubmit={async (v) => {
            await api('DELETE', `/api/orgs/${org}`, { confirm: v.confirm });
            await refreshMe();
            navigate('/');
          }}
        />
      )}
      {modal === 'project' && (
        <FormModal
          title="New project"
          fields={[
            { name: 'name', label: 'Name', placeholder: 'Website' },
            { name: 'key', label: 'Key', placeholder: 'WEB', hint: 'Prefix for item refs, e.g. WEB-12' },
            { name: 'description', label: 'Description', optional: true },
            { name: 'columns', label: 'Columns', optional: true, placeholder: 'Backlog, Todo, In progress, Review, Done', hint: 'Comma-separated. The last column means done.' },
          ]}
          onClose={() => setModal(null)}
          onSubmit={async (v) => {
            await api('POST', `/api/orgs/${org}/projects`, {
              name: v.name,
              key: v.key.toUpperCase(),
              description: v.description || undefined,
              columns: v.columns ? v.columns.split(',').map((c) => c.trim()).filter(Boolean) : undefined,
            });
            reload();
          }}
        />
      )}
      {modal === 'invite' && (
        <FormModal
          title="Invite someone"
          fields={[{ name: 'email', label: 'Google account email', type: 'email' }]}
          submitLabel="Invite"
          note="They join this organization the next time they sign in with Google."
          onClose={() => setModal(null)}
          onSubmit={async (v) => {
            await api('POST', `/api/orgs/${org}/invites`, { email: v.email });
            reload();
          }}
        />
      )}
      {modal === 'agent' && (
        <FormModal
          title="New agent"
          fields={[
            { name: 'name', label: 'Name', placeholder: 'backend-builder' },
            { name: 'webhookUrl', label: 'Webhook URL', optional: true, placeholder: 'https://…', hint: 'Called when the agent is assigned work. Leave empty if it polls via MCP.' },
          ]}
          onClose={() => setModal(null)}
          onSubmit={async (v) => {
            setNewAgent(await api('POST', `/api/orgs/${org}/agents`, { name: v.name, webhookUrl: v.webhookUrl || null }));
            reload();
            refreshMe();
          }}
        />
      )}
      {newAgent && (
        <Modal title={`${newAgent.agent.name} is ready`} onClose={() => setNewAgent(null)}>
          <AgentKeyReveal apiKey={newAgent.key.key} webhookSecret={newAgent.agent.webhookUrl ? newAgent.agent.webhookSecret : null} />
        </Modal>
      )}
    </div>
  );
}

type Field = { name: string; label: string; placeholder?: string; hint?: string; optional?: boolean; type?: string };

export function FormModal(props: {
  title: string;
  fields: Field[];
  submitLabel?: string;
  note?: string;
  danger?: boolean;
  onClose: () => void;
  onSubmit: (values: Record<string, string>) => Promise<void>;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
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
        {props.fields.map((f, i) => (
          <label key={f.name}>
            {f.label}
            {f.optional && <span className="muted"> (optional)</span>}
            <input
              autoFocus={i === 0}
              type={f.type ?? 'text'}
              required={!f.optional}
              placeholder={f.placeholder}
              value={values[f.name] ?? ''}
              onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
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

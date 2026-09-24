import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useSession } from '../App';
import { Avatar, EditableMarkdown, ErrorNote, KindBadge, Modal, SkillsEditor, Tabs, useFetch, useTab } from '../ui';
import { AgentKeyReveal } from './Agent';
import { FormModal } from './Org';

const ORG_TABS = ['general', 'guidelines', 'people', 'agents'] as const;

export default function OrgSettings() {
  const { org } = useParams();
  const { me, refreshMe } = useSession();
  const { data, error, reload } = useFetch<any>(`/api/orgs/${org}`);
  const navigate = useNavigate();
  const [modal, setModal] = useState<'invite' | 'agent' | 'delete' | null>(null);
  const [newAgent, setNewAgent] = useState<any>(null);
  const [tab, setTab] = useTab(ORG_TABS);

  if (error) return <div className="page"><ErrorNote error={error} /></div>;
  if (!data) return <div className="page muted">Loading…</div>;
  const { org: o } = data;
  if (o.role === 'member') return <div className="page"><ErrorNote error="Only admins can change organization settings." /></div>;
  const humans = data.members.filter((m: any) => m.kind === 'human');
  const agents = data.members.filter((m: any) => m.kind === 'agent');
  const canRemove = (m: any) => m.id !== me.id && (m.role === 'member' || o.role === 'owner');
  const remove = async (m: any) => {
    if (!confirm(`Remove ${m.name} from ${o.name}? Their open items here will be unassigned.`)) return;
    try {
      await api('DELETE', `/api/orgs/${org}/members/${m.id}`);
      reload();
    } catch (e) {
      alert((e as Error).message);
    }
  };
  const setMember = async (m: any, patch: Record<string, unknown>) => {
    await api('PATCH', `/api/orgs/${org}/members/${m.id}`, patch);
    reload();
  };
  const skillsFor = (m: any) => <SkillsEditor value={m.skills} suggestions={data.skills} onSave={(skills) => setMember(m, { skills })} />;
  const update = async (patch: Record<string, string>) => {
    await api('PATCH', `/api/orgs/${org}`, patch);
    await Promise.all([reload(), refreshMe()]);
  };

  return (
    <div className="page narrow settings">
      <h1>Settings</h1>
      <Tabs tabs={ORG_TABS} labels={{ general: 'General', guidelines: 'Guidelines', people: 'People', agents: 'Agents' }} current={tab} onSelect={setTab} />

      {tab === 'general' && (
      <section>
        <h2>General</h2>
        <NameField label="Organization name" value={o.name} onSave={(name) => update({ name })} />
        <p className="muted small">Slug: <code>{o.slug}</code> (used in links and item references; can’t be changed)</p>
      </section>
      )}

      {tab === 'guidelines' && (
      <section>
        <p className="muted small">
          How to work in this organization, for people and agents. Sent to agents with every run in any project here; project guidelines
          take precedence.
        </p>
        <EditableMarkdown
          value={o.guidelines}
          placeholder="Add organization-wide guidelines…"
          editPlaceholder="e.g. Never touch production data on Fridays. Ask in a comment before spending money."
          onSave={(guidelines) => update({ guidelines })}
        />
      </section>
      )}

      {tab === 'people' && (
      <section>
        <div className="section-head">
          <h2>People</h2>
          <button className="small" onClick={() => setModal('invite')}>Invite</button>
        </div>
        <ul className="people">
          {humans.map((m: any) => (
            <li key={m.id}>
              <Avatar name={m.name} url={m.avatarUrl} />
              <span>{m.name}</span>
              <span className="muted small">{m.email}</span>
              {skillsFor(m)}
              {o.role === 'owner' && m.id !== me.id ? (
                <select className="role-select" value={m.role} onChange={(e) => setMember(m, { role: e.target.value }).catch((err) => alert(err.message))}>
                  <option value="member">member</option>
                  <option value="admin">admin</option>
                  <option value="owner">owner</option>
                </select>
              ) : (
                <span className="role">{m.role}</span>
              )}
              {canRemove(m) && <button className="ghost small danger" onClick={() => remove(m)}>Remove</button>}
            </li>
          ))}
          {data.invites.map((i: any) => (
            <li key={i.email} className="pending">
              <Avatar />
              <span>{i.email}</span>
              <span className="muted small">invited</span>
              <span className="role">{i.role}</span>
              <button
                className="ghost small danger"
                onClick={async () => {
                  await api('DELETE', `/api/orgs/${org}/invites/${encodeURIComponent(i.email)}`);
                  reload();
                }}
              >
                Cancel
              </button>
            </li>
          ))}
        </ul>
      </section>
      )}

      {tab === 'agents' && (
      <section>
        <p className="muted small">
          Skills route work: an unassigned item that needs a skill (or sits in a column with a default skill) goes to the least busy member
          who has it.
        </p>
        <div className="section-head">
          <h2>Agents</h2>
          <button className="small" onClick={() => setModal('agent')}>New agent</button>
        </div>
        {agents.length === 0 && <p className="muted">No agents yet. Each agent gets its own identity and works through a Claude routine, a webhook or the MCP.</p>}
        <ul className="people">
          {agents.map((m: any) => (
            <li key={m.id}>
              <Avatar name={m.name} kind="agent" />
              <Link to={`/agents/${m.id}`}>{m.name}</Link>
              <span className="muted small">{m.delivery === 'routine' ? 'Claude routine' : m.delivery === 'webhook' ? 'webhook' : 'polls via MCP'}</span>
              {skillsFor(m)}
            </li>
          ))}
        </ul>
      </section>
      )}

      {tab === 'general' && o.role === 'owner' && (
        <section className="danger-zone">
          <div>
            <h2>Delete organization</h2>
            <p className="muted small">Permanently removes every project, item, comment, history entry and agent in {o.name}. Links from other organizations’ items to these items are removed too.</p>
          </div>
          <button className="danger" onClick={() => setModal('delete')}>Delete…</button>
        </section>
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
          fields={[{ name: 'name', label: 'Name', placeholder: 'Pironman' }]}
          note="Next, open the agent to choose how it gets work: a Claude routine, a webhook or the MCP."
          onClose={() => setModal(null)}
          onSubmit={async (v) => {
            setNewAgent(await api('POST', `/api/orgs/${org}/agents`, { name: v.name }));
            reload();
          }}
        />
      )}
      {newAgent && (
        <Modal title={`${newAgent.agent.name} is ready`} onClose={() => setNewAgent(null)}>
          <AgentKeyReveal apiKey={newAgent.key.key} />
          <div className="actions" style={{ marginTop: 12 }}>
            <button className="primary" onClick={() => navigate(`/agents/${newAgent.agent.id}`)}>Set up {newAgent.agent.name}</button>
          </div>
        </Modal>
      )}
      {modal === 'delete' && (
        <FormModal
          title={`Delete ${o.name}?`}
          fields={[{ name: 'confirm', label: `Type "${o.slug}" to confirm`, placeholder: o.slug }]}
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
    </div>
  );
}

/** A labelled text input that saves on Enter or the Save button, only when changed. */
export function NameField({ label, value, onSave, allowEmpty }: { label: string; value: string; onSave: (v: string) => Promise<unknown>; allowEmpty?: boolean }) {
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const dirty = draft.trim() !== value && (allowEmpty || draft.trim() !== '');
  return (
    <form
      className="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!dirty) return;
        try {
          await onSave(draft.trim());
          setError(null);
          setSaved(true);
          setTimeout(() => setSaved(false), 1500);
        } catch (err) {
          setError((err as Error).message);
        }
      }}
    >
      <label>
        {label}
        <div className="inline-form" style={{ marginTop: 0 }}>
          <input value={draft} onChange={(e) => setDraft(e.target.value)} />
          <button className="primary" disabled={!dirty}>{saved ? 'Saved' : 'Save'}</button>
        </div>
      </label>
      <ErrorNote error={error} />
    </form>
  );
}

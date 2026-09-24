import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, itemPath } from '../api';
import { useSession } from '../App';
import { ErrorNote, TypeBadge, useFetch } from '../ui';
import { AssigneePicker, useParamState, type Assignee, type Member } from '../filters';

export default function Home() {
  const { me, refreshMe } = useSession();
  const [params] = useSearchParams();
  const q = params.get('q');
  const [assignee, setAssignee] = useParamState<Assignee>('assignee', 'home:assignee', 'me');
  const work = useFetch<{ items: any[]; members: Member[] }>(`/api/work?assignee=${encodeURIComponent(assignee)}`);
  const results = useFetch<any[]>(q ? `/api/search?q=${encodeURIComponent(q)}` : null);
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [starterAgents, setStarterAgents] = useState(true);

  return (
    <div className="page narrow">
      {params.get('github_error') && <ErrorNote error={`GitHub wasn’t connected: ${params.get('github_error')}`} />}
      {params.get('connector_error') && <ErrorNote error={`The connector wasn’t signed in: ${params.get('connector_error')}`} />}
      {q && (
        <section>
          <h2>Results for “{q}”</h2>
          <ErrorNote error={results.error} />
          {results.data?.length === 0 && <p className="muted">Nothing matches.</p>}
          <ItemList items={results.data ?? []} />
        </section>
      )}

      <section>
        <h2>Your organizations</h2>
        {me.orgs.length === 0 && <p className="muted">You’re not in any organization yet. Create one, or ask a teammate to invite your email.</p>}
        <div className="cards">
          {me.orgs.map((o) => (
            <Link key={o.id} to={`/${o.slug}`} className="card org-card">
              <b>{o.name}</b>
              <span className="muted">
                {o.slug} · {o.role}
              </span>
            </Link>
          ))}
        </div>
        <form
          className="inline-form"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await api('POST', '/api/orgs', { name, slug, starterAgents });
              await refreshMe();
              navigate(`/${slug}`);
            } catch (err) {
              setError((err as Error).message);
            }
          }}
        >
          <input
            placeholder="New organization name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 39));
            }}
            required
          />
          <input placeholder="slug" value={slug} onChange={(e) => setSlug(e.target.value)} required className="slug" />
          <button>Create</button>
        </form>
        <label className="check-row small" style={{ marginTop: 8 }}>
          <input type="checkbox" checked={starterAgents} onChange={(e) => setStarterAgents(e.target.checked)} />
          Start with a team of agents: a PM, a Lead (design and code review), a Dev and a QA, ready to connect
        </label>
        <ErrorNote error={error} />
      </section>

      <section>
        <div className="section-head">
          <h2>{assignee === 'me' ? 'Assigned to you' : 'Open work'}</h2>
          <AssigneePicker value={assignee} onChange={setAssignee} members={work.data?.members ?? []} label="Assigned to" />
        </div>
        {work.data?.items.length === 0 && <p className="muted">Nothing open matches.</p>}
        <ItemList items={work.data?.items ?? []} showAssignee={assignee !== 'me'} />
      </section>
    </div>
  );
}

export function ItemList({ items, showAssignee }: { items: any[]; showAssignee?: boolean }) {
  return (
    <ul className="item-list">
      {items.map((i) => (
        <li key={i.ref} className={i.done ? 'done' : ''}>
          <TypeBadge type={i.type} />
          <Link to={itemPath(i.ref)} className="ref">
            {i.ref}
          </Link>
          <span className="title">{i.title}</span>
          {i.working && <span className="working">working</span>}
          {showAssignee && <span className="muted small">{i.assigneeName ?? 'unassigned'}</span>}
          <span className="status">{i.status}</span>
        </li>
      ))}
    </ul>
  );
}

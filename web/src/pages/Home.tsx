import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, itemPath } from '../api';
import { useSession } from '../App';
import { ErrorNote, TypeBadge, useFetch } from '../ui';

export default function Home() {
  const { me, refreshMe } = useSession();
  const [params] = useSearchParams();
  const q = params.get('q');
  const work = useFetch<any[]>('/api/me/work');
  const results = useFetch<any[]>(q ? `/api/search?q=${encodeURIComponent(q)}` : null);
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [starterAgents, setStarterAgents] = useState(true);

  return (
    <div className="page narrow">
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
        <h2>Assigned to you</h2>
        {work.data?.length === 0 && <p className="muted">Nothing open is assigned to you.</p>}
        <ItemList items={work.data ?? []} />
      </section>
    </div>
  );
}

export function ItemList({ items }: { items: any[] }) {
  return (
    <ul className="item-list">
      {items.map((i) => (
        <li key={i.ref} className={i.done ? 'done' : ''}>
          <TypeBadge type={i.type} />
          <Link to={itemPath(i.ref)} className="ref">
            {i.ref}
          </Link>
          <span className="title">{i.title}</span>
          <span className="status">{i.status}</span>
        </li>
      ))}
    </ul>
  );
}

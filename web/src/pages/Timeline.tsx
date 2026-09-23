import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { get, type Event } from '../api';
import { ErrorNote, EventRow } from '../ui';
import { useOrgName } from '../App';

const dayLabel = (iso: string) => {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86400000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
};

export default function Timeline() {
  const { org, key } = useParams();
  const [events, setEvents] = useState<Event[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(true);
  const [who, setWho] = useState<'all' | 'human' | 'agent'>('all');
  const base = `/api/projects/${org}/${key}/timeline`;
  const orgName = useOrgName(org);

  const load = async (before?: string) => {
    try {
      const rows = await get<Event[]>(before ? `${base}?before=${before}` : base);
      setEvents((prev) => (before ? [...prev, ...rows] : rows));
      setMore(rows.length === 50);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    load();
  }, [base]);

  const shown = events.filter((e) => who === 'all' || e.actorKind === who);
  const groups: [string, Event[]][] = [];
  for (const e of shown) {
    const label = dayLabel(e.createdAt);
    if (groups.at(-1)?.[0] === label) groups.at(-1)![1].push(e);
    else groups.push([label, [e]]);
  }

  return (
    <div className="page narrow">
      <nav className="crumbs">
        <Link to={`/${org}`}>{orgName}</Link>
        <span className="sep">›</span>
        <Link to={`/${org}/${key}`}>{key} board</Link>
        <span className="sep">›</span>
      </nav>
      <div className="page-head">
        <h1 className="with-key">
          <span className="project-key">{key}</span>
          Timeline
        </h1>
        <div className="segmented">
          {(['all', 'human', 'agent'] as const).map((w) => (
            <button key={w} className={who === w ? 'on' : ''} onClick={() => setWho(w)}>
              {w === 'all' ? 'Everyone' : w === 'human' ? 'People' : 'Agents'}
            </button>
          ))}
        </div>
      </div>
      <ErrorNote error={error} />
      {groups.map(([label, evs]) => (
        <section key={label} className="day">
          <h3 className="day-label">{label}</h3>
          <ul className="events">
            {evs.map((e) => <EventRow key={e.id} e={e} showItem />)}
          </ul>
        </section>
      ))}
      {events.length === 0 && !error && <p className="muted">Nothing has happened yet.</p>}
      {more && events.length > 0 && <button onClick={() => load(events.at(-1)!.id)}>Load older</button>}
    </div>
  );
}

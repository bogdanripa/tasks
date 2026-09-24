import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, itemPath, type Item } from '../api';
import { useSession } from '../App';
import { Avatar, ErrorNote, SkillChip, useFetch } from '../ui';
import { AssigneePicker, matchAssignee, useParamState, type Assignee, type Member } from '../filters';
import { ItemTable } from './ItemTable';

type Filter = 'all' | 'issue' | 'task';

export default function Board() {
  const { org, key } = useParams();
  const { data, error, reload, setData } = useFetch<{ project: any; items: Item[] }>(`/api/projects/${org}/${key}`);
  const [filter, setFilter] = useState<Filter>(() => (localStorage.getItem('board-filter') as Filter) || 'all');
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<{ status: string; index: number } | null>(null);
  const [opError, setOpError] = useState<string | null>(null);
  const { me } = useSession();
  const admin = me.orgs.find((o) => o.slug === org)?.role !== 'member';
  const [view, setView] = useParamState<'board' | 'list'>('view', `view:${org}/${key}`, 'board');
  const [assignee, setAssignee] = useParamState<Assignee>('assignee', `assignee:${org}/${key}`, 'all');
  const [showDone, setShowDone] = useParamState<'yes' | 'no'>('done', `done:${org}/${key}`, 'no');
  const members: Member[] = useFetch<any>(`/api/orgs/${org}`).data?.members ?? [];
  const shown = (i: Item) => (filter === 'all' || i.type === filter) && matchAssignee(i, assignee, me.id);

  useEffect(() => {
    try {
      localStorage.setItem('board-filter', filter);
    } catch {}
  }, [filter]);

  // Agents move cards too; keep the board fresh without a websocket.
  useEffect(() => {
    const t = setInterval(() => document.visibilityState === 'visible' && !dragging && reload(), 10_000);
    return () => clearInterval(t);
  }, [reload, dragging]);

  const columns = useMemo(() => {
    const by: Record<string, Item[]> = {};
    for (const c of data?.project.columns ?? []) by[c] = [];
    for (const i of data?.items ?? []) if (shown(i)) (by[i.status] ??= []).push(i);
    return by;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, filter, assignee, me.id]);

  if (error) return <div className="page"><ErrorNote error={error} /></div>;
  if (!data) return <div className="page muted">Loading…</div>;
  const { project } = data;

  async function drop(status: string, index: number) {
    const id = dragging;
    setDragging(null);
    setDropAt(null);
    if (!id || !data) return;
    const card = data.items.find((i) => i.id === id)!;
    const col = columns[status].filter((i) => i.id !== id);
    const before = col[index - 1]?.position;
    const after = col[index]?.position;
    const position = before === undefined ? (after === undefined ? 1 : after - 1) : after === undefined ? before + 1 : (before + after) / 2;
    if (card.status === status && card.position === position) return;
    // Optimistic update, then reconcile with the server.
    setData({ ...data, items: data.items.map((i) => (i.id === id ? { ...i, status, position } : i)).sort((a, b) => a.position - b.position) });
    try {
      await api('PATCH', `/api/items/${card.ref}`, { status, position });
      setOpError(null);
    } catch (e) {
      setOpError((e as Error).message);
    }
    reload();
  }

  return (
    <div className="board-page">
      <div className="board-head">
        <div>
          <h1>{project.name}</h1>
        </div>
        <div className="segmented" role="tablist" aria-label="View">
          {(['board', 'list'] as const).map((v) => (
            <button key={v} role="tab" aria-selected={view === v} className={view === v ? 'on' : ''} onClick={() => setView(v)}>
              {v === 'board' ? 'Board' : 'List'}
            </button>
          ))}
        </div>
        <div className="segmented" role="tablist" aria-label="Type">
          {(['all', 'issue', 'task'] as Filter[]).map((f) => (
            <button key={f} role="tab" aria-selected={filter === f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>
              {f === 'all' ? 'All' : f === 'issue' ? 'Issues' : 'Tasks'}
            </button>
          ))}
        </div>
        <AssigneePicker value={assignee} onChange={setAssignee} members={members} />
        {view === 'list' && (
          <label className="picker">
            <input type="checkbox" checked={showDone === 'yes'} onChange={(e) => setShowDone(e.target.checked ? 'yes' : 'no')} />
            <span className="small">Show done</span>
          </label>
        )}
        <Link to={`/${org}/${key}/timeline`} className="button">Timeline</Link>
        <Link to={`/${org}/${key}/values`} className="button">Values</Link>
        {admin && <Link to={`/${org}/${key}/settings`} className="button">Settings</Link>}
      </div>
      <ErrorNote error={opError} />
      {view === 'list' ? (
        <ItemTable
          items={data.items.filter((i) => shown(i) && (showDone === 'yes' || !i.done)) as any}
          columns={project.columns}
          flat={filter === 'task'}
        />
      ) : (
      <div className="board">
        {project.columns.map((status: string, ci: number) => {
          const cards = columns[status] ?? [];
          const last = ci === project.columns.length - 1;
          return (
            <section
              key={status}
              className={`column ${dropAt?.status === status ? 'drop-target' : ''}`}
              onDragOver={(e) => {
                if (!dragging) return;
                e.preventDefault();
                // Find insertion index from the pointer position among this column's cards.
                const els = [...e.currentTarget.querySelectorAll<HTMLElement>('.card-item:not(.dragging)')];
                const index = els.findIndex((el) => e.clientY < el.getBoundingClientRect().top + el.offsetHeight / 2);
                const i = index === -1 ? els.length : index;
                if (dropAt?.status !== status || dropAt.index !== i) setDropAt({ status, index: i });
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropAt(null);
              }}
              onDrop={(e) => {
                e.preventDefault();
                drop(status, dropAt?.index ?? cards.length);
              }}
            >
              <header>
                <h3>{status}</h3>
                <span className="muted">{cards.length}</span>
                {last && <span className="done-mark" title="Items here are done">✓</span>}
              </header>
              <div className="cards-col">
                {(() => {
                  // The dragged card stays mounted (dragend fires on it) but doesn't count for drop indices.
                  let n = 0;
                  const line = (i: number) => dropAt?.status === status && dropAt.index === i && <div className="drop-line" />;
                  return (
                    <>
                      {cards.map((c) => (
                        <div key={c.id}>
                          {c.id !== dragging && line(n++)}
                          <Card
                            item={c}
                            dragging={c.id === dragging}
                            onDragStart={() => setDragging(c.id)}
                            onDragEnd={() => { setDragging(null); setDropAt(null); }}
                          />
                        </div>
                      ))}
                      {line(n)}
                    </>
                  );
                })()}
              </div>
              {!last && <QuickAdd org={org!} projectKey={key!} status={status} onAdded={reload} />}
            </section>
          );
        })}
      </div>
      )}
    </div>
  );
}

function Card({ item, dragging, onDragStart, onDragEnd }: { item: Item; dragging: boolean; onDragStart: () => void; onDragEnd: () => void }) {
  const navigate = useNavigate();
  const frame = useRef(0);
  return (
    <article
      className={`card-item ${item.type} ${item.done ? 'done' : ''} ${dragging ? 'dragging' : ''}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', item.ref);
        // Defer so the browser snapshots the card before we dim it.
        frame.current = window.setTimeout(onDragStart);
      }}
      onDragEnd={() => {
        clearTimeout(frame.current);
        onDragEnd();
      }}
      onClick={() => navigate(itemPath(item.ref))}
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && navigate(itemPath(item.ref))}
    >
      <div className="card-top">
        <span className={`type-dot ${item.type}`} title={item.type} />
        <span className="ref">{item.ref.split('/')[1]}</span>
        {item.parentRef && <span className="parent muted" title="Parent issue">↳ {item.parentRef.split('/')[1]}</span>}
      </div>
      <div className="card-title">{item.title}</div>
      <div className="card-meta">
        {!!item.tasksTotal && (
          <span className={`pill ${item.tasksDone === item.tasksTotal ? 'complete' : ''}`} title="Tasks done">
            ☑ {item.tasksDone}/{item.tasksTotal}
          </span>
        )}
        {!!item.linkCount && <span className="pill" title="Links">⇄ {item.linkCount}</span>}
        {item.working && <span className="working" title="An agent is working on this right now">working</span>}
        {item.skill && !item.assigneeName && !item.done && <SkillChip skill={item.skill} missing />}
        {!item.working && !!item.blockedBy?.length && !item.done && <span className="pill" title={`Waiting on ${item.blockedBy.join(', ')}`}>⏸ blocked</span>}
        <span className="spacer" />
        {item.assigneeName ? (
          <span className={`assignee ${item.assigneeKind ?? ''}`} title={`Assigned to ${item.assigneeName}`}>
            <Avatar name={item.assigneeName} kind={item.assigneeKind} size={20} />
            <span className="assignee-name">{item.assigneeName}</span>
          </span>
        ) : (
          <Avatar size={20} />
        )}
      </div>
    </article>
  );
}

function QuickAdd({ org, projectKey, status, onAdded }: { org: string; projectKey: string; status: string; onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  if (!open) return <button className="add-card" onClick={() => setOpen(true)}>+ Add issue</button>;
  return (
    <form
      className="quick-add"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!title.trim()) return;
        try {
          await api('POST', `/api/projects/${org}/${projectKey}/items`, { type: 'issue', title, status });
          setTitle('');
          setError(null);
          onAdded();
        } catch (err) {
          setError((err as Error).message);
        }
      }}
    >
      <textarea
        autoFocus
        rows={2}
        placeholder="What’s needed?"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            e.currentTarget.form?.requestSubmit();
          }
          if (e.key === 'Escape') setOpen(false);
        }}
      />
      <ErrorNote error={error} />
      <div className="actions">
        <button className="primary small">Add</button>
        <button type="button" className="ghost small" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </form>
  );
}

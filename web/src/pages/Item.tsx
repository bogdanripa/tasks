import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, itemPath, type Event } from '../api';
import { Avatar, ErrorNote, EventRow, KindBadge, Markdown, Modal, RefLink, Time, TypeBadge, linkVerb, useFetch } from '../ui';

export default function ItemPage() {
  const { org, ref } = useParams();
  const fullRef = `${org}/${ref}`;
  const { data, error, reload } = useFetch<any>(`/api/items/${fullRef}`);
  const orgData = useFetch<any>(`/api/orgs/${org}`);
  const [opError, setOpError] = useState<string | null>(null);
  const [editing, setEditing] = useState<'title' | 'body' | null>(null);
  const [draft, setDraft] = useState('');
  const [modal, setModal] = useState<'task' | 'link' | 'trigger' | null>(null);

  useEffect(() => {
    const t = setInterval(() => document.visibilityState === 'visible' && !editing && reload(), 15_000);
    return () => clearInterval(t);
  }, [reload, editing]);

  if (error) return <div className="page"><ErrorNote error={error} /></div>;
  if (!data) return <div className="page muted">Loading…</div>;
  const { item, project, parent, tasks, links, comments, history } = data;
  const members: any[] = orgData.data?.members ?? [];

  const patch = async (body: Record<string, unknown>) => {
    try {
      await api('PATCH', `/api/items/${fullRef}`, body);
      setOpError(null);
      reload();
    } catch (e) {
      setOpError((e as Error).message);
    }
  };

  const outgoing = links.filter((l: any) => l.outgoing);
  const incoming = links.filter((l: any) => !l.outgoing);

  return (
    <div className="page item-page">
      <nav className="crumbs">
        <Link to={`/${org}`}>{org}</Link> / <Link to={`/${org}/${project.key}`}>{project.key} {project.name}</Link>
        {parent && (
          <>
            {' '}/ <RefLink refStr={parent.ref} /> <span className="muted">{parent.title}</span>
          </>
        )}
      </nav>

      <div className="item-grid">
        <div className="item-main">
          <div className="item-title">
            <TypeBadge type={item.type} />
            <span className="ref big">{item.ref.split('/')[1]}</span>
            {editing === 'title' ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  setEditing(null);
                  patch({ title: draft });
                }}
              >
                <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={() => setEditing(null)} className="title-input" />
              </form>
            ) : (
              <h1 onClick={() => { setDraft(item.title); setEditing('title'); }} title="Click to edit">
                {item.title}
              </h1>
            )}
          </div>
          <ErrorNote error={opError} />

          <section>
            <h2>Description</h2>
            {editing === 'body' ? (
              <div className="stack">
                <textarea
                  autoFocus
                  rows={Math.min(Math.max(draft.split('\n').length + 2, 8), 30)}
                  value={draft}
                  placeholder="Describe the need or the work. Markdown is supported."
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') setEditing(null);
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                      setEditing(null);
                      patch({ body: draft });
                    }
                  }}
                />
                <div className="actions">
                  <span className="muted small grow">Markdown supported · ⌘/Ctrl+Enter to save · Esc to cancel</span>
                  <button className="ghost small" onClick={() => setEditing(null)}>Cancel</button>
                  <button className="primary small" onClick={() => { setEditing(null); patch({ body: draft }); }}>Save</button>
                </div>
              </div>
            ) : (
              <div
                className={`body editable ${item.body ? '' : 'empty'}`}
                title="Click to edit"
                onClick={(e) => {
                  // Let links work and text be selected without jumping into the editor.
                  if ((e.target as HTMLElement).closest('a') || window.getSelection()?.toString()) return;
                  setDraft(item.body);
                  setEditing('body');
                }}
              >
                {item.body ? <Markdown>{item.body}</Markdown> : <span className="muted">Add a description…</span>}
              </div>
            )}
          </section>

          {item.type === 'issue' && (
            <section>
              <div className="section-head">
                <h2>
                  Tasks <span className="muted">{tasks.filter((t: any) => t.done).length}/{tasks.length}</span>
                </h2>
                <button className="small" onClick={() => setModal('task')}>Add task</button>
              </div>
              {tasks.length === 0 && <p className="muted">Break this issue into tasks and assign them to people or agents.</p>}
              <ul className="rows">
                {tasks.map((t: any) => (
                  <li key={t.ref} className={t.done ? 'done' : ''}>
                    <span className={`check ${t.done ? 'on' : ''}`}>{t.done ? '✓' : ''}</span>
                    <RefLink refStr={t.ref} />
                    <span className="grow">{t.title}</span>
                    <span className="status">{t.status}</span>
                    <Avatar name={t.assigneeName} kind={t.assigneeKind} size={22} />
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section>
            <div className="section-head">
              <h2>Dependencies</h2>
              <div className="row-gap">
                <button className="small" onClick={() => setModal('trigger')}>Raise triggered issue</button>
                <button className="small ghost" onClick={() => setModal('link')}>Link existing</button>
              </div>
            </div>
            {links.length === 0 && <p className="muted">No links. Issues this one causes, in any project, show up here and stay linked.</p>}
            {[...incoming, ...outgoing].length > 0 && (
              <ul className="rows links">
                {[...incoming, ...outgoing].map((l: any) => (
                  <li key={l.id} className={l.done ? 'done' : ''}>
                    <span className={`link-kind ${l.kind}`}>{linkVerb(l.kind, l.outgoing)}</span>
                    <RefLink refStr={l.ref} />
                    {l.ref.split('/')[0] !== org && <span className="badge">{l.ref.split('/')[0]}</span>}
                    <span className="grow">{l.title}</span>
                    <span className="status">{l.status}</span>
                    {l.kind !== 'triggered' && (
                      <button
                        className="icon"
                        title="Remove link"
                        onClick={async () => {
                          await api('DELETE', `/api/links/${l.id}`);
                          reload();
                        }}
                      >
                        ×
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h2>Comments</h2>
            <ul className="comments">
              {comments.map((c: any) => (
                <li key={c.id}>
                  <Avatar name={c.authorName} kind={c.authorKind} url={c.authorAvatar} />
                  <div>
                    <div>
                      <b>{c.authorName}</b> <KindBadge kind={c.authorKind} /> · <Time iso={c.createdAt} />
                    </div>
                    <div className="body"><Markdown>{c.body}</Markdown></div>
                  </div>
                </li>
              ))}
            </ul>
            <CommentBox fullRef={fullRef} onPosted={reload} />
          </section>
        </div>

        <aside className="item-side">
          <label>
            Status
            <select value={item.status} onChange={(e) => patch({ status: e.target.value })}>
              {project.columns.map((c: string) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
          <label>
            Assignee
            <select value={item.assigneeId ?? ''} onChange={(e) => patch({ assignee: e.target.value || null })}>
              <option value="">Unassigned</option>
              <MemberOptions members={members} />
            </select>
          </label>
          {item.assigneeKind === 'agent' && <p className="muted small">The agent was pinged when it was assigned.</p>}
          <div className="side-meta muted small">
            Created <Time iso={item.createdAt} />
            <br />
            Updated <Time iso={item.updatedAt} />
          </div>

          <h2>History</h2>
          <ul className="events compact">
            {history.map((e: Event) => (
              <EventRow key={e.id} e={e} showItem={e.itemId !== item.id} />
            ))}
          </ul>
        </aside>
      </div>

      {modal === 'task' && <NewTaskModal parentRef={fullRef} org={org!} projectKey={project.key} members={members} onClose={() => setModal(null)} onDone={reload} />}
      {modal === 'trigger' && <TriggerModal fromRef={fullRef} onClose={() => setModal(null)} />}
      {modal === 'link' && <LinkModal fromRef={fullRef} onClose={() => setModal(null)} onDone={reload} />}
    </div>
  );
}

function MemberOptions({ members }: { members: any[] }) {
  const humans = members.filter((m) => m.kind === 'human');
  const agents = members.filter((m) => m.kind === 'agent');
  return (
    <>
      {humans.length > 0 && (
        <optgroup label="People">
          {humans.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </optgroup>
      )}
      {agents.length > 0 && (
        <optgroup label="Agents">
          {agents.map((m) => <option key={m.id} value={m.id}>🤖 {m.name}</option>)}
        </optgroup>
      )}
    </>
  );
}

function CommentBox({ fullRef, onPosted }: { fullRef: string; onPosted: () => void }) {
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="stack comment-box"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!body.trim()) return;
        try {
          await api('POST', `/api/comments/${fullRef}`, { body });
          setBody('');
          setError(null);
          onPosted();
        } catch (err) {
          setError((err as Error).message);
        }
      }}
    >
      <textarea rows={3} placeholder="Write a comment…" value={body} onChange={(e) => setBody(e.target.value)} />
      <ErrorNote error={error} />
      <div className="actions">
        <button className="primary small" disabled={!body.trim()}>Comment</button>
      </div>
    </form>
  );
}

function NewTaskModal(props: { parentRef: string; org: string; projectKey: string; members: any[]; onClose: () => void; onDone: () => void }) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [assignee, setAssignee] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title="New task" onClose={props.onClose}>
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api('POST', `/api/projects/${props.org}/${props.projectKey}/items`, {
              type: 'task', parent: props.parentRef, title, body, assignee: assignee || null,
            });
            props.onDone();
            props.onClose();
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      >
        <label>Title<input autoFocus required value={title} onChange={(e) => setTitle(e.target.value)} /></label>
        <label><span>Details<span className="muted"> (optional)</span></span><textarea rows={4} value={body} onChange={(e) => setBody(e.target.value)} /></label>
        <label>
          Assign to
          <select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
            <option value="">Unassigned</option>
            <MemberOptions members={props.members} />
          </select>
        </label>
        <ErrorNote error={error} />
        <div className="actions">
          <button type="button" className="ghost" onClick={props.onClose}>Cancel</button>
          <button className="primary">Create task</button>
        </div>
      </form>
    </Modal>
  );
}

function TriggerModal({ fromRef, onClose }: { fromRef: string; onClose: () => void }) {
  const projects = useFetch<any[]>('/api/projects');
  const navigate = useNavigate();
  const [project, setProject] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title={`New issue triggered by ${fromRef.split('/')[1]}`} onClose={onClose}>
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          const [org, key] = project.split('/');
          try {
            const created = await api('POST', `/api/projects/${org}/${key}/items`, { type: 'issue', title, body, triggeredBy: fromRef });
            navigate(itemPath(created.ref));
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      >
        <label>
          In project
          <select required value={project} onChange={(e) => setProject(e.target.value)}>
            <option value="" disabled>Choose a project…</option>
            {projects.data?.map((p) => <option key={p.ref} value={p.ref}>{p.ref} — {p.name}</option>)}
          </select>
        </label>
        <label>Title<input required value={title} onChange={(e) => setTitle(e.target.value)} /></label>
        <label><span>Description<span className="muted"> (optional)</span></span><textarea rows={4} value={body} onChange={(e) => setBody(e.target.value)} /></label>
        <p className="muted small">The “triggered” link is permanent, so the chain stays traceable.</p>
        <ErrorNote error={error} />
        <div className="actions">
          <button type="button" className="ghost" onClick={onClose}>Cancel</button>
          <button className="primary">Create issue</button>
        </div>
      </form>
    </Modal>
  );
}

function LinkModal({ fromRef, onClose, onDone }: { fromRef: string; onClose: () => void; onDone: () => void }) {
  const [kind, setKind] = useState('blocks');
  const [to, setTo] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title="Link to another item" onClose={onClose}>
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api('POST', '/api/links', { from: fromRef, to: to.trim(), kind });
            onDone();
            onClose();
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      >
        <label>
          This item…
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="blocks">blocks</option>
            <option value="triggered">triggered (permanent)</option>
            <option value="relates">relates to</option>
          </select>
        </label>
        <label>
          …item
          <input autoFocus required placeholder="org/KEY-12 or KEY-12" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <ErrorNote error={error} />
        <div className="actions">
          <button type="button" className="ghost" onClick={onClose}>Cancel</button>
          <button className="primary">Link</button>
        </div>
      </form>
    </Modal>
  );
}

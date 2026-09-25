import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, itemPath, type Event } from '../api';
import { useSession } from '../App';
import { Avatar, EditableMarkdown, ErrorNote, EventRow, KindBadge, Markdown, Modal, SkillChip, RefLink, Time, TypeBadge, linkVerb, useFetch, Working } from '../ui';

export default function ItemPage() {
  const { org, ref } = useParams();
  const fullRef = `${org}/${ref}`;
  const { data, error, reload } = useFetch<any>(`/api/items/${fullRef}`);
  const orgData = useFetch<any>(`/api/orgs/${org}`);
  const [opError, setOpError] = useState<string | null>(null);
  const [editing, setEditing] = useState<'title' | null>(null);
  const [draft, setDraft] = useState('');
  const [modal, setModal] = useState<'task' | 'link' | 'trigger' | null>(null);
  const { me } = useSession();
  const navigate = useNavigate();

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
  const openBlockers = links.filter((l: any) => !l.outgoing && l.kind === 'blocks' && !l.done);
  const incoming = links.filter((l: any) => !l.outgoing);

  return (
    <div className="page item-page">
      <nav className="crumbs">
        <Link to={`/${org}/${project.key}`}>{project.name}</Link>
        {parent && (
          <>
            <span className="sep">›</span>
            <Link to={itemPath(parent.ref)}>{parent.ref.split('/')[1]}</Link>
          </>
        )}
        <span className="sep">›</span>
        <TypeBadge type={item.type} />
        <span className="ref">{item.ref.split('/')[1]}</span>
      </nav>

      <div className="item-grid">
        <div className="item-main">
          <div className="item-title">
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
            <EditableMarkdown
              value={item.body}
              placeholder="Add a description…"
              editPlaceholder="Describe the need or the work. Markdown is supported."
              onSave={(body) => patch({ body })}
            />
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
                {inWorkOrder(tasks).map((t: any) => (
                  <li key={t.ref} className={t.done ? 'done' : ''}>
                    <span className={`check ${t.done ? 'on' : ''}`}>{t.done ? '✓' : ''}</span>
                    <RefLink refStr={t.ref} />
                    <span className="grow">{t.title}</span>
                    <TaskState t={t} />
                    {t.skill && <SkillChip skill={t.skill} missing={!t.assigneeName && !t.done} />}
                    {t.assigneeName ? (
                      <span className={`assignee ${t.assigneeKind ?? ''}`}>
                        <Avatar name={t.assigneeName} kind={t.assigneeKind} size={20} />
                        <span className="assignee-name">{t.assigneeName}</span>
                      </span>
                    ) : (
                      <Avatar size={20} />
                    )}
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
          {item.workingRun && (
            <p className="small live-run">
              <Working run={item.workingRun} label={`${item.assigneeName ?? 'An agent'} is working on this`} /> · watch live
            </p>
          )}
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
          <SkillField value={item.skill ?? ''} suggestions={orgData.data?.skills ?? []} onSave={(skill) => patch({ skill: skill || null })} />
          {!item.assigneeId && item.skill && !item.done && (
            <p className="warn small">Nobody in this organization has the skill “{item.skill}”, so it’s waiting. Give it to someone in the organization’s settings.</p>
          )}
          {item.assigneeKind === 'agent' && (
            <p className="muted small">
              {item.status.toLowerCase() === 'backlog' ? (
                `In Backlog, so ${item.assigneeName} isn’t pinged. Move it out of Backlog to start the agent.`
              ) : openBlockers.length ? (
                <>
                  Waiting on {openBlockers.map((l: any, n: number) => <span key={l.id}>{n > 0 && ', '}<RefLink refStr={l.ref} /></span>)}, so{' '}
                  {item.assigneeName} isn’t pinged until {openBlockers.length > 1 ? 'they’re' : 'it’s'} done.
                </>
              ) : (
                `${item.assigneeName} is pinged once this item has been left alone for a couple of minutes after a change.`
              )}
            </p>
          )}
          <div className="side-meta muted small">
            Created <Time iso={item.createdAt} />
            <br />
            Updated <Time iso={item.updatedAt} />
          </div>
          {(item.createdBy === me.id || me.orgs.find((o) => o.slug === org)?.role !== 'member') && (
            <button
              className="small ghost danger"
              onClick={async () => {
                const open = tasks.length ? ` and its ${tasks.length} task${tasks.length === 1 ? '' : 's'}` : '';
                if (!confirm(`Delete ${item.ref.split('/')[1]}${open}? Comments, links and history go too. This can't be undone.`)) return;
                try {
                  await api('DELETE', `/api/items/${fullRef}`, undefined, { toast: 'Deleted' });
                  navigate(`/${org}/${project.key}`);
                } catch (e) {
                  setOpError((e as Error).message);
                }
              }}
            >
              Delete {item.type}
            </button>
          )}

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

function SkillField({ value, suggestions, onSave }: { value: string; suggestions: string[]; onSave: (v: string) => Promise<unknown> }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => draft.trim() !== value && onSave(draft.trim());
  return (
    <label>
      Needs skill
      <input
        list="item-skill-suggestions"
        value={draft}
        placeholder="none"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget.blur())}
      />
      <datalist id="item-skill-suggestions">{suggestions.map((s) => <option key={s} value={s} />)}</datalist>
      <span className="hint">When unassigned, it goes to the least busy member with this skill.</span>
    </label>
  );
}

/** Where a task stands in the plan: done, being worked on, waiting on blockers, or ready to start. */
function TaskState({ t }: { t: any }) {
  if (t.done) return <span className="state muted">{t.status}</span>;
  if (t.working) return <Working run={t.workingRun} />;
  if (t.blockedBy?.length) {
    return (
      <span className="state waiting">
        waiting on {t.blockedBy.map((r: string, n: number) => <span key={r}>{n > 0 && ', '}<RefLink refStr={r} /></span>)}
      </span>
    );
  }
  return <span className="state ready">{t.status === 'Backlog' ? 'in Backlog' : 'ready'}</span>;
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
  const [skill, setSkill] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title="New task" onClose={props.onClose}>
      <form
        className="stack"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api('POST', `/api/projects/${props.org}/${props.projectKey}/items`, {
              type: 'task', parent: props.parentRef, title, body, assignee: assignee || null, skill: skill.trim() || null,
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
        <div className="two-col" style={{ gap: 12 }}>
          <label>
            <span>Needs skill<span className="muted"> (optional)</span></span>
            <input list="item-skill-suggestions" value={skill} placeholder="e.g. backend" onChange={(e) => setSkill(e.target.value)} />
          </label>
          <label>
            Assign to
            <select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
              <option value="">{skill.trim() ? 'By skill' : 'Unassigned'}</option>
              <MemberOptions members={props.members} />
            </select>
          </label>
        </div>
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

/**
 * Tasks in the order work happens: finished ones first, then open ones so that a blocker always comes
 * before what it blocks (ties by number).
 */
function inWorkOrder<T extends { ref: string; done: boolean; blockedBy?: string[] | null }>(tasks: T[]): T[] {
  const done = tasks.filter((t) => t.done);
  const open = tasks.filter((t) => !t.done);
  const refs = new Set(open.map((t) => t.ref));
  const waitsOn = new Map(open.map((t) => [t.ref, (t.blockedBy ?? []).filter((b) => refs.has(b))]));
  const out: T[] = [];
  const placed = new Set<string>();
  while (out.length < open.length) {
    const next = open.find((t) => !placed.has(t.ref) && waitsOn.get(t.ref)!.every((b) => placed.has(b)))
      ?? open.find((t) => !placed.has(t.ref))!; // a cycle: keep going in number order
    out.push(next);
    placed.add(next.ref);
  }
  return [...done, ...out];
}

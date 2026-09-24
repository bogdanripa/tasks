import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { get, itemPath, type Event } from './api';

/** Fetch JSON on mount / when `path` changes. `reload` refetches without clearing. */
export function useFetch<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (!path) return;
    try {
      setData(await get<T>(path));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [path]);
  useEffect(() => {
    setData(null);
    load();
  }, [load]);
  return { data, error, reload: load, setData };
}

export function Avatar({ name, kind, url, size = 24 }: { name?: string | null; kind?: string | null; url?: string | null; size?: number }) {
  if (!name) return <span className="avatar empty" style={{ width: size, height: size }} title="Unassigned" />;
  if (url) return <img className="avatar" src={url} alt="" width={size} height={size} title={name} referrerPolicy="no-referrer" />;
  const initials = name.split(/[\s._-]+/).map((p) => p[0]).join('').slice(0, 2).toUpperCase();
  return (
    <span className={`avatar ${kind === 'agent' ? 'agent' : ''}`} style={{ width: size, height: size, fontSize: size * 0.42 }} title={`${name}${kind === 'agent' ? ' (agent)' : ''}`}>
      {kind === 'agent' ? <BotIcon size={size * 0.62} /> : initials}
    </span>
  );
}

export function BotIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="4" y="8" width="16" height="12" rx="3" />
      <path d="M12 4v4M9 13h.01M15 13h.01M9 17h6" />
    </svg>
  );
}

export function KindBadge({ kind }: { kind?: string | null }) {
  return kind === 'agent' ? <span className="badge agent">agent</span> : null;
}

export function TypeBadge({ type }: { type: string }) {
  return <span className={`type-badge ${type}`}>{type}</span>;
}

export function timeAgo(iso: string) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function Time({ iso }: { iso: string }) {
  return (
    <time dateTime={iso} title={new Date(iso).toLocaleString()} className="muted">
      {timeAgo(iso)}
    </time>
  );
}

export const RefLink = ({ refStr }: { refStr: string }) => (
  <Link to={itemPath(refStr)} className="ref">
    {refStr.split('/')[1] ?? refStr}
  </Link>
);

const LINK_VERB: Record<string, [string, string]> = {
  triggered: ['triggered', 'was triggered by'],
  blocks: ['blocks', 'is blocked by'],
  relates: ['relates to', 'relates to'],
};
export const linkVerb = (kind: string, outgoing: boolean) => LINK_VERB[kind]?.[outgoing ? 0 : 1] ?? kind;

/** One-line human description of an event. `showItem` names the item (timeline) or not (item history). */
export function describe(e: Event, showItem: boolean): ReactNode {
  const d = e.data ?? {};
  const item = showItem && e.itemRef ? <RefLink refStr={e.itemRef} /> : null;
  switch (e.type) {
    case 'item.created':
      return (
        <>
          created {d.type} {item} {showItem && <q>{d.title}</q>}
          {d.triggeredBy && <> — triggered by <RefLink refStr={d.triggeredBy} /></>}
          {d.assignee && <> and assigned it to <b>{d.assignee}</b></>}
          {d.schedule && <span className="muted"> (from schedule “{d.schedule}”)</span>}
        </>
      );
    case 'item.updated': {
      const c = d.changes ?? {};
      const parts: ReactNode[] = [];
      if (c.status) parts.push(<>moved {item} from <b>{c.status[0]}</b> to <b>{c.status[1]}</b></>);
      if (c.assignee && d.handoff) parts.push(<>handed {item || 'it'} to <b>{c.assignee[1]}</b> for {d.handoff}</>);
      else if (c.assignee && d.returned) parts.push(<>sent {item || 'it'} back to <b>{c.assignee[1]}</b> with changes requested</>);
      else if (c.assignee && d.byReply) parts.push(<>took {item || 'it'} by replying</>);
      else if (c.assignee) parts.push(c.assignee[1] ? <>assigned {item} to <b>{c.assignee[1]}</b></> : <>unassigned {item}</>);
      if (c.title) parts.push(<>renamed {item} to <q>{c.title[1]}</q></>);
      if (c.body) parts.push(<>edited the description{showItem && <> of {item}</>}</>);
      return parts.map((p, i) => <span key={i}>{i > 0 && ', '}{p}</span>);
    }
    case 'task.added':
      return <>added task <RefLink refStr={d.ref} /> <q>{d.title}</q>{showItem && <> to {item}</>}</>;
    case 'comment.created':
      return <>commented{showItem && <> on {item}</>}: <span className="excerpt">{d.excerpt}</span></>;
    case 'link.created':
    case 'link.removed':
      return (
        <>
          {e.type === 'link.removed' ? 'removed link: ' : 'linked '}
          <RefLink refStr={d.from} /> {linkVerb(d.kind, true)} <RefLink refStr={d.to} />
        </>
      );
    case 'agent.run_started':
      return (
        <>
          started a run{showItem && <> for {item}</>}
          {d.sessionUrl && <> · <a href={d.sessionUrl} target="_blank" rel="noreferrer">session ↗</a></>}
        </>
      );
    case 'agent.run_failed':
      return <>couldn’t start a run{showItem && <> for {item}</>}: <span className="excerpt">{d.error}</span></>;
    case 'agent.run_throttled':
      return <>hit its limit of {d.limit} runs an hour{showItem ? <> on {item}</> : ' on this item'}; updates are queued until {new Date(d.resumesAt).toLocaleTimeString()}</>;
    case 'project.created':
      return <>created the project</>;
    case 'project.updated':
      return d.changes && 'repository' in d.changes
        ? (d.changes.repository ? <>linked the project to <b>{d.changes.repository}</b> on GitHub</> : <>unlinked the project’s GitHub repository</>)
        : <>updated the project settings</>;
    case 'project.value_set':
      return d.before === null ? <>set <code>{d.key}</code> to <span className="excerpt">{d.value}</span></> : <>changed <code>{d.key}</code> to <span className="excerpt">{d.value}</span></>;
    case 'project.value_deleted':
      return <>deleted the value <code>{d.key}</code></>;
    case 'watchdog.nudged':
      return <>was nudged by the watchdog{showItem && <> on {item}</>}: stalled in <b>{d.status}</b> for {d.idleMinutes} min (nudge {d.nudge})</>;
    case 'watchdog.escalated':
      return <>needs a human{showItem && <> on {item}</>}, says the watchdog: stalled in <b>{d.status}</b> for {d.idleMinutes} min, {d.why}</>;
    case 'github.connected':
      return <>connected GitHub (<b>{d.account}</b>)</>;
    case 'github.pull_request':
      return (
        <>
          (via GitHub) pull request <a href={d.url} target="_blank" rel="noreferrer">#{d.number} {d.title}</a> {d.action}
          {d.author && <> by {d.author}</>}{showItem && <> · {item}</>}
        </>
      );
    case 'github.commit':
      return (
        <>
          (via GitHub) commit <a href={d.url} target="_blank" rel="noreferrer"><code>{d.sha}</code></a> on {d.branch}: <span className="excerpt">{d.message}</span>
          {showItem && <> · {item}</>}
        </>
      );
    default:
      return <>{e.type}</>;
  }
}

export function EventRow({ e, showItem }: { e: Event; showItem: boolean }) {
  return (
    <li className="event">
      <Avatar name={e.actorName} kind={e.actorKind} url={e.actorAvatar} size={22} />
      <div>
        <b>{e.actorName}</b> <KindBadge kind={e.actorKind} /> {describe(e, showItem)} · <Time iso={e.createdAt} />
      </div>
    </li>
  );
}

export function ErrorNote({ error }: { error: string | null }) {
  return error ? <div className="error">{error}</div> : null;
}

export function Modal({ onClose, title, children }: { onClose: () => void; title: string; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label={title}>
        <header>
          <h3>{title}</h3>
          <button className="icon" onClick={onClose} aria-label="Close">×</button>
        </header>
        {children}
      </div>
    </div>
  );
}

export function CopyField({ value, buttonOnly }: { value: string; buttonOnly?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy-field">
      {!buttonOnly && <code>{value}</code>}
      <button
        onClick={() => {
          navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

/** GitHub-flavored Markdown. Raw HTML is not rendered, so user content can't inject markup. */
export function Markdown({ children }: { children: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{ a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener" /> }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

/**
 * Markdown that turns into an editor when clicked (or its placeholder is clicked). Links and text
 * selection don't trigger editing. Cmd/Ctrl+Enter saves, Esc cancels.
 */
export function EditableMarkdown(props: { value: string; onSave: (value: string) => Promise<unknown>; placeholder: string; editPlaceholder?: string; readOnly?: boolean }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    try {
      await props.onSave(draft ?? '');
      setDraft(null);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  if (draft !== null) {
    return (
      <div className="stack">
        <textarea
          autoFocus
          rows={Math.min(Math.max(draft.split('\n').length + 2, 8), 30)}
          value={draft}
          placeholder={props.editPlaceholder ?? 'Markdown is supported.'}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setDraft(null);
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save();
          }}
        />
        <ErrorNote error={error} />
        <div className="actions">
          <span className="muted small grow">Markdown supported · ⌘/Ctrl+Enter to save · Esc to cancel</span>
          <button className="ghost small" onClick={() => setDraft(null)}>Cancel</button>
          <button className="primary small" onClick={save}>Save</button>
        </div>
      </div>
    );
  }
  if (props.readOnly) return props.value ? <div className="body"><Markdown>{props.value}</Markdown></div> : <p className="muted">{props.placeholder}</p>;
  return (
    <div
      className={`body editable ${props.value ? '' : 'empty'}`}
      title="Click to edit"
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('a') || window.getSelection()?.toString()) return;
        setDraft(props.value);
      }}
    >
      {props.value ? <Markdown>{props.value}</Markdown> : <span className="muted">{props.placeholder}</span>}
    </div>
  );
}

/** Tabs kept in the URL (?tab=…) so a tab can be linked to and survives reloads. */
export function useTab<T extends string>(tabs: readonly T[]) {
  const [params, setParams] = useSearchParams();
  const current = (tabs as readonly string[]).includes(params.get('tab') ?? '') ? (params.get('tab') as T) : tabs[0];
  const select = (t: T) => setParams(t === tabs[0] ? {} : { tab: t }, { replace: true });
  return [current, select] as const;
}

export function Tabs<T extends string>({ tabs, labels, current, onSelect }: { tabs: readonly T[]; labels: Record<T, string>; current: T; onSelect: (t: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t} role="tab" aria-selected={t === current} className={t === current ? 'on' : ''} onClick={() => onSelect(t)}>
          {labels[t]}
        </button>
      ))}
    </div>
  );
}

export function SkillChip({ skill, missing }: { skill: string; missing?: boolean }) {
  return <span className={`skill ${missing ? 'missing' : ''}`}>{missing ? `needs ${skill}` : skill}</span>;
}

/** Comma-separated skills editor with suggestions; saves on Enter/blur-less Save. */
export function SkillsEditor({ value, suggestions, onSave }: { value: string[]; suggestions: string[]; onSave: (skills: string[]) => Promise<unknown> }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (draft === null) {
    return (
      <span className="skills">
        {value.map((s) => <SkillChip key={s} skill={s} />)}
        <button className="link small" onClick={() => setDraft(value.join(', '))}>{value.length ? 'edit' : '+ skills'}</button>
      </span>
    );
  }
  return (
    <form
      className="skills-edit"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await onSave(draft.split(',').map((s) => s.trim()).filter(Boolean));
          setDraft(null);
          setError(null);
        } catch (err) {
          setError((err as Error).message);
        }
      }}
    >
      <input autoFocus list="skill-suggestions" value={draft} placeholder="backend, db" onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setDraft(null)} />
      <datalist id="skill-suggestions">{suggestions.map((s) => <option key={s} value={s} />)}</datalist>
      <button className="small primary">Save</button>
      {error && <span className="error small">{error}</span>}
    </form>
  );
}

/**
 * An agent will pick this up soon: counts down the quiet period (people may still be editing), then says
 * "queued" while the agent finishes other work.
 */
export function StartsSoon({ at }: { at: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const left = Math.ceil((new Date(at).getTime() - now) / 1000);
  const label = left > 0 ? `starting in ${left >= 60 ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` : `${left}s`}` : 'queued';
  const title = left > 0
    ? 'An agent will start on this after a short quiet period, so any edits you are still making reach it together'
    : 'Waiting for the agent to finish its current work';
  return <span className="starting" title={title}>{label}</span>;
}

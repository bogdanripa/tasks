import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
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
        </>
      );
    case 'item.updated': {
      const c = d.changes ?? {};
      const parts: ReactNode[] = [];
      if (c.status) parts.push(<>moved {item} from <b>{c.status[0]}</b> to <b>{c.status[1]}</b></>);
      if (c.assignee) parts.push(c.assignee[1] ? <>assigned {item} to <b>{c.assignee[1]}</b></> : <>unassigned {item}</>);
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

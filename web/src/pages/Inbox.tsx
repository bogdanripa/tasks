import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useParamState } from '../filters';
import { api, itemPath } from '../api';
import { useSession } from '../App';
import { Avatar, KindBadge, Time, TypeBadge, useFetch } from '../ui';

const REASONS: Record<string, string> = {
  assigned: 'assigned you',
  commented: 'commented',
  status_changed: 'moved your item',
  unblocked: 'unblocked your item',
  triggered_item_done: 'finished an issue yours triggered',
  all_tasks_done: 'finished the last task on your issue',
  task_added: 'added a task to your issue',
  done: 'finished an item you created',
  review_requested: 'asked you to review',
  changes_requested: 'requested changes on your work',
  updated: 'changed an item assigned to you',
  linked: 'linked an item assigned to you',
  stalled: 'is stuck and needs you (watchdog)',
  needs_reviewer: 'needs a reviewer',
};

/** What needs you, as opposed to keeping you informed: the same set that alerts you on Telegram. */
const needsMe = (n: any) =>
  n.reason === 'stalled' || n.reason === 'needs_reviewer' || n.reason === 'review_requested' || n.reason === 'changes_requested' ||
  (n.reason === 'assigned' && n.actorKind === 'agent');

export default function Inbox() {
  const { refreshMe } = useSession();
  const { data, reload } = useFetch<any[]>('/api/inbox?limit=200');
  const navigate = useNavigate();
  const [from, setFrom] = useParamState<string>('from', 'inbox:from', 'all');
  const [only, setOnly] = useParamState<'all' | 'needs-me' | 'unread'>('show', 'inbox:show', 'all');
  const actors = useMemo(() => {
    const m = new Map<string, { id: string; name: string; kind: string }>();
    for (const n of data ?? []) m.set(n.actorId, { id: n.actorId, name: n.actorName, kind: n.actorKind });
    return [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [data]);
  const list = (data ?? []).filter(
    (n) =>
      (from === 'all' || (from === 'agents' ? n.actorKind === 'agent' : from === 'humans' ? n.actorKind === 'human' : n.actorId === from)) &&
      (only === 'all' || (only === 'needs-me' ? needsMe(n) : !n.readAt)),
  );
  const read = async (ids: number[] | 'all') => {
    await api('POST', '/api/inbox/read', { ids });
    reload();
    refreshMe();
  };
  return (
    <div className="page narrow">
      <div className="page-head">
        <h1>Inbox</h1>
        <button onClick={() => read('all')}>Mark all read</button>
      </div>
      <div className="board-filters inbox-filters">
        <div className="segmented" role="tablist" aria-label="Show">
          {(['all', 'needs-me', 'unread'] as const).map((v) => (
            <button key={v} role="tab" aria-selected={only === v} className={only === v ? 'on' : ''} onClick={() => setOnly(v)}>
              {v === 'all' ? 'Everything' : v === 'needs-me' ? 'Needs me' : 'Unread'}
            </button>
          ))}
        </div>
        <label className="picker">
          <span className="muted small">From</span>
          <select value={from} onChange={(e) => setFrom(e.target.value)} className={from !== 'all' ? 'active' : ''}>
            <option value="all">Anyone</option>
            <option value="agents">Agents</option>
            <option value="humans">People</option>
            {actors.some((a) => a.kind === 'agent') && (
              <optgroup label="Agents">{actors.filter((a) => a.kind === 'agent').map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</optgroup>
            )}
            {actors.some((a) => a.kind === 'human') && (
              <optgroup label="People">{actors.filter((a) => a.kind === 'human').map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</optgroup>
            )}
          </select>
        </label>
      </div>
      {data?.length === 0 && <p className="muted">Nothing here yet.</p>}
      {!!data?.length && !list.length && <p className="muted">Nothing matches these filters.</p>}
      <ul className="inbox">
        {list.map((n) => (
          <li
            key={n.id}
            className={n.readAt ? 'read' : 'unread'}
            onClick={() => {
              if (!n.readAt) read([Number(n.id)]);
              if (n.itemRef) navigate(itemPath(n.itemRef));
            }}
          >
            <Avatar name={n.actorName} kind={n.actorKind} />
            <div className="grow">
              <div>
                <b>{n.actorName}</b> <KindBadge kind={n.actorKind} /> {REASONS[n.reason] ?? n.reason}
                {n.eventType === 'comment.created' && <span className="excerpt">: {n.eventData.excerpt}</span>}
              </div>
              {n.itemRef && (
                <div className="muted small">
                  <TypeBadge type={n.itemType} /> {n.itemRef} · {n.itemTitle} · {n.itemStatus}
                </div>
              )}
            </div>
            <Time iso={n.createdAt} />
          </li>
        ))}
      </ul>
    </div>
  );
}

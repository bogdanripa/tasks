import { useNavigate } from 'react-router-dom';
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
};

export default function Inbox() {
  const { refreshMe } = useSession();
  const { data, reload } = useFetch<any[]>('/api/inbox');
  const navigate = useNavigate();
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
      {data?.length === 0 && <p className="muted">Nothing here yet.</p>}
      <ul className="inbox">
        {data?.map((n) => (
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

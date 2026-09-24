import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { itemPath, type Item } from '../api';
import { Avatar, SkillChip, Time } from '../ui';

type Row = Item & { updatedAt?: string; parentId?: string | null };
type SortKey = 'status' | 'updated' | 'ref' | 'assignee';

/**
 * The List view: issues with their tasks nested under them, one row each, sortable. Tasks whose issue is
 * filtered out still show, with their parent's ref.
 */
export function ItemTable({ items, columns, flat }: { items: Row[]; columns: string[]; flat?: boolean }) {
  const navigate = useNavigate();
  const [sort, setSort] = useState<SortKey>('status');
  const [desc, setDesc] = useState(false);

  const rows = useMemo(() => {
    const order = (i: Row) => {
      switch (sort) {
        case 'status':
          return columns.indexOf(i.status) * 1e6 + i.position;
        case 'updated':
          return -new Date(i.updatedAt ?? 0).getTime();
        case 'ref':
          return i.number;
        case 'assignee':
          return 0;
      }
    };
    const cmp = (a: Row, b: Row) => {
      const r = sort === 'assignee' ? (a.assigneeName ?? '~').localeCompare(b.assigneeName ?? '~') : order(a)! - order(b)!;
      return (desc ? -r : r) || a.number - b.number;
    };
    if (flat) return [...items].sort(cmp).map((i) => ({ item: i, nested: false }));
    const visible = new Set(items.map((i) => i.id));
    const tops = items.filter((i) => i.type === 'issue' || !i.parentId || !visible.has(i.parentId)).sort(cmp);
    const out: { item: Row; nested: boolean }[] = [];
    for (const t of tops) {
      out.push({ item: t, nested: false });
      if (t.type === 'issue') for (const c of items.filter((i) => i.parentId === t.id).sort(cmp)) out.push({ item: c, nested: true });
    }
    return out;
  }, [items, columns, sort, desc, flat]);

  const head = (key: SortKey, label: string) => (
    <th>
      <button
        className="link th-sort"
        onClick={() => (sort === key ? setDesc(!desc) : (setSort(key), setDesc(false)))}
        aria-sort={sort === key ? (desc ? 'descending' : 'ascending') : 'none'}
      >
        {label} {sort === key ? (desc ? '▾' : '▴') : ''}
      </button>
    </th>
  );

  if (!rows.length) return <p className="muted list-empty">Nothing matches these filters.</p>;
  return (
    <div className="item-table-wrap">
      <table className="item-table">
        <thead>
          <tr>
            {head('ref', 'Item')}
            <th>Title</th>
            {head('status', 'Status')}
            {head('assignee', 'Assignee')}
            <th>Skill</th>
            {head('updated', 'Updated')}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ item: i, nested }) => (
            <tr
              key={i.id}
              className={`${i.done ? 'done' : ''} ${nested ? 'nested' : ''}`}
              onClick={() => navigate(itemPath(i.ref))}
              tabIndex={0}
              onKeyDown={(e) => e.key === 'Enter' && navigate(itemPath(i.ref))}
            >
              <td className="ref-cell">
                <span className={`type-dot ${i.type}`} title={i.type} /> {i.ref.split('/')[1]}
              </td>
              <td className="title-cell">
                {nested && <span className="muted">↳ </span>}
                {i.title}
                {!nested && i.parentRef && <span className="muted small"> · {i.parentRef.split('/')[1]}</span>}
                {i.working && <span className="working"> working</span>}
                {!i.done && !!i.blockedBy?.length && <span className="pill" title={`Waiting on ${i.blockedBy.join(', ')}`}> ⏸ blocked</span>}
                {!!i.tasksTotal && <span className="muted small"> ☑ {i.tasksDone}/{i.tasksTotal}</span>}
              </td>
              <td><span className="status-chip">{i.status}</span></td>
              <td>
                {i.assigneeName ? (
                  <span className={`assignee ${i.assigneeKind ?? ''}`}>
                    <Avatar name={i.assigneeName} kind={i.assigneeKind} size={18} /> {i.assigneeName}
                  </span>
                ) : (
                  <span className="muted small">—</span>
                )}
              </td>
              <td>{i.skill ? <SkillChip skill={i.skill} /> : null}</td>
              <td className="muted small">{i.updatedAt ? <Time iso={i.updatedAt} /> : null}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

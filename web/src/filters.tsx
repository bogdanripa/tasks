import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * Who work is assigned to: me, all agents, all people, nobody, or one member (by id). Shared by the board,
 * the list and Home; the inbox has its own "from" filter. The choice lives in the URL (so it can be linked)
 * and is remembered per place in localStorage.
 */
export type Assignee = 'all' | 'me' | 'agents' | 'humans' | 'unassigned' | string;
export type Member = { id: string; name: string; kind: 'human' | 'agent' };

export function matchAssignee(i: { assigneeId: string | null; assigneeKind: string | null }, f: Assignee, meId: string) {
  switch (f) {
    case 'all':
      return true;
    case 'me':
      return i.assigneeId === meId;
    case 'agents':
      return i.assigneeKind === 'agent';
    case 'humans':
      return i.assigneeKind === 'human';
    case 'unassigned':
      return !i.assigneeId;
    default:
      return i.assigneeId === f;
  }
}

/**
 * A choice held in state, starting from the URL param (so links work) or what was last picked here
 * (localStorage under `storeKey`). Changing it saves both; the default leaves the URL clean.
 */
export function useParamState<T extends string>(name: string, storeKey: string, fallback: T): [T, (v: T) => void] {
  const [params, setParams] = useSearchParams();
  const initial = () => {
    const fromUrl = params.get(name) as T | null;
    if (fromUrl) return fromUrl;
    try {
      return (localStorage.getItem(storeKey) as T | null) ?? fallback;
    } catch {
      return fallback;
    }
  };
  const [value, setValue] = useState<T>(initial);
  // Another place (a different project) uses a different key: start from its own saved choice.
  useEffect(() => setValue(initial()), [storeKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (v: T) => {
    setValue(v);
    try {
      localStorage.setItem(storeKey, v);
    } catch {}
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (v === fallback) next.delete(name);
        else next.set(name, v);
        return next;
      },
      { replace: true },
    );
  };
  return [value, set];
}

export function AssigneePicker({ value, onChange, members, label = 'Assignee' }: {
  value: Assignee; onChange: (v: Assignee) => void; members: Member[]; label?: string;
}) {
  const agents = useMemo(() => members.filter((m) => m.kind === 'agent').sort((a, b) => a.name.localeCompare(b.name)), [members]);
  const people = useMemo(() => members.filter((m) => m.kind === 'human').sort((a, b) => a.name.localeCompare(b.name)), [members]);
  const known = ['all', 'me', 'agents', 'humans', 'unassigned'].includes(value) || members.some((m) => m.id === value);
  return (
    <label className="picker">
      <span className="muted small">{label}</span>
      <select value={known ? value : 'all'} onChange={(e) => onChange(e.target.value)} className={value !== 'all' ? 'active' : ''}>
        <option value="all">Anyone</option>
        <option value="me">Me</option>
        <option value="agents">All agents</option>
        <option value="humans">All people</option>
        <option value="unassigned">Unassigned</option>
        {agents.length > 0 && (
          <optgroup label="Agents">
            {agents.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </optgroup>
        )}
        {people.length > 0 && (
          <optgroup label="People">
            {people.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </optgroup>
        )}
      </select>
    </label>
  );
}

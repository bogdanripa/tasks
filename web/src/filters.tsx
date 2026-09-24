import { useEffect, useMemo } from 'react';
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

/** A URL search param, falling back to (and remembered in) localStorage under `storeKey`. */
export function useParamState<T extends string>(name: string, storeKey: string, fallback: T): [T, (v: T) => void] {
  const [params, setParams] = useSearchParams();
  const stored = (() => {
    try {
      return localStorage.getItem(storeKey) as T | null;
    } catch {
      return null;
    }
  })();
  const value = (params.get(name) as T | null) ?? stored ?? fallback;
  useEffect(() => {
    try {
      localStorage.setItem(storeKey, value);
    } catch {}
  }, [storeKey, value]);
  const set = (v: T) => {
    const next = new URLSearchParams(params);
    if (v === fallback) next.delete(name);
    else next.set(name, v);
    setParams(next, { replace: true });
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

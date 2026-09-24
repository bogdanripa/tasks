import { toast } from './toast';

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// Changes that confirm themselves on screen (the board, comments, links, reading the inbox) don't toast.
const QUIET = [/^\/api\/items\//, /\/items$/, /^\/api\/comments\//, /^\/api\/links/, /^\/api\/notifications/, /^\/api\/me\b/, /^\/api\/inbox\//, /^\/auth\//, /\/test$/, /\/read$/, /\/models$/];

function confirmation(method: string, path: string) {
  if (method === 'GET' || QUIET.some((re) => re.test(path))) return null;
  if (method === 'DELETE') return 'Removed';
  if (method !== 'POST') return 'Saved';
  if (/\/runs\/[^/]+\/end$/.test(path)) return 'Run ended';
  if (/\/schedules\/[^/]+\/run$/.test(path)) return 'Started';
  if (/\/invites$/.test(path)) return 'Invitation sent';
  if (/\/keys$/.test(path)) return 'Key created';
  return 'Added';
}

export async function api<T = any>(method: string, path: string, body?: unknown, opts: { toast?: string | false } = {}): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, json.error ?? res.statusText);
  const done = opts.toast === false ? null : opts.toast ?? confirmation(method, path.split('?')[0]);
  if (done) toast(done);
  return json as T;
}

export const get = <T = any>(path: string) => api<T>('GET', path);

export type Me = {
  id: string;
  kind: 'human' | 'agent';
  name: string;
  email: string | null;
  avatarUrl: string | null;
  orgs: { id: string; slug: string; name: string; role: string }[];
  unread: number;
};

export type Item = {
  id: string;
  ref: string;
  number: number;
  type: 'issue' | 'task';
  title: string;
  body?: string;
  status: string;
  position: number;
  assigneeId: string | null;
  assigneeName: string | null;
  assigneeKind: 'human' | 'agent' | null;
  parentRef: string | null;
  done: boolean;
  tasksTotal?: number;
  tasksDone?: number;
  linkCount?: number;
  skill?: string | null;
  working?: boolean;
  blockedBy?: string[];
};

export type Event = {
  id: string;
  type: string;
  data: any;
  createdAt: string;
  actorName: string;
  actorKind: 'human' | 'agent';
  actorAvatar: string | null;
  itemId?: string | null;
  itemRef?: string;
  itemTitle?: string;
};

/** "acme/WEB-12" → "/i/acme/WEB-12" */
export const itemPath = (ref: string) => `/i/${ref}`;

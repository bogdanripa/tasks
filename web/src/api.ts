export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, json.error ?? res.statusText);
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

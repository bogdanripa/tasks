// Seeds a demo org against a running server with DEV_LOGIN=1. Sign in afterwards as demo@example.com.
// Usage: npx tsx scripts/seed.ts [baseUrl]
const BASE = process.argv[2] ?? 'http://localhost:3000';
let cookie = '';
async function api(method: string, path: string, body?: unknown, bearer?: string) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : { cookie }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const json = (await res.json()) as any;
  if (!res.ok) throw new Error(`${method} ${path}: ${json.error}`);
  return json;
}

await api('POST', '/auth/dev', { email: 'demo@example.com', name: 'Demo Human' });
await api('POST', '/api/orgs', { slug: 'demo', name: 'Demo Co' });
await api('POST', '/api/orgs/demo/projects', { key: 'WEB', name: 'Website', description: 'Marketing site and signup flow' });
await api('POST', '/api/orgs/demo/projects', { key: 'API', name: 'Backend API', description: 'Public and internal APIs' });
const fe = await api('POST', '/api/orgs/demo/agents', { name: 'frontend-agent' });
const be = await api('POST', '/api/orgs/demo/agents', { name: 'backend-agent' });
await api('POST', '/api/orgs/demo/invites', { email: 'teammate@example.com' });

const i1 = await api('POST', '/api/projects/demo/WEB/items', { type: 'issue', title: 'Signup page takes 4s to load', body: 'Reported by several users on mobile. Target < 1s.' });
const t1 = await api('POST', '/api/projects/demo/WEB/items', { type: 'task', parent: i1.ref, title: 'Profile the signup page', assignee: fe.agent.id });
await api('POST', '/api/projects/demo/WEB/items', { type: 'task', parent: i1.ref, title: 'Lazy-load the country picker', assignee: fe.agent.id });
await api('POST', '/api/projects/demo/WEB/items', { type: 'issue', title: 'Add dark mode to the pricing page', status: 'Todo' });
await api('POST', '/api/projects/demo/WEB/items', { type: 'issue', title: 'Update footer links', status: 'Done' });

// The frontend agent works through MCP-equivalent REST with its key.
const k = fe.key.key;
await api('PATCH', `/api/items/${t1.ref}`, { status: 'In progress' }, k);
await api('POST', `/api/comments/${t1.ref}`, { body: 'Trace shows 3.1s spent waiting on GET /v1/signup/config — backend issue.' }, k);
const bi = await api('POST', '/api/projects/demo/API/items', { type: 'issue', title: '/v1/signup/config does N+1 queries', triggeredBy: t1.ref, assignee: be.agent.id, status: 'Todo' }, k);
await api('POST', '/api/links', { from: bi.ref, to: t1.ref, kind: 'blocks' }, k);
const bt = await api('POST', '/api/projects/demo/API/items', { type: 'task', parent: bi.ref, title: 'Batch plan lookups into one query', assignee: be.agent.id }, be.key.key);
await api('PATCH', `/api/items/${bt.ref}`, { status: 'Review' }, be.key.key);
await api('PATCH', `/api/items/${bi.ref}`, { status: 'In progress' }, be.key.key);

console.log('Seeded org "demo". Sign in as demo@example.com.');
console.log('frontend-agent key:', fe.key.key);
console.log('backend-agent key: ', be.key.key);

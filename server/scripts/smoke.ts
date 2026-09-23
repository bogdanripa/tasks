// End-to-end smoke test against a running server with DEV_LOGIN=1.
// Usage: npx tsx scripts/smoke.ts [baseUrl]
import http from 'node:http';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const run = Date.now().toString(36);
let cookie = '';

async function api(method: string, path: string, body?: unknown, bearer?: string) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(bearer ? { authorization: `Bearer ${bearer}` } : { cookie }),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json)}`);
  return json as any;
}

let rpcId = 0;
async function mcp(key: string, name: string, args: Record<string, unknown> = {}) {
  const res = await fetch(BASE + '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${key}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }),
  });
  const json = (await res.json()) as any;
  if (json.error) throw new Error(`mcp ${name}: ${JSON.stringify(json.error)}`);
  const text = json.result.content[0].text;
  if (json.result.isError) throw new Error(`mcp ${name}: ${text}`);
  try { return JSON.parse(text); } catch { return text; }
}

// Local webhook receiver that verifies signatures.
const received: any[] = [];
let secret = '';
const hook = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const sig = 'sha256=' + createHmac('sha256', secret).update(`${req.headers['x-tasks-timestamp']}.${body}`).digest('hex');
    assert.equal(req.headers['x-tasks-signature'], sig, 'webhook signature');
    received.push(JSON.parse(body));
    res.end('ok');
  });
});
await new Promise<void>((r) => hook.listen(4555, r));
const waitFor = async (pred: () => boolean, what: string) => {
  for (let i = 0; i < 50 && !pred(); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(pred(), `timed out waiting for ${what}`);
};

// Human signs in, creates an org and two projects.
await api('POST', '/auth/dev', { email: `alice-${run}@example.com`, name: 'Alice' });
const org = `acme-${run}`;
await api('POST', '/api/orgs', { slug: org, name: 'Acme' });
await api('POST', `/api/orgs/${org}/projects`, { key: 'WEB', name: 'Website' });
await api('POST', `/api/orgs/${org}/projects`, { key: 'API', name: 'Backend' });
// Keys default to the first three letters of the name, taking the next free variant on collision.
assert.equal((await api('POST', `/api/orgs/${org}/projects`, { name: 'Marketing site' })).key, 'MAR');
assert.equal((await api('POST', `/api/orgs/${org}/projects`, { name: 'Website v2' })).key, 'WEB2');
assert.equal((await api('POST', `/api/orgs/${org}/projects`, { name: '3D renders' })).key, 'DRE');
console.log('✓ default project keys: MAR, WEB2, DRE');

// Two agents: one with a webhook, one that long-polls via MCP.
const hooked = await api('POST', `/api/orgs/${org}/agents`, { name: `builder-${run}`, webhookUrl: 'http://localhost:4555/hook' });
secret = hooked.agent.webhookSecret;
const poller = await api('POST', `/api/orgs/${org}/agents`, { name: `backend-${run}` });

// Issue + task assigned to the webhook agent → ping.
const issue = await api('POST', `/api/projects/${org}/WEB/items`, { type: 'issue', title: 'Signup page is slow' });
assert.equal(issue.ref, `${org}/WEB-1`);
const task = await api('POST', `/api/projects/${org}/WEB/items`, { type: 'task', title: 'Profile signup page', parent: issue.ref, assignee: hooked.agent.id });
await waitFor(() => received.length > 0, 'webhook');
assert.equal(received[0].reason, 'assigned');
assert.equal(received[0].item.ref, task.ref);
console.log('✓ webhook ping on assignment', received[0].item.ref);

// Tasks require an issue parent.
await assert.rejects(api('POST', `/api/projects/${org}/WEB/items`, { type: 'task', title: 'orphan' }), /must belong to an issue/);

// Webhook agent works through MCP: reads inbox, raises a cross-project issue triggered by its task, assigns it to the poller.
const who = await mcp(hooked.key.key, 'whoami');
assert.equal(who.kind, 'agent');
const inbox = await mcp(hooked.key.key, 'get_inbox', { mark_read: true });
assert.equal(inbox[0].itemRef, task.ref);

const waiting = mcp(poller.key.key, 'wait_for_work', { timeout_seconds: 10 });
await new Promise((r) => setTimeout(r, 300));
const apiIssue = await mcp(hooked.key.key, 'create_issue', {
  project: `${org}/API`, title: 'Signup endpoint does N+1 queries', triggered_by: task.ref, assignee: `backend-${run}`,
});
const woke = await waiting;
assert.equal(woke[0].itemRef, apiIssue.ref);
console.log('✓ long-poll woke on cross-project assignment', apiIssue.ref);

await mcp(hooked.key.key, 'link_items', { from: apiIssue.ref, to: task.ref, kind: 'blocks' });
await mcp(hooked.key.key, 'update_item', { ref: task.ref, status: 'In progress' });

// Poller finishes the backend issue → webhook agent is told it's unblocked and its triggered item is done.
await mcp(poller.key.key, 'comment', { ref: apiIssue.ref, body: 'Batched the queries.' });
received.length = 0;
await mcp(poller.key.key, 'update_item', { ref: apiIssue.ref, status: 'Done' });
await waitFor(() => received.some((r) => r.reason === 'unblocked'), 'unblocked ping');
console.log('✓ unblocked ping:', received.map((r) => r.reason).join(', '));

// Agent finishes the last task → issue owner (Alice, who created it) gets all_tasks_done in her inbox.
await mcp(hooked.key.key, 'update_item', { ref: task.ref, status: 'Done' });
const aliceInbox = await api('GET', '/api/inbox?unread=1');
assert.ok(aliceInbox.some((n: any) => n.reason === 'all_tasks_done'), 'all_tasks_done in Alice inbox');
console.log('✓ issue owner notified when all tasks are done');

// History + links + timeline.
const detail = await api('GET', `/api/items/${task.ref}`);
assert.deepEqual(detail.links.map((l: any) => l.kind).sort(), ['blocks', 'triggered']);
assert.ok(detail.history.length >= 4);
const tl = await mcp(hooked.key.key, 'project_timeline', { project: `${org}/API` });
assert.ok(tl.some((e: any) => e.type === 'link.created' && e.data.kind === 'triggered'));
console.log('✓ history', detail.history.length, 'events; API timeline', tl.length, 'events');

// Triggered links are permanent.
const trig = detail.links.find((l: any) => l.kind === 'triggered');
await assert.rejects(api('DELETE', `/api/links/${trig.id}`), /permanent/);

// ---- Routine agents: one run at a time, queued updates, 429 pause, run token, run finishes on status ----
const fires: { auth: string; beta: string; text: string }[] = [];
let respond429 = 0;
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    // Only this run's routine: leftovers from earlier (crashed) runs must not count.
    if (req.url !== `/v1/claude_code/routines/trig_${run}/fire`) {
      res.writeHead(404);
      return res.end();
    }
    if (respond429 > 0) {
      respond429--;
      res.writeHead(429, { 'retry-after': '1', 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'rate limited' } }));
    }
    fires.push({ auth: String(req.headers.authorization), beta: String(req.headers['anthropic-beta']), text: JSON.parse(body).text });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'routine_fire', claude_code_session_url: `https://claude.ai/code/session_${fires.length}` }));
  });
});
await new Promise<void>((r) => fake.listen(4556, r));
const tokenOf = (text: string) => /TASKS_TOKEN=(tsk_\S+)/.exec(text)![1];

const rAgent = await api('POST', `/api/orgs/${org}/agents`, { name: `pironman-${run}` });
await api('PATCH', `/api/agents/${rAgent.agent.id}`, { routineUrl: `http://localhost:4556/v1/claude_code/routines/trig_${run}/fire`, routineToken: 'sk-ant-oat01-test-token' });
await assert.rejects(api('PATCH', `/api/agents/${rAgent.agent.id}`, { routineUrl: 'https://evil.example.com/fire' }), /must look like/);

const opsRoot = await api('POST', `/api/projects/${org}/WEB/items`, { type: 'issue', title: 'Pi housekeeping' });
const r1 = await api('POST', `/api/projects/${org}/WEB/items`, { type: 'task', parent: opsRoot.ref, title: 'Rotate logs', assignee: rAgent.agent.id });
await api('POST', `/api/comments/${r1.ref}`, { body: 'Keep 7 days please.' }); // same burst → same run
await waitFor(() => fires.length === 1, 'first routine fire');
await new Promise((r) => setTimeout(r, 1500));
assert.equal(fires.length, 1, 'burst of updates is one run');
assert.equal(fires[0].auth, 'Bearer sk-ant-oat01-test-token');
assert.equal(fires[0].beta, 'experimental-cc-routine-2026-04-01');
assert.match(fires[0].text, new RegExp(`Task: ${r1.ref}`));
assert.match(fires[0].text, /assigned it to you/);
assert.match(fires[0].text, /Keep 7 days please/);
const run1 = tokenOf(fires[0].text);
console.log('✓ routine fired once for a burst (assign + comment), with task context');

// While the run is active, more updates queue up instead of firing.
const r2 = await api('POST', `/api/projects/${org}/WEB/items`, { type: 'task', parent: opsRoot.ref, title: 'Renew certs', assignee: rAgent.agent.id });
await api('POST', `/api/comments/${r1.ref}`, { body: 'Also compress them.' });
await new Promise((r) => setTimeout(r, 2500));
assert.equal(fires.length, 1, 'no second run while the first is active');
const agentView = await api('GET', `/api/agents/${rAgent.agent.id}`);
assert.equal(agentView.queue.items, 2);
assert.equal(agentView.runs[0].sessionUrl, 'https://claude.ai/code/session_1');
console.log('✓ updates queue while a run is active:', agentView.queue.updates, 'updates on', agentView.queue.items, 'items');

// The run works through the API with its token, as the agent. Its own changes don't wake itself.
const seen = await api('GET', `/api/items/${r1.ref}`, undefined, run1);
assert.ok(seen.history.some((e: any) => e.type === 'agent.run_started' && e.data.sessionUrl));
await api('POST', `/api/comments/${r1.ref}`, { body: 'Rotated and compressed.' }, run1);
await api('PATCH', `/api/items/${r1.ref}`, { status: 'Done' }, run1); // last step: ends the run

// Queue moves, oldest pending update first: r2's assignment (queued before r1's second comment), then r1.
await waitFor(() => fires.length === 2, 'second run after the first finished');
assert.match(fires[1].text, new RegExp(`Task: ${r2.ref}`));
await api('PATCH', `/api/items/${r2.ref}`, { status: 'Review' }, tokenOf(fires[1].text));
await waitFor(() => fires.length === 3, 'third run, back on the first task');
assert.match(fires[2].text, new RegExp(`Task: ${r1.ref}`));
assert.match(fires[2].text, /Also compress them/);
assert.doesNotMatch(fires[2].text, /Rotated and compressed/, 'own comment is not news');
console.log('✓ runs are serialized per agent, oldest pending update first');

// 429: pause the org's routines until Retry-After, then deliver (nothing dropped).
await api('PATCH', `/api/items/${r1.ref}`, { status: 'Review' }, tokenOf(fires[2].text));
respond429 = 1;
await api('POST', `/api/comments/${r2.ref}`, { body: 'Reopening: certs for the API too.' });
await waitFor(() => respond429 === 0, '429 response');
const paused = await api('GET', `/api/agents/${rAgent.agent.id}`);
assert.ok(paused.pause, 'org paused after 429');
await waitFor(() => fires.length === 4, 'fire after the pause');
assert.match(fires[3].text, /certs for the API too/);
console.log('✓ 429 pauses routines until Retry-After, then the queued run fires');

// Run tokens: expire shortly after the run ends, and never show up as the agent's keys.
assert.equal((await api('GET', `/api/agents/${rAgent.agent.id}`)).keys.length, 1);
fake.close();

// Deleting an org: owner + typed slug; cascades, cleans up cross-org links, revokes its agents.
const other = `other-${run}`;
await api('POST', '/api/orgs', { slug: other, name: 'Other' });
await api('POST', `/api/orgs/${other}/projects`, { key: 'OPS', name: 'Ops' });
const opsIssue = await api('POST', `/api/projects/${other}/OPS/items`, { type: 'issue', title: 'Rotate certs', triggeredBy: task.ref });
assert.equal((await api('GET', `/api/items/${opsIssue.ref}`)).links.length, 1);
await assert.rejects(api('DELETE', `/api/orgs/${org}`, { confirm: 'nope' }), /to confirm/);
await assert.rejects(api('DELETE', `/api/orgs/${org}`, { confirm: org }, poller.key.key), /Only an owner/);
await api('DELETE', `/api/orgs/${org}`, { confirm: org });
await assert.rejects(api('GET', `/api/orgs/${org}`), /404/);
assert.equal((await api('GET', `/api/items/${opsIssue.ref}`)).links.length, 0);
await assert.rejects(mcp(hooked.key.key, 'whoami'), /./);
console.log('✓ org deletion (owner-only, confirmed, cascades, agents revoked)');

// Isolation: a stranger sees nothing.
cookie = '';
await api('POST', '/auth/dev', { email: `mallory-${run}@example.com` });
await assert.rejects(api('GET', `/api/items/${opsIssue.ref}`), /404/);
console.log('✓ org isolation');

hook.close();
console.log('\nall smoke checks passed');

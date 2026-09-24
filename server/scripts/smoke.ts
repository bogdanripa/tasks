// End-to-end smoke test against a running server with DEV_LOGIN=1.
// Usage: npx tsx scripts/smoke.ts [baseUrl]
import http from 'node:http';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import postgres from 'postgres';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

// Direct DB access, only to simulate time passing for the scheduler.
const db = postgres(process.env.DATABASE_URL ?? 'postgres://tasks:tasks@localhost:5434/tasks', { onnotice: () => {} });

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
const aliceCookieForSettings = cookie;
const org = `acme-${run}`;
await api('POST', '/api/orgs', { slug: org, name: 'Acme', starterAgents: false });
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
const task = await api('POST', `/api/projects/${org}/WEB/items`, { type: 'task', title: 'Profile signup page', parent: issue.ref, assignee: hooked.agent.id, status: 'Todo' });
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
let respond500 = 0;
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    // Only this run's routine: leftovers from earlier (crashed) runs must not count.
    if (req.url !== `/v1/claude_code/routines/trig_${run}/fire`) {
      res.writeHead(404);
      return res.end();
    }
    if (respond500 > 0) {
      respond500--;
      res.writeHead(500);
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
// Guidelines (project and org) travel with every run.
await api('PATCH', `/api/projects/${org}/WEB`, { guidelines: 'Run the smoke test before Done.' });
await api('PATCH', `/api/orgs/${org}`, { guidelines: 'Be kind to the Pi.' });
assert.equal((await api('GET', `/api/items/${opsRoot.ref}`)).project.guidelines, 'Run the smoke test before Done.');

// Backlog is parked: assigning there doesn't start a run; moving it out does.
const parkedTask = await api('POST', `/api/projects/${org}/WEB/items`, { type: 'task', parent: opsRoot.ref, title: 'Someday: tidy crontab', assignee: rAgent.agent.id, status: 'Backlog' });
assert.equal((await api('POST', `/api/projects/${org}/WEB/items`, { type: 'issue', title: 'No status given' })).status, 'Todo', 'new items skip Backlog by default');
await api('POST', `/api/comments/${parkedTask.ref}`, { body: 'no rush' });
await new Promise((r) => setTimeout(r, 2500));
assert.equal(fires.length, 0, 'no run for an item in Backlog');
const skipped = (await api('GET', `/api/agents/${rAgent.agent.id}`)).deliveries.filter((n: any) => n.lastError === 'in backlog');
assert.equal(skipped.length, 2);
await api('PATCH', `/api/items/${parkedTask.ref}`, { status: 'Todo' });
await waitFor(() => fires.length === 1, 'run once the item leaves Backlog');
assert.match(fires[0].text, /moved it from Backlog to Todo/);
// The payload tells the agent to move it to the working column first; doing so doesn't end the run.
assert.match(fires[0].text, /Move the task to "In progress" first.*\n\s+curl -s -X PATCH .* -d '\{"status":"In progress"\}' \$TASKS\/api\/items\//);
assert.ok(fires[0].text.indexOf('export TASKS=') < fires[0].text.indexOf('How to work'), 'setup comes first');
assert.match(fires[0].text, /Project guidelines \(Website\):\nRun the smoke test before Done\./);
assert.match(fires[0].text, /Organization guidelines:\nBe kind to the Pi\./);
assert.match(fires[0].text, /hard limits win, then the project guidelines, then the organization guidelines/);
assert.match(fires[0].text, new RegExp(`Team, by skill:\\n(- .*\\n)*- \\(no skills\\): .*pironman-${run} \\(you\\)`));
await api('PATCH', `/api/items/${parkedTask.ref}`, { status: 'In progress' }, tokenOf(fires[0].text));
await api('POST', `/api/comments/${parkedTask.ref}`, { body: 'while you are at it: check cron.d too' });
await new Promise((r) => setTimeout(r, 2000));
assert.equal(fires.length, 1, 'moving to In progress did not end the run, so the comment waits');
await api('PATCH', `/api/items/${parkedTask.ref}`, { status: 'Done' }, tokenOf(fires[0].text)); // ends the run
await waitFor(() => fires.length === 2, 'queued comment runs after the first run ends');
assert.match(fires[1].text, /check cron\.d too/);
await api('PATCH', `/api/items/${parkedTask.ref}`, { status: 'Review' }, tokenOf(fires[1].text));
fires.length = 0;
console.log('✓ Backlog items don\'t ping agents; moving one out starts a run');

const r1 = await api('POST', `/api/projects/${org}/WEB/items`, { type: 'task', parent: opsRoot.ref, title: 'Rotate logs', assignee: rAgent.agent.id, status: 'Todo' });
// Quiet period (1s locally) restarts on each change: edits 0.7s apart, over 2s+, still make one run.
for (const body of ['Keep 7 days please.', 'Actually, 14 days.', 'And gzip them.']) {
  await new Promise((r) => setTimeout(r, 700));
  await api('POST', `/api/comments/${r1.ref}`, { body });
}
assert.equal(fires.length, 0, 'no run while the item is still being edited');
await waitFor(() => fires.length === 1, 'first routine fire');
await new Promise((r) => setTimeout(r, 1500));
assert.equal(fires.length, 1, 'burst of updates is one run');
assert.equal(fires[0].auth, 'Bearer sk-ant-oat01-test-token');
assert.equal(fires[0].beta, 'experimental-cc-routine-2026-04-01');
assert.match(fires[0].text, new RegExp(`Task: ${r1.ref}`));
assert.match(fires[0].text, /assigned it to you/);
assert.match(fires[0].text, /Keep 7 days please/);
assert.match(fires[0].text, /And gzip them/);
assert.match(fires[0].text, /PATCH \/api\/items\/\{ref\} \{title\?,body\?,status\?,assignee\?,position\?,skill\?\}/, 'compact API reference');
const run1 = tokenOf(fires[0].text);
console.log('✓ routine fired once for a burst (assign + comment), with task context');

// While the run is active, more updates queue up instead of firing.
const r2 = await api('POST', `/api/projects/${org}/WEB/items`, { type: 'task', parent: opsRoot.ref, title: 'Renew certs', assignee: rAgent.agent.id, status: 'Todo' });
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

// Edits reach the run with before/after: title change, description diff, full comment text.
await api('PATCH', `/api/items/${r2.ref}`, { body: 'Step 1: back up\nStep 2: use certbot\nStep 3: reload nginx' }); // queued: run 4 is active
await api('PATCH', `/api/items/${r2.ref}`, { title: 'Renew TLS certs', body: 'Step 1: back up\nStep 2: use acme.sh\nStep 3: reload nginx' });
const longComment = 'Please note:\n' + 'x'.repeat(600) + '\nEND-OF-COMMENT';
await api('POST', `/api/comments/${r2.ref}`, { body: longComment });
await api('PATCH', `/api/items/${r2.ref}`, { status: 'Done' }, tokenOf(fires[3].text)); // run 4 ends; queue moves
await waitFor(() => fires.length === 5, 'run with the edits');
assert.match(fires[4].text, /changed the title from "Renew certs" to "Renew TLS certs"/);
assert.match(fires[4].text, /-Step 2: use certbot\n\s+\+Step 2: use acme\.sh/, 'description diff');
assert.match(fires[4].text, /added\):\n    \+Step 1: back up/, 'first description: all added, no empty "-" line');
assert.match(fires[4].text, /END-OF-COMMENT/, 'full comment, not the excerpt');
const history = await api('GET', `/api/items/${r2.ref}`);
assert.ok(history.history.every((e: any) => !e.data.changes?.body || e.data.changes.body[0] === null), 'history omits description text');
console.log('✓ edits reach the run with before/after: title, description diff, full comment');

// A run takes every pending update on its item, even ones on a different timer (e.g. a failed attempt's backoff).
await api('PATCH', `/api/items/${r2.ref}`, { status: 'Review' }, tokenOf(fires[4].text)); // ends run 5
respond500 = 1;
await api('POST', `/api/comments/${r2.ref}`, { body: 'first (its fire fails once)' });
await waitFor(() => respond500 === 0, 'failed attempt');
await api('POST', `/api/comments/${r2.ref}`, { body: 'second (new quiet timer)' });
await waitFor(() => fires.length === 6, 'one run after the failure');
assert.match(fires[5].text, /first \(its fire fails once\)/);
assert.match(fires[5].text, /second \(new quiet timer\)/);
await new Promise((r) => setTimeout(r, 1500));
assert.equal(fires.length, 6, 'no second run for the leftover update');
console.log('✓ a run takes all pending updates on its item');

// Waiting on humans: while an open item blocks the agent's task, nothing wakes it; the last blocker finishing does.
await api('PATCH', `/api/items/${r2.ref}`, { status: 'Done' }, tokenOf(fires[5].text)); // end run 6
const r3 = await api('POST', `/api/projects/${org}/WEB/items`, { type: 'task', parent: opsRoot.ref, title: 'Rotate DB password', status: 'Todo' });
const h1 = await api('POST', `/api/projects/${org}/WEB/items`, { type: 'task', parent: opsRoot.ref, title: 'Approve downtime', status: 'Todo', assignee: `alice-${run}@example.com` });
const h2 = await api('POST', `/api/projects/${org}/WEB/items`, { type: 'task', parent: opsRoot.ref, title: 'Share vault access', status: 'Todo', assignee: `alice-${run}@example.com` });
await api('POST', '/api/links', { from: h1.ref, to: r3.ref, kind: 'blocks' });
await api('POST', '/api/links', { from: h2.ref, to: r3.ref, kind: 'blocks' });
await api('PATCH', `/api/items/${r3.ref}`, { assignee: rAgent.agent.id });
await api('POST', `/api/comments/${r3.ref}`, { body: 'any update?' });
await api('PATCH', `/api/items/${h1.ref}`, { status: 'Done' }); // one blocker left
await new Promise((r) => setTimeout(r, 2500));
assert.equal(fires.length, 6, 'no run while blocked');
const blockedRows = (await api('GET', `/api/agents/${rAgent.agent.id}`)).deliveries.filter((n: any) => n.itemRef === r3.ref);
assert.ok(blockedRows.length >= 3 && blockedRows.every((n: any) => n.lastError === 'blocked'), 'assigned, commented, first unblocked: all held');
await api('PATCH', `/api/items/${h2.ref}`, { status: 'Done' }); // last blocker
await waitFor(() => fires.length === 7, 'run once the last blocker is done');
assert.match(fires[6].text, new RegExp(`Task: ${r3.ref}`));
assert.match(fires[6].text, /"Share vault access", which blocked this, is done/);
console.log('✓ blocked tasks don\'t wake agents; the last blocker finishing does');

// A run can end without a status change; an issue's last task finishing starts its owner's DoD check.
assert.deepEqual(await api('POST', '/api/runs/end', {}, tokenOf(fires[6].text)), { ended: true });
assert.deepEqual(await api('POST', '/api/runs/end', {}, tokenOf(fires[6].text)), { ended: false });
const epic = await api('POST', `/api/projects/${org}/WEB/items`, { type: 'issue', title: 'Harden the Pi', status: 'Todo', assignee: rAgent.agent.id });
await waitFor(() => fires.length === 8, 'owner run for the new issue');
await api('POST', '/api/runs/end', {}, tokenOf(fires[7].text));
const epicTask = await api('POST', `/api/projects/${org}/WEB/items`, { type: 'task', parent: epic.ref, title: 'Enable unattended upgrades', status: 'Todo', assignee: `alice-${run}@example.com` });
await api('PATCH', `/api/items/${epicTask.ref}`, { status: 'Done' });
await waitFor(() => fires.length === 9, 'DoD run');
assert.match(fires[8].text, /ALL TASKS UNDER THIS ISSUE ARE DONE\. This run is the definition-of-done check/);
await api('POST', '/api/runs/end', {}, tokenOf(fires[8].text));
console.log('✓ explicit run end; the last task finishing starts the owner’s definition-of-done run');

// Work an agent gives itself wakes it after its current run; a pile of long comments stays under the payload limit.
const selfIssue = await api('POST', `/api/projects/${org}/WEB/items`, { type: 'issue', title: 'Self-planned work', status: 'Todo', assignee: rAgent.agent.id });
await waitFor(() => fires.length === 10, 'run on the self-planned issue');
const selfTask = await api('POST', `/api/projects/${org}/WEB/items`, { type: 'task', parent: selfIssue.ref, title: 'Do part one', assignee: rAgent.agent.id }, tokenOf(fires[9].text));
for (let i = 0; i < 20; i++) await api('POST', `/api/comments/${selfTask.ref}`, { body: `note ${i}: ` + 'y'.repeat(3900) });
await api('POST', '/api/runs/end', {}, tokenOf(fires[9].text));
await waitFor(() => fires.length === 11, 'run for the self-assigned task');
assert.match(fires[10].text, new RegExp(`Task: ${selfTask.ref}`));
assert.match(fires[10].text, /assigned it to you/);
assert.match(fires[10].text, /shortened; read it in full on the task/);
assert.equal((fires[10].text.match(/note \d+:/g) ?? []).length, 20, 'every comment kept, shortened');
assert.ok(fires[10].text.length <= 60_000, `payload ${fires[10].text.length} chars`);
console.log('✓ self-assigned work wakes the agent after its run; payload capped at', fires[10].text.length, 'chars');

// A run that never reaches Tasks (e.g. network allowlist) is released after 10 minutes, with a hint.
await db`update agent_runs set created_at = now() - interval '11 minutes' where finished_at is null and agent_id = ${rAgent.agent.id}`;
await api('POST', `/api/comments/${opsRoot.ref}`, { body: 'nudge the worker' });
let released: any;
for (let i = 0; i < 40 && !released?.finishedAt; i++) {
  await new Promise((r) => setTimeout(r, 100));
  released = (await api('GET', `/api/agents/${rAgent.agent.id}`)).runs.find((r: any) => r.itemRef === selfTask.ref);
}
assert.match(released.error, /hadn't reached Tasks after 10 minutes.*Network access/);
assert.equal((await api('GET', '/api/me', undefined, tokenOf(fires[10].text))).kind, 'agent', 'a late session keeps its token');
// An admin can end a stuck run by hand.
const stuck = await api('POST', `/api/projects/${org}/WEB/items`, { type: 'issue', title: 'Stuck one', status: 'Todo', assignee: rAgent.agent.id });
await waitFor(() => fires.length === 12, 'run to end by hand');
const stuckRun = (await api('GET', `/api/agents/${rAgent.agent.id}`)).runs.find((r: any) => r.itemRef === stuck.ref);
assert.deepEqual(await api('POST', `/api/agents/${rAgent.agent.id}/runs/${stuckRun.id}/end`, {}), { ended: true });
console.log('✓ runs that never reach Tasks are released with a hint; admins can end a run by hand');

// ---- Fixes from the pre-test review ----
const waitFire = (n: number, what: string) => waitFor(() => fires.length === n, what);
// Reviewer: step 1 doesn't send the task back; sending it back ends the reviewer's run right away.
await api('PATCH', `/api/orgs/${org}/members/${rAgent.agent.id}`, { skills: ['review'] });
const webCols = (await api('GET', `/api/projects/${org}/WEB`)).project.columns as string[];
await api('PATCH', `/api/projects/${org}/WEB`, { columns: webCols.map((c) => ({ name: c, from: c, handoff: c === 'Review' ? 'review' : null })) });
const byAlice = await api('POST', `/api/projects/${org}/WEB/items`, { type: 'task', parent: opsRoot.ref, title: 'Alice builds, agent reviews', status: 'In progress', assignee: `alice-${run}@example.com` });
await api('PATCH', `/api/items/${byAlice.ref}`, { status: 'Review' });
await waitFire(13, 'review run');
assert.match(fires[12].text, /you're reviewing someone else's work\. Don't move it/);
assert.doesNotMatch(fires[12].text, /1\. Move the task to "In progress" first/);
assert.match(fires[12].text, /\nReviewing: a task in "Review" assigned to you/);
await api('POST', `/api/comments/${byAlice.ref}`, { body: 'Please add tests.' }, tokenOf(fires[12].text));
await api('PATCH', `/api/items/${byAlice.ref}`, { status: 'In progress' }, tokenOf(fires[12].text));
assert.equal((await api('GET', `/api/items/${byAlice.ref}`)).item.assigneeName, 'Alice', 'back to its author');
const nextOne = await api('POST', `/api/projects/${org}/WEB/items`, { type: 'issue', title: 'Next after review', status: 'Todo', assignee: rAgent.agent.id });
await waitFire(14, 'reviewer free right after sending it back');
// Setting the status a task already has still ends the run.
await api('PATCH', `/api/items/${nextOne.ref}`, { status: 'Todo' }, tokenOf(fires[13].text));
// Queued wake-ups on an item closed meanwhile are skipped; comments still come through ("already done" wording).
const soonDone = await api('POST', `/api/projects/${org}/WEB/items`, { type: 'issue', title: 'Closed before it fires', status: 'Todo', assignee: rAgent.agent.id });
await api('PATCH', `/api/items/${soonDone.ref}`, { status: 'Done' });
await api('POST', `/api/comments/${soonDone.ref}`, { body: 'Actually, one more thing.' });
await waitFire(15, 'comment on a done item');
assert.match(fires[14].text, /This item is already done\. Read what changed/);
assert.doesNotMatch(fires[14].text, /assigned it to you/, 'the stale assignment was skipped');
await api('POST', '/api/runs/end', {}, tokenOf(fires[14].text));
// Removing the last blocker wakes the task.
const gate = await api('POST', `/api/projects/${org}/WEB/items`, { type: 'task', parent: opsRoot.ref, title: 'Gate', status: 'Todo', assignee: `alice-${run}@example.com` });
const gated = await api('POST', `/api/projects/${org}/WEB/items`, { type: 'task', parent: opsRoot.ref, title: 'Gated work', status: 'Todo' });
const gateLink = await api('POST', '/api/links', { from: gate.ref, to: gated.ref, kind: 'blocks' });
await api('PATCH', `/api/items/${gated.ref}`, { assignee: rAgent.agent.id });
await new Promise((r) => setTimeout(r, 1800));
assert.equal(fires.length, 15, 'blocked: no run');
const linkId = (await api('GET', `/api/items/${gated.ref}`)).links.find((l: any) => l.kind === 'blocks').id;
await api('DELETE', `/api/links/${linkId}`);
await waitFire(16, 'unlinking the last blocker wakes it');
assert.ok(gateLink);
// No reviewer but the author: the creator is told instead of the task being stranded in Review.
await api('PATCH', `/api/items/${gated.ref}`, { status: 'Review' }, tokenOf(fires[15].text));
assert.equal((await api('GET', `/api/items/${gated.ref}`)).item.assigneeName, rAgent.agent.name, 'stays with its author');
assert.ok((await api('GET', '/api/inbox?unread=1')).some((n: any) => n.reason === 'needs_reviewer' && n.itemRef === gated.ref));
// An agent connected after work was assigned picks it up.
const late = await api('POST', `/api/orgs/${org}/agents`, { name: `late-${run}` });
const lateItem = await api('POST', `/api/projects/${org}/WEB/items`, { type: 'issue', title: 'Waiting for its agent', status: 'Todo', assignee: late.agent.id });
await new Promise((r) => setTimeout(r, 1500));
const before = fires.length;
await api('PATCH', `/api/agents/${late.agent.id}`, { routineUrl: `http://localhost:4556/v1/claude_code/routines/trig_${run}/fire`, routineToken: 'sk-ant-oat01-test-token' });
await waitFor(() => fires.length === before + 1, 'connecting picks up waiting work');
assert.match(fires[before].text, new RegExp(`Task: ${lateItem.ref}`));
console.log('✓ review fixes: reviewer step, runs end on hand-back and same status, closed items skipped, unlink wakes, no-reviewer tells creator, connecting picks up work');

// Run tokens: expire shortly after the run ends, and never show up as the agent's keys.
assert.equal((await api('GET', `/api/agents/${rAgent.agent.id}`)).keys.length, 1);
fake.close();

// ---- Agents Tasks runs itself (fake OpenAI-compatible model that scripts tool calls) ----
const modelCalls: Record<string, number> = {};
const imagesSeen: number[] = [];
const mcpToolsSeen: string[][] = []; // per fake-qa request: how many screenshots it was shown
const llmServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const send = (code: number, obj: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.url === '/v1/models') return send(200, { data: ['fake-worker', 'fake-idle', 'fake-loop', 'fake-401', 'fake-dev', 'fake-qa', 'fake-pm', 'fake-broke', 'fake-mcp', 'fake-values', 'text-embedding-3-small'].map((id) => ({ id })) });
    const b = JSON.parse(body);
    modelCalls[b.model] = (modelCalls[b.model] ?? 0) + 1;
    const userText = b.messages.find((m: any) => m.role === 'user')?.content;
    const text = typeof userText === 'string' ? userText : (userText ?? []).map((p: any) => p.text).join('');
    const ref = /Task: (\S+)/.exec(text)?.[1];
    const toolsSoFar = b.messages.filter((m: any) => m.role === 'tool').length;
    const call = (name: string, args: unknown) => send(200, {
      id: 'x', object: 'chat.completion', created: 0, model: b.model,
      choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: `c${toolsSoFar}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    });
    const say = (content: string) => send(200, {
      id: 'x', object: 'chat.completion', created: 0, model: b.model,
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
      usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 },
    });
    if (b.model === 'fake-401') return send(401, { error: { message: 'Incorrect API key provided' } });
    if (b.model === 'fake-broke') return send(429, { error: { message: 'You exceeded your current quota, please check your plan and billing details.', type: 'insufficient_quota' } });
    if (b.model === 'fake-idle') return say('Nothing to do.');
    if (b.model === 'fake-loop') return call('get_item', { ref });
    if (b.model === 'fake-dev') {
      const branch = `task/${ref?.split('/')[1]}`;
      const steps: [string, unknown][] = [
        ['update_item', { ref, status: 'In progress' }],
        ['repo_write_files', { branch, message: 'Pong: first playable version', files: [{ path: 'index.html', content: '<canvas id=pong></canvas><script>/* pong */</script>' }] }],
        ['repo_open_pull_request', { branch, title: `${ref?.split('/')[1]}: basic Pong`, body: 'Two paddles, a ball, score to 11.' }],
        ['repo_merge_pull_request', { number: 1 }],
        ['repo_publish_pages', {}],
        ['comment', { ref, body: 'Merged and live at https://octo.github.io/pong/' }],
        ['update_item', { ref, status: 'Done' }],
      ];
      if (toolsSoFar < steps.length) return call(...steps[toolsSoFar]);
      return say('Shipped.');
    }
    if (b.model === 'fake-values') {
      if (toolsSoFar === 0) return call('set_project_value', { project: ref?.replace(/-\d+$/, ''), key: 'production_url', value: 'https://pong.example.com' });
      if (toolsSoFar === 1) return call('update_item', { ref, status: 'Done' });
      return say('saved');
    }
    if (b.model === 'fake-mcp') {
      mcpToolsSeen.push((b.tools ?? []).map((t: any) => t.function.name));
      const out = String(b.messages.filter((m: any) => m.role === 'tool')[0]?.content ?? '');
      const hasOps = (b.tools ?? []).some((t: any) => t.function.name === 'ops__add');
      if (toolsSoFar === 0 && hasOps) return call('ops__add', { a: 2, b: 3 });
      if (toolsSoFar <= 1) return call('comment', { ref, body: `ops said ${out}` });
      if (toolsSoFar === 2) return call('update_item', { ref, status: 'Done' });
      return say('ok');
    }
    if (b.model === 'fake-pm') {
      const steps: [string, unknown][] = [
        ['repo_list_files', {}],
        ['repo_write_files', { branch: 'dev', message: 'Spec', files: [{ path: `specs/${ref?.split('/')[1]}.md`, content: '# Pong spec' }] }],
        ['update_item', { ref, status: 'Done' }],
      ];
      if (toolsSoFar < steps.length) return call(...steps[toolsSoFar]);
      return say('Specced.');
    }
    if (b.model === 'fake-qa') {
      const images = b.messages.flatMap((m: any) => (Array.isArray(m.content) ? m.content : [])).filter((p: any) => p.type === 'image_url').length;
      imagesSeen.push(images);
      const toolOut = (i: number) => String(b.messages.filter((m: any) => m.role === 'tool')[i]?.content ?? '');
      const steps: [string, unknown][] = [
        ['browser_open', { url: 'http://localhost:4560/' }],
        ['browser_click', { target: /button \\"Start\\" \[ref=(e\d+)\]/.exec(toolOut(0))?.[1] ?? 'text=Start' }],
        ['browser_press', { key: 'ArrowUp', hold_ms: 100 }],
        ['browser_screenshot', {}],
        ['browser_console', {}],
        ['browser_eval', { expression: 'window.paddleMoves' }],
        ['browser_open', { url: 'http://169.254.169.254/latest/meta-data/' }],
        ['comment', { ref, body: `QA: clicked Start (${/Started/.test(toolOut(1)) ? 'started' : 'NOT started'}), saw ${imagesSeen.filter((n) => n > 0).length} screenshot(s), console ${/boom/.test(toolOut(4)) ? 'has boom' : 'clean'}, paddle moved ${JSON.parse(toolOut(5) || '{}').value}` }],
        ['update_item', { ref, status: 'Done' }],
      ];
      if (toolsSoFar < steps.length) return call(...steps[toolsSoFar]);
      return say('Tested.');
    }
    // fake-worker: start, comment, finish
    // Like OpenAI's strict tool schemas: every field sent, "" for the ones left alone.
    if (toolsSoFar === 0) return call('update_item', { ref, status: 'In progress', title: '', body: '', assignee: '', skill: '' });
    if (toolsSoFar === 1) return call('comment', { ref, body: 'Built the Pong page. Live at https://example.com/pong' });
    if (toolsSoFar === 2) return call('update_item', { ref, status: 'Done' });
    return say('Done.');
  });
});
await new Promise<void>((r) => llmServer.listen(4557, r));
await assert.rejects(api('POST', `/api/orgs/${org}/ai-providers`, { provider: 'openai-compatible', apiKey: 'sk-test-key', baseUrl: 'http://localhost:1/v1' }), /Couldn't reach the provider/);
const prov = await api('POST', `/api/orgs/${org}/ai-providers`, { provider: 'openai-compatible', apiKey: 'sk-test-key', baseUrl: 'http://localhost:4557/v1', label: 'Fake' });
assert.ok(prov.models.includes('fake-worker'));
assert.ok(!prov.models.includes('text-embedding-3-small'), 'models that can’t call tools are hidden');
await assert.rejects(api('PATCH', `/api/agents/${(await api('POST', `/api/orgs/${org}/agents`, { name: `emb-${run}` })).agent.id}`, { runtime: { providerId: prov.id, model: 'text-embedding-3-small' } }), /can’t call tools/);
assert.ok(!JSON.stringify(await api('GET', `/api/orgs/${org}/ai-providers`)).includes('sk-test-key'), 'keys are never returned');
const house = await api('POST', `/api/orgs/${org}/agents`, { name: `house-${run}` });
await api('PATCH', `/api/agents/${house.agent.id}`, { runtime: { providerId: prov.id, model: 'fake-worker' } });
const houseView = await api('GET', `/api/agents/${house.agent.id}`);
assert.equal(houseView.agent.runtime.model, 'fake-worker');
const pong = await api('POST', `/api/projects/${org}/WEB/items`, { type: 'issue', title: 'Basic Pong with a URL', status: 'Todo', assignee: house.agent.id });
let pongNow: any;
for (let i = 0; i < 60 && !pongNow?.item.done; i++) { await new Promise((r) => setTimeout(r, 100)); pongNow = await api('GET', `/api/items/${pong.ref}`); }
assert.equal(pongNow.item.status, 'Done', 'the in-house agent did the work');
assert.equal(pongNow.comments.at(-1).authorName, `house-${run}`);
const houseRun = (await api('GET', `/api/agents/${house.agent.id}`)).runs.find((r: any) => r.itemRef === pong.ref);
const pongAfter = (await api('GET', `/api/items/${pong.ref}`)).item;
assert.equal(pongAfter.assigneeName, house.agent.name, 'empty fields from the model change nothing');
assert.ok(pongAfter.title.length > 0);
assert.equal(houseRun.runtime, 'builtin');
assert.ok(houseRun.finishedAt && !houseRun.error, 'finished cleanly');
assert.ok(houseRun.inputTokens >= 300 && houseRun.steps >= 3, `tokens ${houseRun.inputTokens}, steps ${houseRun.steps}`);
const transcript = await api('GET', `/api/runs/${houseRun.id}`);
const prompt = transcript.steps.find((s: any) => s.kind === 'prompt').content.text;
assert.match(prompt, /update_item \{"ref":"[^"]+","status":"In progress"\}/, 'tool wording, not curl');
assert.doesNotMatch(prompt, /export TASKS=|TASKS_TOKEN/);
assert.deepEqual(transcript.steps.filter((s: any) => s.kind === 'tool_call').map((s: any) => s.content.tool), ['update_item', 'comment', 'update_item']);
// A model that stops without acting: the run ends quietly.
await api('PATCH', `/api/agents/${house.agent.id}`, { runtime: { providerId: prov.id, model: 'fake-idle' } });
const idle = await api('POST', `/api/projects/${org}/WEB/items`, { type: 'issue', title: 'Nothing to do here', status: 'Todo', assignee: house.agent.id });
const runFor = async (ref: string) => {
  for (let i = 0; i < 250; i++) {
    const r = (await api('GET', `/api/agents/${house.agent.id}`)).runs.find((x: any) => x.itemRef === ref);
    if (r?.finishedAt) return r;
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error(`no finished run for ${ref}`);
};
assert.equal((await runFor(idle.ref)).error, null);
// A model that loops stops at the step limit; a rejected key fails without retrying.
await api('PATCH', `/api/agents/${house.agent.id}`, { runtime: { providerId: prov.id, model: 'fake-loop', maxSteps: 3 } });
const loopy = await api('POST', `/api/projects/${org}/WEB/items`, { type: 'issue', title: 'Loops forever', status: 'Todo', assignee: house.agent.id });
assert.match((await runFor(loopy.ref)).error, /limit of 3 steps/);
await api('PATCH', `/api/agents/${house.agent.id}`, { runtime: { providerId: prov.id, model: 'fake-401' } });
const refused = await api('POST', `/api/projects/${org}/WEB/items`, { type: 'issue', title: 'Bad key', status: 'Todo', assignee: house.agent.id });
assert.match((await runFor(refused.ref)).error, /model call failed.*Incorrect API key/);
// ---- GitHub: install (verified), project repository, per-run repo access, webhooks ----
const repoFiles: Record<string, Record<string, string>> = { main: { 'README.md': '# pong' } };
const repos: Record<string, Record<string, Record<string, string>>> = { pong: repoFiles, fresh: {} }; // fresh: a brand-new empty repo
const ghCalls: string[] = [];
let tokenRequests: any[] = [];
const ghServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const send = (code: number, obj: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const url = new URL(req.url!, 'http://x');
    const p = url.pathname;
    const b = body ? JSON.parse(body) : {};
    ghCalls.push(`${req.method} ${p}`);
    if (req.method === 'POST' && /^\/app\/installations\/777\/access_tokens$/.test(p)) { tokenRequests.push(b); return send(201, { token: `ghs_run${tokenRequests.length}`, expires_at: new Date(Date.now() + 3600_000).toISOString() }); }
    if (p === '/installation/repositories') {
      // 150 repositories, 100 per page: the ones the tests use are on page 2.
      const all = [...Array.from({ length: 148 }, (_, i) => ({ full_name: `octo/filler-${String(i).padStart(3, '0')}` })), { full_name: 'octo/pong' }, { full_name: 'octo/fresh' }];
      const page = Number(url.searchParams.get('page') ?? 1);
      return send(200, { total_count: all.length, repositories: all.slice((page - 1) * 100, page * 100) });
    }
    if (p === '/login/oauth/access_token') return send(200, b.code === 'good' ? { access_token: 'gho_user' } : b.code === 'multi' ? { access_token: 'gho_multi' } : { error: 'bad_verification_code' });
    if (p === '/user/installations') {
      const octo = { id: 777, account: { login: 'octo', type: 'User' } };
      return send(200, { installations: req.headers.authorization === 'Bearer gho_multi' ? [octo, { id: 888, account: { login: 'octo-org', type: 'Organization' } }] : [octo] });
    }
    const m = /^\/repos\/octo\/(pong|fresh)(\/.*)?$/.exec(p);
    if (!m) return send(404, { message: 'Not Found' });
    const files = repos[m[1]];
    const rest = m[2] ?? '';
    const empty = !Object.keys(files).length;
    if (rest === '') return send(200, { default_branch: 'main' });
    if (empty && rest.startsWith('/git/')) return send(409, { message: 'Git Repository is empty.' });
    let r: RegExpExecArray | null;
    if ((r = /^\/git\/ref\/heads\/(.+)$/.exec(rest))) return files[decodeURIComponent(r[1])] ? send(200, { object: { sha: `sha-${r[1]}` } }) : send(404, { message: 'Not Found' });
    if (rest === '/git/refs' && req.method === 'POST') { files[b.ref.replace('refs/heads/', '')] = { ...files.main }; return send(201, {}); }
    if ((r = /^\/git\/trees\/(.+)$/.exec(rest))) return send(200, { tree: Object.keys(files[decodeURIComponent(r[1])] ?? {}).map((path) => ({ type: 'blob', path })) });
    if ((r = /^\/contents\/(.+)$/.exec(rest))) {
      const path = decodeURIComponent(r[1]);
      if (req.method === 'GET') {
        const f = files[url.searchParams.get('ref') ?? 'main']?.[path];
        return f === undefined ? send(404, { message: 'Not Found' }) : send(200, { content: Buffer.from(f).toString('base64'), sha: 'filesha' });
      }
      const branch = b.branch ?? 'main';
      if (!files[branch] && empty && branch === 'main') files.main = {};
      files[branch][path] = Buffer.from(b.content, 'base64').toString('utf8');
      return send(200, { commit: { sha: 'c1' } });
    }
    if (rest === '/pulls' && req.method === 'POST') { (files as any).__pr = b.head; return send(201, { number: 1, html_url: 'https://github.com/octo/pong/pull/1' }); }
    if (rest === '/pulls/1/merge') { Object.assign(files.main, files[(files as any).__pr]); return send(200, { merged: true }); }
    if (rest === '/pages' && req.method === 'POST') return send(201, {});
    if (rest === '/pages') return send(200, { html_url: 'https://octo.github.io/pong/', status: 'built' });
    return send(404, { message: 'Not Found' });
  });
});
await new Promise<void>((r) => ghServer.listen(4559, r));
assert.deepEqual(await api('GET', `/api/orgs/${org}/github`), { configured: true, connected: false });
const installStart = await fetch(`${BASE}/api/orgs/${org}/github/install`, { headers: { cookie }, redirect: 'manual' });
assert.equal(installStart.status, 302);
assert.match(installStart.headers.get('location')!, /\/apps\/tasks-test\/installations\/new\?state=\w+$/);
const installCookie = /gh_install=[^;]+/.exec(installStart.headers.get('set-cookie')!)![0];
const callback = (qs: string, c = `${cookie}; ${installCookie}`) => fetch(`${BASE}/api/github/callback?${qs}`, { headers: { cookie: c }, redirect: 'manual' }).then((r) => r.headers.get('location')!);
assert.match(await callback('code=good&installation_id=999&setup_action=install'), /github_error=.*isn%E2%80%99t%20one%20your%20GitHub%20account/, 'someone else’s installation id is refused');
assert.match(await callback('code=good&installation_id=777', cookie), /github_error=.*expired%20or%20was%20started/, 'no install cookie, no link');
assert.equal(await callback('code=good&installation_id=777&setup_action=install'), `/app/${org}/settings?tab=github`);
// A second Tasks org uses the same installation (an account installs an app once): sign in and pick it.
const org2 = `gh2-${run}`;
await api('POST', '/api/orgs', { slug: org2, name: 'GH2', starterAgents: false });
const existingStart = await fetch(`${BASE}/api/orgs/${org2}/github/install?existing=1`, { headers: { cookie }, redirect: 'manual' });
assert.match(existingStart.headers.get('location')!, /\/login\/oauth\/authorize\?client_id=.*&state=(\w+)$/);
const existingState = /state=(\w+)$/.exec(existingStart.headers.get('location')!)![1];
const existingCookie = /gh_install=[^;]+/.exec(existingStart.headers.get('set-cookie')!)![0];
assert.match(await callback(`code=multi&state=wrong`, `${cookie}; ${existingCookie}`), /github_error=.*expired/, 'state must match');
const picked = await callback(`code=multi&state=${existingState}`, `${cookie}; ${existingCookie}`);
const choices = JSON.parse(Buffer.from(/gh_pick=([\w-]+)/.exec(picked)![1], 'base64url').toString());
assert.deepEqual(choices.map((c: any) => c.login), ['octo', 'octo-org']);
const forged = choices[1].link.replace('inst=888', 'inst=999');
const follow = (link: string) => fetch(`${BASE}${link}`, { headers: { cookie }, redirect: 'manual' }).then((r) => r.headers.get('location')!);
assert.match(await follow(forged), /github_error=.*expired/, 'a pick link can’t be edited');
assert.equal(await follow(choices[0].link), `/app/${org2}/settings?tab=github`);
assert.equal((await api('GET', `/api/orgs/${org2}/github`)).account, 'octo');
const ghState = await api('GET', `/api/orgs/${org}/github`);
assert.equal(ghState.account, 'octo');
assert.equal(ghState.repos.length, 150, 'all pages of repositories');
assert.ok(ghState.repos.includes('octo/pong') && ghState.repos.includes('octo/fresh'));
await assert.rejects(api('PATCH', `/api/projects/${org}/WEB/github`, { repo: 'octo/secret' }), /can’t access octo\/secret/);
await api('PATCH', `/api/projects/${org}/WEB/github`, { repo: 'octo/pong' });
// In-house developer: builds on a branch, opens a PR, merges it, publishes Pages, comments the URL.
await api('PATCH', `/api/agents/${house.agent.id}`, { runtime: { providerId: prov.id, model: 'fake-dev', maxSteps: 20 } });
tokenRequests = [];
const pongGh = await api('POST', `/api/projects/${org}/WEB/items`, { type: 'issue', title: 'Pong on GitHub Pages', status: 'Todo', assignee: house.agent.id });
const devRun = await runFor(pongGh.ref);
assert.equal(devRun.error, null);
const pongGhNow = await api('GET', `/api/items/${pongGh.ref}`);
assert.equal(pongGhNow.item.status, 'Done');
assert.match(pongGhNow.comments.at(-1).body, /octo\.github\.io\/pong/);
assert.match(repoFiles.main['index.html'], /pong/, 'merged into main');
assert.deepEqual(tokenRequests[0]?.repositories, ['pong'], 'run token limited to the project repo');
const devPrompt = (await api('GET', `/api/runs/${devRun.id}`)).steps.find((s: any) => s.kind === 'prompt').content.text;
assert.match(devPrompt, /Repository: https:\/\/github\.com\/octo\/pong\. Branch: main \(production; work lands on it directly/);
await api('PATCH', `/api/projects/${org}/WEB/github`, { repo: 'octo/pong', base: 'dev', prod: 'main' });
const projRepo = (await api('GET', `/api/projects/${org}/WEB`)).project;
assert.deepEqual([projRepo.githubBase, projRepo.githubProd], ['dev', 'main']);
// A brand-new empty repository: the PM's first commit (a spec on dev) creates main, then dev from it.
await api('PATCH', `/api/projects/${org}/WEB/github`, { repo: 'octo/fresh', base: 'dev', prod: 'main' });
await api('PATCH', `/api/agents/${house.agent.id}`, { runtime: { providerId: prov.id, model: 'fake-pm', maxSteps: 10 } });
const specItem = await api('POST', `/api/projects/${org}/WEB/items`, { type: 'issue', title: 'Pong from nothing', status: 'Todo', assignee: house.agent.id });
const specRun = await runFor(specItem.ref);
assert.equal(specRun.error, null);
const specSteps = (await api('GET', `/api/runs/${specRun.id}`)).steps.filter((s: any) => s.kind === 'tool_result');
assert.match(specSteps[0].content.output, /doesn't exist yet/);
assert.doesNotMatch(specSteps[1].content.output, /error/);
assert.deepEqual(Object.keys(repos.fresh).sort(), ['dev', 'main']);
assert.ok(repos.fresh.main['README.md'] && repos.fresh.dev[`specs/${specItem.ref.split('/')[1]}.md`]);
assert.equal((await api('GET', `/api/items/${specItem.ref}`)).item.status, 'Done');
await api('PATCH', `/api/projects/${org}/WEB/github`, { repo: 'octo/pong', base: 'main', prod: 'main' });
assert.match(devPrompt, /repo_write_files/);
// Webhooks: PRs and commits that mention an item land in its history; bad signatures are refused.
const ghHook = async (event: string, payload: unknown, secret = 'test-webhook-secret') => {
  const raw = JSON.stringify(payload);
  const sig = 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex');
  return fetch(`${BASE}/api/github/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-github-event': event, 'x-hub-signature-256': sig }, body: raw });
};
const itemNo = pongGh.ref.split('-').pop();
assert.equal((await ghHook('pull_request', {}, 'wrong')).status, 401);
const prHook = await (await ghHook('pull_request', {
  action: 'closed', installation: { id: 777 }, repository: { full_name: 'octo/pong' },
  pull_request: { number: 1, merged: true, title: `WEB-${itemNo}: basic Pong`, html_url: 'https://github.com/octo/pong/pull/1', user: { login: 'octo' }, head: { ref: 'x' } },
})).json();
assert.ok(prHook.recorded >= 1);
await ghHook('push', { ref: 'refs/heads/main', installation: { id: 777 }, repository: { full_name: 'octo/pong' }, commits: [{ id: 'abcdef1234', message: `Fix paddle speed (WEB-${itemNo})`, url: 'u', author: { username: 'octo' } }] });
const ghHistory = (await api('GET', `/api/items/${pongGh.ref}`)).history.map((e: any) => e.type);
assert.ok(ghHistory.includes('github.pull_request') && ghHistory.includes('github.commit'));
ghServer.close();
console.log('✓ GitHub: verified install, project repo, repo-scoped run token, in-house agent ships via PR + Pages, webhooks in history');

// ---- The agent browser: a QA agent tests a page, sees a screenshot, reads the console ----
const site = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<title>Pong</title><h1>Pong</h1><button onclick="document.querySelector('p').textContent='Started';console.error('boom')">Start</button><p>Idle</p>
<canvas width=300 height=150></canvas><script>window.paddleMoves=0;addEventListener('keydown',e=>{if(e.key==='ArrowUp')window.paddleMoves++})</script>`);
});
await new Promise<void>((r) => site.listen(4560, r));
await api('PATCH', `/api/agents/${house.agent.id}`, { runtime: { providerId: prov.id, model: 'fake-qa', maxSteps: 20 } });
const qaItem = await api('POST', `/api/projects/${org}/WEB/items`, { type: 'issue', title: 'Test Pong in the browser', status: 'Todo', assignee: house.agent.id });
const qaRun = await runFor(qaItem.ref);
assert.equal(qaRun.error, null);
const qaSteps = (await api('GET', `/api/runs/${qaRun.id}`)).steps;
const qaResult = (tool: string) => qaSteps.filter((s: any) => s.kind === 'tool_result' && s.content.tool === tool);
assert.match(qaResult('browser_open')[0].content.output, /button \\"Start\\" \[ref=e\d+\]/, 'pages come back as an accessibility snapshot with refs');
assert.ok(qaResult('browser_screenshot')[0].content.image.length > 1000, 'the transcript keeps the screenshot');
assert.match(qaResult('browser_open')[1].content.output, /private address/, 'the browser can’t reach private addresses');
const qaComment = (await api('GET', `/api/items/${qaItem.ref}`)).comments.at(-1).body;
assert.match(qaComment, /clicked Start \(started\), saw 1 screenshot\(s\), console has boom, paddle moved 1/);
assert.equal(Math.max(...imagesSeen), 1, 'only the latest screenshot is ever shown');
assert.equal(imagesSeen.filter((n) => n > 0).length, 1, 'a screenshot is shown once, in the next step');
assert.match((await api('GET', `/api/runs/${qaRun.id}`)).steps.find((s: any) => s.kind === 'prompt').content.text, /browser_\* tools are a real browser/);
site.close();
console.log('✓ agent browser: accessibility snapshot with refs, click, keys, screenshot shown once, console, eval, private addresses refused');

// ---- Out of credits: no retries; a human gets one top-up task that blocks the work, and finishing it resumes ----
await api('PATCH', `/api/agents/${house.agent.id}`, { runtime: { providerId: prov.id, model: 'fake-broke' } });
const broke1 = await api('POST', `/api/projects/${org}/WEB/items`, { type: 'issue', title: 'Needs credits 1', status: 'Todo', assignee: house.agent.id });
assert.match((await runFor(broke1.ref)).error, /out of credits.*waiting on/);
const broke2 = await api('POST', `/api/projects/${org}/WEB/items`, { type: 'issue', title: 'Needs credits 2', status: 'Todo', assignee: house.agent.id });
assert.match((await runFor(broke2.ref)).error, /out of credits/);
const topUps = (await api('GET', `/api/search?q=${encodeURIComponent('Top up credits for Fake')}`)).filter((i: any) => !i.done);
assert.equal(topUps.length, 1, 'one top-up task, however many runs hit it');
const topUp = await api('GET', `/api/items/${topUps[0].ref}`);
assert.equal(topUp.item.assigneeKind, 'human');
const blocked = (await api('GET', `/api/items/${broke2.ref}`)).item;
assert.ok(blocked.blockedBy?.length || (await api('GET', `/api/items/${broke2.ref}`)).links.some((l: any) => l.kind === 'blocks'), 'the top-up task blocks the work');
await api('PATCH', `/api/agents/${house.agent.id}`, { runtime: { providerId: prov.id, model: 'fake-idle' } });
const runsBefore = (await api('GET', `/api/agents/${house.agent.id}`)).runs.length;
await api('PATCH', `/api/items/${topUps[0].ref}`, { status: 'Done' });
for (let i = 0; i < 80 && (await api('GET', `/api/agents/${house.agent.id}`)).runs.filter((r: any) => r.finishedAt).length < runsBefore + 2; i++) await new Promise((r) => setTimeout(r, 100));
assert.ok((await api('GET', `/api/agents/${house.agent.id}`)).runs.length >= runsBefore + 2, 'topping up wakes the agent on both items');
console.log('✓ out of credits: no retries, one top-up task for a human that blocks the work, done → agents resume');

// ---- MCP connectors: org, project and agent level; allowed tools; header auth ----
const mcpHttp = http.createServer(async (req, res) => {
  if (req.url === '/secure' && req.headers.authorization !== 'Bearer ops-key') {
    res.writeHead(401, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: 'missing bearer token' }));
  }
  if (req.method !== 'POST') return res.writeHead(405).end();
  let raw = '';
  for await (const c of req) raw += c;
  const server = new McpServer({ name: 'ops', version: '1.0.0' });
  server.registerTool('add', { description: 'Add two numbers', inputSchema: { a: z.number(), b: z.number() } }, async ({ a, b }: any) => ({ content: [{ type: 'text', text: String(a + b) }] }));
  server.registerTool('echo', { description: 'Echo text', inputSchema: { text: z.string() } }, async ({ text }: any) => ({ content: [{ type: 'text', text }] }));
  server.registerTool('danger', { description: 'Delete everything', inputSchema: {} }, async () => ({ content: [{ type: 'text', text: 'deleted' }] }));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => { transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, JSON.parse(raw));
});
await new Promise<void>((r) => mcpHttp.listen(4563, r));
await assert.rejects(api('POST', `/api/orgs/${org}/connectors`, { name: 'Bad Name', url: 'http://localhost:4563/secure', auth: 'none' }), /lowercase/);
const opsConn = await api('POST', `/api/orgs/${org}/connectors`, { name: 'ops', url: 'http://localhost:4563/secure', auth: 'header', headerValue: 'Bearer wrong' });
await assert.rejects(api('POST', `/api/connectors/${opsConn.id}/test`), /Couldn’t connect/);
await api('PATCH', `/api/connectors/${opsConn.id}`, { headerValue: 'Bearer ops-key' });
assert.deepEqual((await api('POST', `/api/connectors/${opsConn.id}/test`)).map((t: any) => t.name).sort(), ['add', 'danger', 'echo']);
await api('PATCH', `/api/connectors/${opsConn.id}`, { allowedTools: ['add', 'echo'] });
assert.deepEqual((await api('POST', `/api/connectors/${opsConn.id}/test`)).filter((t: any) => t.allowed).map((t: any) => t.name).sort(), ['add', 'echo']);
await assert.rejects(api('POST', `/api/orgs/${org}/connectors`, { name: 'ops', url: 'http://localhost:4563/open', auth: 'none' }), /already exists/);
await api('POST', `/api/projects/${org}/WEB/connectors`, { name: 'proj', url: 'http://localhost:4563/open', auth: 'none', allowedTools: ['echo'] });
await api('POST', `/api/agents/${house.agent.id}/connectors`, { name: 'mine', url: 'http://localhost:4563/open', auth: 'none', allowedTools: ['echo'] });
await api('POST', `/api/orgs/${org}/connectors`, { name: 'broken', url: 'http://localhost:4599/mcp', auth: 'none' });
let houseConn = await api('GET', `/api/agents/${house.agent.id}/connectors`);
assert.deepEqual([houseConn.connectors.map((c: any) => c.name), houseConn.available.map((c: any) => `${c.name}:${c.enabled}`)], [['mine'], ['broken:false', 'ops:false', 'proj:false']]);
assert.equal(houseConn.available[1].hasHeaderValue, true);
// Org and project connectors are opt-in per agent.
for (const c of houseConn.available) await api('PUT', `/api/agents/${house.agent.id}/connectors/${c.id}`, { enabled: true });
houseConn = await api('GET', `/api/agents/${house.agent.id}/connectors`);
assert.ok(houseConn.available.every((c: any) => c.enabled));
assert.ok(!JSON.stringify(houseConn).includes('ops-key'), 'header values are never returned');
const keyed = await api('POST', `/api/orgs/${org}/connectors`, { name: 'keyed', url: 'http://localhost:4563/open?key=secret123&x=1', auth: 'none' });
assert.equal(keyed.url, 'http://localhost:4563/open?key=•••&x=•••', 'query-string keys are masked');
await api('DELETE', `/api/connectors/${keyed.id}`);
await api('PATCH', `/api/agents/${house.agent.id}`, { runtime: { providerId: prov.id, model: 'fake-mcp' } });
const mcpItem = await api('POST', `/api/projects/${org}/WEB/items`, { type: 'issue', title: 'Use the ops connector', status: 'Todo', assignee: house.agent.id });
const mcpRun = await runFor(mcpItem.ref);
assert.equal(mcpRun.error, null);
const mcpSeen = mcpToolsSeen[0];
assert.ok(['ops__add', 'ops__echo', 'proj__echo', 'mine__echo'].every((t) => mcpSeen.includes(t)), `org, project and agent tools: ${mcpSeen.filter((t) => t.includes('__'))}`);
assert.ok(!mcpSeen.includes('ops__danger') && !mcpSeen.includes('proj__add'), 'only allowed tools');
assert.match((await api('GET', `/api/items/${mcpItem.ref}`)).comments.at(-1).body, /ops said 5/);
const mcpSteps = (await api('GET', `/api/runs/${mcpRun.id}`)).steps;
assert.match(mcpSteps.find((s: any) => s.kind === 'prompt').content.text, /ops__\*/);
assert.match(mcpSteps.find((s: any) => s.kind === 'prompt').content.text, /Connector "broken" is unavailable/);
// Another project: its items don't get WEB's connector.
const apiItem = await api('POST', `/api/projects/${org}/API/items`, { type: 'issue', title: 'Elsewhere', status: 'Todo', assignee: house.agent.id });
mcpToolsSeen.length = 0;
await runFor(apiItem.ref);
assert.ok(mcpToolsSeen[0].includes('ops__add') && mcpToolsSeen[0].includes('mine__echo') && !mcpToolsSeen[0].includes('proj__echo'));
// Switched off: gone from the next run.
await api('PUT', `/api/agents/${house.agent.id}/connectors/${opsConn.id}`, { enabled: false });
const offItem = await api('POST', `/api/projects/${org}/WEB/items`, { type: 'issue', title: 'Without ops', status: 'Todo', assignee: house.agent.id });
mcpToolsSeen.length = 0;
await runFor(offItem.ref);
assert.ok(!mcpToolsSeen[0].includes('ops__add') && mcpToolsSeen[0].includes('proj__echo') && mcpToolsSeen[0].includes('mine__echo'));
mcpHttp.close();
console.log('✓ MCP connectors: org + project (switched on per agent) + agent level, allowed tools only, header auth, secrets hidden, unavailable ones noted');

// ---- Project values: shared notes anyone reads and writes; every run gets them ----
await assert.rejects(api('PUT', `/api/projects/${org}/WEB/values/bad key`, { value: 'x' }), /Keys:/);
await api('PUT', `/api/projects/${org}/WEB/values/staging_url`, { value: 'https://pong-dev.example.com' });
await api('PUT', `/api/projects/${org}/WEB/values/staging_url`, { value: 'https://pong-staging.example.com' });
await api('PUT', `/api/projects/${org}/WEB/values/scratch`, { value: 'temp' });
await api('DELETE', `/api/projects/${org}/WEB/values/scratch`);
assert.deepEqual((await api('GET', `/api/projects/${org}/WEB/values`)).map((v: any) => `${v.key}=${v.value}`), ['staging_url=https://pong-staging.example.com']);
const valueEvents = (await api('GET', `/api/projects/${org}/WEB/timeline`)).filter((e: any) => e.type.startsWith('project.value'));
assert.ok(valueEvents.length >= 4, 'value changes are in the timeline');
await api('PATCH', `/api/agents/${house.agent.id}`, { runtime: { providerId: prov.id, model: 'fake-values' } });
const valItem = await api('POST', `/api/projects/${org}/WEB/items`, { type: 'issue', title: 'Record the production URL', status: 'Todo', assignee: house.agent.id });
const valRun = await runFor(valItem.ref);
assert.equal(valRun.error, null);
const valPrompt = (await api('GET', `/api/runs/${valRun.id}`)).steps.find((s: any) => s.kind === 'prompt').content.text;
assert.match(valPrompt, /- staging_url = https:\/\/pong-staging\.example\.com/);
assert.equal((await api('GET', `/api/projects/${org}/WEB/values`)).find((v: any) => v.key === 'production_url')?.value, 'https://pong.example.com', 'agents save values with a tool');
console.log('✓ project values: anyone sets and deletes, timeline, every run sees them, agents save them');

// Switching to a routine turns the in-house runtime off.
await api('PATCH', `/api/agents/${house.agent.id}`, { routineUrl: `http://localhost:4556/v1/claude_code/routines/trig_${run}/fire`, routineToken: 'sk-ant-oat01-test-token' });
assert.equal((await api('GET', `/api/agents/${house.agent.id}`)).agent.runtime, null);
llmServer.close();
console.log('✓ in-house agents: provider test, tool-driven run to Done, transcript and tokens, quiet stop, step limit, rejected key, one runtime at a time');

// ---- Recurring items ----
const aliceEmail = `alice-${run}@example.com`;
const scheduleIn = { name: 'Daily Pi check', cron: '0 9 * * *', timezone: 'Europe/Bucharest', title: 'Pi check {date}', body: 'Run on {weekday}.', status: 'Todo', assignee: aliceEmail };
await assert.rejects(api('POST', `/api/projects/${org}/WEB/schedules`, { ...scheduleIn, cron: '0 25 * * *' }), /Invalid schedule/);
await assert.rejects(api('POST', `/api/projects/${org}/WEB/schedules`, { ...scheduleIn, timezone: 'Mars/Base' }), /Unknown timezone/);
await assert.rejects(api('POST', `/api/projects/${org}/WEB/schedules`, { ...scheduleIn, status: 'Nope' }), /Unknown column/);
const daily = await api('POST', `/api/projects/${org}/WEB/schedules`, scheduleIn);
const next = new Date(daily.nextRunAt);
assert.equal(new Intl.DateTimeFormat('en', { timeZone: 'Europe/Bucharest', hour: 'numeric', minute: '2-digit', hourCycle: 'h23' }).format(next), '09:00');
assert.ok(next.getTime() > Date.now() && next.getTime() - Date.now() <= 86_400_000);
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Bucharest' }).format(new Date());
const ran = await api('POST', `/api/schedules/${daily.id}/run`);
const made = await api('GET', `/api/items/${ran.ref}`);
assert.equal(made.item.title, `Pi check ${today}`);
assert.match(made.item.body, /^Run on \w+day\.$/);
assert.equal(made.item.status, 'Todo');
assert.equal(made.item.assigneeName, 'Alice');
assert.equal(made.history.find((e: any) => e.type === 'item.created').data.schedule, 'Daily Pi check');
await api('PATCH', `/api/schedules/${daily.id}`, { ...scheduleIn, skipIfOpen: true });
assert.equal((await api('POST', `/api/schedules/${daily.id}/run`)).skipped, true, 'previous one still open');
// Downtime: the 9:00 run was missed hours ago. It runs once to catch up, then waits for the next 9:00.
await api('PATCH', `/api/schedules/${daily.id}`, { ...scheduleIn, skipIfOpen: false });
await db`update schedules set next_run_at = now() - interval '5 hours' where id = ${daily.id}`;
const nudge = await api('POST', `/api/projects/${org}/WEB/schedules`, { ...scheduleIn, name: 'nudge', enabled: false }); // saving wakes the scheduler
const countChecks = async () => (await api('GET', `/api/projects/${org}/WEB`)).items.filter((i: any) => i.title === `Pi check ${today}`).length;
for (let i = 0; i < 30 && (await countChecks()) < 2; i++) await new Promise((r) => setTimeout(r, 100));
await new Promise((r) => setTimeout(r, 500));
assert.equal(await countChecks(), 2, 'caught up exactly once');
const after = (await api('GET', `/api/projects/${org}/WEB/schedules`)).find((x: any) => x.id === daily.id);
assert.ok(new Date(after.nextRunAt).getTime() > Date.now(), 'next run is in the future again');
await api('DELETE', `/api/schedules/${nudge.id}`);
console.log('✓ recurring items: validation, 9:00 in its timezone, run now, {date}, skip-if-open, one catch-up after downtime');

// ---- Skills: routing by skill and column default, load spread, waiting, rerouting, done → creator ----
const mk = async (name: string, skills: string[]) => {
  const a = await api('POST', `/api/orgs/${org}/agents`, { name: `${name}-${run}` });
  await api('PATCH', `/api/orgs/${org}/members/${a.agent.id}`, { skills });
  return a;
};
const pm = await mk('pm', ['Product']);
const be1 = await mk('be1', ['backend']);
const be2 = await mk('be2', ['backend']);
const pipe = await api('POST', `/api/orgs/${org}/projects`, { name: 'Pipeline', key: 'PIPE' });
await api('PATCH', `/api/projects/${org}/PIPE`, {
  columns: pipe.columns.map((c: string) => ({ name: c, from: c, skill: c === 'Todo' ? 'product' : null })),
});
assert.deepEqual((await api('GET', `/api/orgs/${org}`)).members.find((m: any) => m.id === pm.agent.id).skills, ['product'], 'skills are normalized');
const feature = await api('POST', `/api/projects/${org}/PIPE/items`, { type: 'issue', title: 'Saved searches', status: 'Todo' });
assert.equal(feature.assigneeName, `pm-${run}`, 'unassigned item in Todo goes to the product owner');
const fHist = (await api('GET', `/api/items/${feature.ref}`)).history;
assert.ok(fHist.some((e: any) => e.data.routedBy === 'product'));
// The PM plans by skill; backend work spreads over both backend agents; db work waits for someone with db.
const t1 = await mcp(pm.key.key, 'create_task', { issue: feature.ref, title: 'Backend API', skill: 'backend', status: 'Todo' });
const t2 = await mcp(pm.key.key, 'create_task', { issue: feature.ref, title: 'Email job', skill: 'backend', status: 'Todo' });
assert.deepEqual([t1.assigneeName, t2.assigneeName].sort(), [`be1-${run}`, `be2-${run}`], 'least busy first');
const t3 = await mcp(pm.key.key, 'create_task', { issue: feature.ref, title: 'Schema', skill: 'db', status: 'Todo' });
assert.equal(t3.assigneeName, null, 'nobody has db yet');
await mcp(pm.key.key, 'link_items', { from: t3.ref, to: t1.ref, kind: 'blocks' });
const plan = (await api('GET', `/api/items/${feature.ref}`)).tasks;
assert.deepEqual(plan.find((t: any) => t.ref === t1.ref).blockedBy, [t3.ref]);
assert.equal(plan.find((t: any) => t.ref === t3.ref).skill, 'db');
await api('PATCH', `/api/orgs/${org}/members/${be1.agent.id}`, { skills: ['backend', 'db'] });
assert.equal((await api('GET', `/api/items/${t3.ref}`)).item.assigneeName, `be1-${run}`, 'waiting work is routed when someone gains the skill');
// An explicit unassign sticks; a column move with no skill falls back to the column default.
await api('PATCH', `/api/items/${t2.ref}`, { assignee: null });
assert.equal((await api('GET', `/api/items/${t2.ref}`)).item.assigneeId, null);
// Deleting an agent hands its open work to another member with the skill.
const t2owner = t2.assigneeName === `be1-${run}` ? be1 : be2;
const otherBe = t2owner === be1 ? be2 : be1;
const t1owner = t1.assigneeName === `be1-${run}` ? be1 : be2;
if (t1owner !== otherBe) {
  await api('DELETE', `/api/agents/${t1owner.agent.id}`);
  assert.equal((await api('GET', `/api/items/${t1.ref}`)).item.assigneeName, otherBe.agent.name, 'rerouted on delete');
}
// Roles: owners change them; agents stay members; the last owner stays.
await assert.rejects(api('PATCH', `/api/orgs/${org}/members/${pm.agent.id}`, { role: 'admin' }), /Agents are always members/);
const ownerId = (await api('GET', `/api/orgs/${org}`)).members.find((m: any) => m.role === 'owner').id;
await assert.rejects(api('PATCH', `/api/orgs/${org}/members/${ownerId}`, { role: 'member' }), /at least one owner/);
// Code review hand-off: Review hands tasks to a reviewer who isn't the author; sent back, they return.
const rv = await mk('rv', ['review']);
await api('PATCH', `/api/orgs/${org}/members/${otherBe.agent.id}`, { skills: ['backend', 'review'] }); // an author who also reviews
await api('PATCH', `/api/projects/${org}/PIPE`, {
  columns: pipe.columns.map((c: string) => ({ name: c, from: c, skill: c === 'Todo' ? 'product' : null, handoff: c === 'Review' ? 'review' : null })),
});
const t4 = await api('POST', `/api/projects/${org}/PIPE/items`, { type: 'task', parent: feature.ref, title: 'Search index', assignee: otherBe.agent.id, status: 'In progress' });
await mcp(otherBe.key.key, 'update_item', { ref: t4.ref, status: 'Review' });
let t4now = (await api('GET', `/api/items/${t4.ref}`)).item;
assert.equal(t4now.assigneeName, `rv-${run}`, 'handed to a reviewer, never the author');
await mcp(rv.key.key, 'comment', { ref: t4.ref, body: 'Add an index on (org_id, created_at).' });
await mcp(rv.key.key, 'update_item', { ref: t4.ref, status: 'In progress' });
assert.equal((await api('GET', `/api/items/${t4.ref}`)).item.assigneeName, otherBe.agent.name, 'changes requested: back to the author');
await mcp(otherBe.key.key, 'update_item', { ref: t4.ref, status: 'Review' });
await mcp(rv.key.key, 'update_item', { ref: t4.ref, status: 'Done' });
t4now = (await api('GET', `/api/items/${t4.ref}`)).item;
assert.equal(t4now.done, true);
assert.equal(t4now.handedOffFrom, null);
const rvInbox = await mcp(rv.key.key, 'get_inbox', {});
assert.ok(rvInbox.some((n: any) => n.reason === 'review_requested' && n.itemRef === t4.ref));
// Definition-of-done gate: an agent can't close an issue with open tasks.
await assert.rejects(mcp(pm.key.key, 'update_item', { ref: feature.ref, status: 'Done' }), /still has open tasks/);
for (const t of (await api('GET', `/api/items/${feature.ref}`)).tasks.filter((t: any) => !t.done)) {
  await api('PATCH', `/api/items/${t.ref}`, { status: 'Done' });
}
console.log('✓ review hand-off: reviewer ≠ author, changes go back to the author; agents can’t close issues with open tasks');

// Done → the human who created the issue hears about it.
await mcp(pm.key.key, 'update_item', { ref: feature.ref, status: 'Done' });
assert.ok((await api('GET', '/api/inbox?unread=1')).some((n: any) => n.reason === 'done' && n.itemRef === feature.ref));
console.log('✓ skills: column default intake, least-busy spread, waiting work routed, explicit unassign kept, reroute on delete, done → creator');

// ---- Project settings: columns (rename carries items, removal needs empty), delete ----
await assert.rejects(api('POST', `/api/orgs/${org}/projects`, { name: 'x', key: 'SETTINGS' }), /reserved/);
const ops = await api('POST', `/api/orgs/${org}/projects`, { name: 'Ops', key: 'OPS' });
const inReview = await api('POST', `/api/projects/${org}/OPS/items`, { type: 'issue', title: 'Check backups', status: 'Review' });
const opsSchedule = await api('POST', `/api/projects/${org}/OPS/schedules`, { ...scheduleIn, status: 'Review', enabled: false });
const doneItem = await api('POST', `/api/projects/${org}/OPS/items`, { type: 'issue', title: 'Old chore', status: 'Done' });
assert.equal(ops.columns.join(','), 'Backlog,Todo,In progress,Review,Done');
await assert.rejects(
  api('PATCH', `/api/projects/${org}/OPS`, { columns: [{ name: 'Backlog', from: 'Backlog' }, { name: 'Done', from: 'Done' }] }),
  /Move the items out first: Review has 1/,
);
// Rename Review→QA and In progress↔Todo swap, drop nothing, add Shipped as the new done column.
await api('PATCH', `/api/projects/${org}/OPS`, {
  columns: [
    { name: 'Backlog', from: 'Backlog' }, { name: 'In progress', from: 'Todo' }, { name: 'Todo', from: 'In progress' },
    { name: 'QA', from: 'Review' }, { name: 'Done', from: 'Done' }, { name: 'Shipped' },
  ],
});
assert.equal((await api('GET', `/api/items/${inReview.ref}`)).item.status, 'QA');
assert.equal((await api('GET', `/api/projects/${org}/OPS/schedules`)).find((x: any) => x.id === opsSchedule.id).status, 'QA', 'schedules follow renames');
assert.equal((await api('GET', `/api/items/${doneItem.ref}`)).item.done, false, '"Done" is no longer the last column');
cookie = '';
await api('POST', '/auth/dev', { email: `dave-${run}@example.com` });
const daveCookie = cookie;
cookie = aliceCookieForSettings;
await api('POST', `/api/orgs/${org}/invites`, { email: `dave-${run}@example.com` });
cookie = daveCookie;
await api('POST', '/auth/dev', { email: `dave-${run}@example.com` }); // accepts the invite as a member
await assert.rejects(api('PATCH', `/api/projects/${org}/OPS`, { guidelines: 'nope' }), /Requires an org admin/);
await assert.rejects(api('PATCH', `/api/orgs/${org}`, { name: 'nope' }), /Requires an org admin/);
await assert.rejects(api('POST', `/api/projects/${org}/OPS/schedules`, scheduleIn), /Requires an org admin/);
cookie = aliceCookieForSettings;
await assert.rejects(api('DELETE', `/api/projects/${org}/OPS`, { confirm: 'WEB' }), /Type the project key/);
await api('DELETE', `/api/projects/${org}/OPS`, { confirm: 'ops' });
await assert.rejects(api('GET', `/api/items/${inReview.ref}`), /404/);
console.log('✓ project settings: columns rename/swap/add, removal guarded, done recomputed, admin-only, delete');

// ---- Members and agents: rename, delete (deactivate), remove people, cancel invites ----
const aliceCookie = cookie;
await api('POST', `/api/orgs/${org}/invites`, { email: `bob-${run}@example.com` });
await api('POST', `/api/orgs/${org}/invites`, { email: `carol-${run}@example.com` });
cookie = '';
const bob = await api('POST', '/auth/dev', { email: `bob-${run}@example.com`, name: `Bob ${run}` }).then(() => api('GET', '/api/me'));
const bobCookie = cookie;
cookie = aliceCookie;
const bobTask = await api('POST', `/api/projects/${org}/WEB/items`, { type: 'issue', title: 'Bob owns this', assignee: bob.id });
cookie = bobCookie;
const aliceId = (await api('GET', `/api/orgs/${org}`)).members.find((m: any) => m.role === 'owner').id;
await assert.rejects(api('DELETE', `/api/orgs/${org}/members/${aliceId}`), /Requires an org admin/);
cookie = aliceCookie;
await assert.rejects(api('DELETE', `/api/orgs/${org}/members/${aliceId}`), /at least one owner/);
await api('DELETE', `/api/orgs/${org}/invites/carol-${run}@example.com`);
assert.ok(!(await api('GET', `/api/orgs/${org}`)).invites.some((i: any) => i.email.startsWith('carol')));
const removed = await api('DELETE', `/api/orgs/${org}/members/${bob.id}`);
assert.equal(removed.unassigned, 1);
const bobTaskAfter = await api('GET', `/api/items/${bobTask.ref}`);
assert.equal(bobTaskAfter.item.assigneeId, null);
assert.ok(bobTaskAfter.history.some((e: any) => e.type === 'item.updated' && e.data.changes.assignee?.[1] === null));
cookie = bobCookie;
await assert.rejects(api('GET', `/api/items/${bobTask.ref}`), /404/);
assert.ok(!(await api('GET', '/api/inbox')).some((n: any) => n.itemRef === bobTask.ref), 'no items from orgs you left');
cookie = aliceCookie;
console.log('✓ member removal: permissions, last owner kept, items unassigned, access and inbox gone; invite cancelled');

const temp = await api('POST', `/api/orgs/${org}/agents`, { name: `temp-${run}` });
await api('PATCH', `/api/agents/${temp.agent.id}`, { name: `renamed-${run}` });
assert.equal((await mcp(temp.key.key, 'whoami')).name, `renamed-${run}`);
const tempTask = await api('POST', `/api/projects/${org}/WEB/items`, { type: 'issue', title: 'Temp work', assignee: temp.agent.id });
await mcp(temp.key.key, 'comment', { ref: tempTask.ref, body: 'On it.' });
assert.equal((await api('DELETE', `/api/agents/${temp.agent.id}`)).unassigned, 1);
await assert.rejects(mcp(temp.key.key, 'whoami'), /./);
await assert.rejects(api('GET', `/api/agents/${temp.agent.id}`), /404/);
assert.ok(!(await api('GET', `/api/orgs/${org}`)).members.some((m: any) => m.id === temp.agent.id));
const tempAfter = await api('GET', `/api/items/${tempTask.ref}`);
assert.equal(tempAfter.item.assigneeId, null);
assert.equal(tempAfter.comments[0].authorName, `renamed-${run}`, 'history keeps the deleted agent');
console.log('✓ agent rename and delete: keys revoked, removed from org, items unassigned, history kept');

// API reference is generated from the registered routes: complete and self-describing.
const help = await (await fetch(`${BASE}/api/help`)).text();
assert.doesNotMatch(help, /\(undocumented\)/, 'every /api route has docs');
assert.match(help, /PATCH \/api\/items\/\{ref\}\n.*\n.*\n  body:\n(.*\n)*?    status\?: string/);
console.log('✓ /api/help generated from routes:', help.split('\n').filter((l) => /^(GET|POST|PATCH|DELETE) /.test(l)).length, 'endpoints; payload', fires[0].text.length, 'chars');

// Starter setup: a new org gets a PM, Dev and QA; its projects are set up for them.
const starter = `start-${run}`;
await api('POST', '/api/orgs', { slug: starter, name: 'Starter' });
const sOrg = await api('GET', `/api/orgs/${starter}`);
const sAgents = Object.fromEntries(sOrg.members.filter((m: any) => m.kind === 'agent').map((m: any) => [m.name, m]));
assert.deepEqual(Object.keys(sAgents).sort(), ['Dev', 'Lead', 'PM', 'QA']);
assert.deepEqual(sAgents.Lead.skills, ['architecture', 'review']);
assert.deepEqual(sAgents.PM.skills, ['product']);
assert.deepEqual(sAgents.QA.skills, ['qa']);
assert.ok(sAgents.Dev.skills.includes('backend') && sAgents.PM.description.startsWith('You are the product manager'));
assert.equal(sOrg.agentReady, true);
assert.equal(sAgents.PM.connected, false, 'not connected until it has a routine, webhook or used key');
const sProj = await api('POST', `/api/orgs/${starter}/projects`, { name: 'App' });
assert.deepEqual(sProj.columnSkills, { Todo: 'product' });
assert.deepEqual(sProj.columnHandoffs, { Review: 'review' });
assert.match(sProj.guidelines, /## How work flows here/);
const sIssue = await api('POST', `/api/projects/${starter}/APP/items`, { type: 'issue', title: 'Dark mode', status: 'Todo' });
assert.equal(sIssue.assigneeName, 'PM');
const pmView = await api('GET', `/api/agents/${sAgents.PM.id}`);
assert.match(pmView.routine.instructions, /Your role and hard limits:\nYou are the product manager/);
const blank = await api('POST', `/api/orgs/${starter}/projects`, { name: 'Scratch', setup: 'blank' });
assert.deepEqual(blank.columnSkills, {});
assert.equal((await api('POST', `/api/orgs/${org}/projects`, { name: 'Plain' })).guidelines, '', 'orgs without product+build+qa get blank projects');
await api('DELETE', `/api/orgs/${starter}`, { confirm: starter });
console.log('✓ starter setup: new org gets PM/Lead/Dev/QA; its projects route Todo to the PM and start from the pipeline guidelines');
// An existing org without the team adds it later, run by Tasks on one provider and model.
const lateOrg = `late-${run}`;
await api('POST', '/api/orgs', { slug: lateOrg, name: 'Late', starterAgents: false });
assert.equal((await api('GET', `/api/orgs/${lateOrg}`)).agentReady, false);
await api('POST', `/api/orgs/${lateOrg}/agents`, { name: 'QA' }); // a name already taken is skipped
const lateProv = await api('POST', `/api/orgs/${lateOrg}/ai-providers`, { provider: 'openai-compatible', apiKey: 'sk-test-key', baseUrl: 'http://localhost:4557/v1' }).catch(() => null);
const team = await api('POST', `/api/orgs/${lateOrg}/starter-team`, { runtime: lateProv ? { providerId: lateProv.id, model: 'fake-idle' } : null });
assert.deepEqual(team.created.map((a: any) => a.name), ['PM', 'Lead', 'Dev']);
const devAgent = await api('GET', `/api/agents/${team.created[2].id}`);
if (lateProv) assert.deepEqual([devAgent.runtime?.model, devAgent.runtime?.maxSteps], ['fake-idle', 80]);
assert.equal((await api('POST', `/api/orgs/${lateOrg}/starter-team`, {})).created.length, 0);
console.log('✓ starter team for an existing org: skips taken names, runs in Tasks with one model');

// Deleting an org: owner + typed slug; cascades, cleans up cross-org links, revokes its agents.
const other = `other-${run}`;
await api('POST', '/api/orgs', { slug: other, name: 'Other', starterAgents: false });
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
await db.end();
console.log('\nall smoke checks passed');

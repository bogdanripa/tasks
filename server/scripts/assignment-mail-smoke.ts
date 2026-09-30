// Assignment emails (TAS-34) against a real database and a capturing transport:
//   DATABASE_URL=postgres://... npx tsx scripts/assignment-mail-smoke.ts
import assert from 'node:assert/strict';
import { migrate, sql, mutate, flushMail } from '../src/db.js';
import { createItem, updateItem } from '../src/domain.js';
import { setTransportForTests, type Email } from '../src/mailer.js';
import { emailAssignment } from '../src/assignmentMail.js';

await migrate();
const run = Date.now().toString(36);
const sent: Email[] = [];
let failing = false;
setTransportForTests({ async send(e) { if (failing) throw new Error('smtp down'); sent.push(e); } });

const acct = async (kind: 'human' | 'agent', name: string, orgId: string | null = null) =>
  (await sql`insert into accounts (kind, name, email, org_id) values (${kind}, ${name}, ${kind === 'human' ? `${name}-${run}@x.test` : null}, ${orgId}) returning id, name, email`)[0];
const [org] = await sql`insert into orgs (slug, name) values (${'am-' + run}, 'AM') returning id, slug`;
const [projRow] = await sql`insert into projects (org_id, key, name, columns) values (${org.id}, 'AMX', 'Mail proj', ${['Backlog', 'Todo', 'In progress', 'Review', 'Done']}) returning id`;
const A = await acct('human', 'alice'), B = await acct('human', 'bob'), C = await acct('human', 'carol');
const bot = await acct('agent', 'bot', org.id);
for (const [m, role] of [[A, 'owner'], [B, 'member'], [C, 'member'], [bot, 'member']] as const) {
  await sql`insert into memberships (org_id, account_id, role) values (${org.id}, ${m.id}, ${role})`;
}
const actor = (m: any, kind: 'human' | 'agent' = 'human') => ({ id: m.id, kind, name: m.name, email: m.email, orgId: kind === 'agent' ? org.id : null });
const alice = actor(A), botActor = actor(bot, 'agent');
const project = async () => (await sql`select p.*, o.slug as org_slug from projects p join orgs o on o.id = p.org_id where p.id = ${projRow.id}`)[0];
const proj = { ...(await project()), orgSlug: org.slug };
const take = async () => { await flushMail(); return sent.splice(0); };

// AC 2: create with an assignee.
const issue = await createItem(alice, proj, { type: 'issue', title: 'Parent issue', body: 'x'.repeat(300) });
assert.equal((await take()).length, 0, 'unassigned create sends nothing');
const task = await createItem(alice, proj, { type: 'task', title: 'Do it', parentRef: issue.ref, assignee: B.name, body: 'line one\n\n  line two' });
let m = await take();
assert.equal(m.length, 1); assert.equal(m[0].to, B.email);
assert.equal(m[0].subject, `alice assigned you ${task.ref}: Do it`);
for (const s of ['task', task.ref, issue.ref, 'Parent issue', 'Mail proj', 'line one line two', `/app/i/${org.slug}/AMX-`]) assert.ok(m[0].text.includes(s), `text has ${s}`);
assert.ok(m[0].html!.includes('<a href='), 'html part');

// AC 1: reassign by human; by an agent.
await updateItem(alice, task.ref, { assignee: C.name });
m = await take(); assert.equal(m.length, 1); assert.equal(m[0].to, C.email);
await updateItem(botActor, task.ref, { assignee: B.name });
m = await take(); assert.equal(m.length, 1); assert.equal(m[0].to, B.email);
assert.ok(m[0].subject.startsWith('bot assigned you'), 'agent as assigner');

// AC 3: no email for same assignee, self-assign, agent assignee, unassign.
await updateItem(alice, task.ref, { assignee: B.name });
await updateItem(alice, task.ref, { assignee: A.name });
await updateItem(alice, task.ref, { assignee: bot.name });
await updateItem(alice, task.ref, { assignee: null });
assert.equal((await take()).length, 0, 'same/self/agent/unassign send nothing');

// Review hand-off to a human, and back to the author on changes requested.
await sql`update memberships set skills = ${['review']} where org_id = ${org.id} and account_id = ${C.id}`;
await sql`update projects set column_handoffs = ${sql.json({ Review: 'review' })} where id = ${projRow.id}`;
await updateItem(alice, task.ref, { assignee: B.name }); await take();
await updateItem(actor(B), task.ref, { status: 'Review' });
m = await take();
assert.equal(m[0]?.to, C.email, 'reviewer emailed');
await updateItem(actor(C), task.ref, { status: 'In progress' });
m = await take(); assert.equal(m[0]?.to, B.email, 'author emailed on changes requested');

// Skill routing to a human.
await sql`update memberships set skills = ${['qa']} where org_id = ${org.id} and account_id = ${C.id}`;
const routed = await createItem(alice, proj, { type: 'task', title: 'Needs qa', parentRef: issue.ref, skill: 'qa' });
m = await take(); assert.equal(m.length, 1); assert.equal(m[0].to, C.email); assert.ok(routed.ref);

// HTML escaping.
await createItem(alice, proj, { type: 'task', title: '<script>alert(1)</script>', parentRef: issue.ref, assignee: B.name });
m = await take();
assert.ok(!m[0].html!.includes('<script>') && m[0].html!.includes('&lt;script&gt;'), 'title escaped');

// AC 4: failing transport does not fail the assignment, and is logged (metadata only).
failing = true;
const errs: any[][] = []; const origErr = console.error; console.error = (...a) => { errs.push(a); };
await updateItem(alice, task.ref, { assignee: C.name });
await flushMail(); console.error = origErr; failing = false;
assert.equal((await sql`select assignee_id from items where id = ${task.id}`)[0].assigneeId, C.id, 'assignment persisted');
assert.equal(errs.length, 1); assert.equal(errs[0][0], 'assignment email failed');
assert.ok(!JSON.stringify(errs[0]).includes(C.email), 'address not logged');

// Rollback sends nothing.
await assert.rejects(mutate(async (tx) => {
  emailAssignment(tx, alice, { itemId: task.id, assigneeId: B.id, previousAssigneeId: null });
  throw new Error('boom');
}));
assert.equal((await take()).length, 0, 'rolled back: nothing sent');

setTransportForTests(null);
console.log('assignment-mail smoke ok');
await sql.end();

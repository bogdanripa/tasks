// Project digest (TAS-22) against a real database, log-style capture transport and mailTick(now):
//   DATABASE_URL=postgres://... npx tsx scripts/project-digest-smoke.ts
import assert from 'node:assert/strict';
import { migrate, sql } from '../src/db.js';
import { mailTick } from '../src/mailScheduler.js';
import { registerProjectDigest, PER_PROJECT_CAP } from '../src/projectDigest.js';
import { setTransportForTests, type Email } from '../src/mailer.js';
import { unsubscribeToken, readToken } from '../src/emailPrefs.js';

await migrate();
registerProjectDigest();

const run = Date.now().toString(36);
const sent: Email[] = [];
let failing = false;
setTransportForTests({ async send(e) { if (failing) throw new Error('smtp down'); sent.push(e); } });
const to = (email: string) => sent.filter((m) => m.to === email);

const acct = async (kind: 'human' | 'agent', name: string, tz: string | null, orgId: string | null = null) =>
  (await sql`insert into accounts (kind, name, email, timezone, org_id) values (${kind}, ${name}, ${kind === 'human' ? `${name}-${run}@x.test` : null}, ${tz}, ${orgId}) returning id, email`)[0];
const org = async (slug: string) => (await sql`insert into orgs (slug, name) values (${`${slug}-${run}`}, ${slug}) returning id, slug`)[0];
const proj = async (orgId: string, key: string) => (await sql`insert into projects (org_id, key, name) values (${orgId}, ${key}, ${key + ' proj'}) returning id, key`)[0];
const member = (orgId: string, id: string, role: string) => sql`insert into memberships (org_id, account_id, role) values (${orgId}, ${id}, ${role})`;
const ev = (orgId: string, projectId: string, actor: string, type: string, data: object) =>
  sql`insert into events (org_id, project_id, actor_id, type, data) values (${orgId}, ${projectId}, ${actor}, ${type}, ${sql.json(data as any)}) returning id`;
const created = (o: any, p: any, actor: string, n: number) =>
  ev(o.id, p.id, actor, 'item.created', { ref: `${o.slug}/${p.key}-${n}`, type: 'task', title: `Thing ${n}` });

const oa = await org('alpha'), ob = await org('beta');
const pa = await proj(oa.id, 'AAA'), pa2 = await proj(oa.id, 'AAB'), pb = await proj(ob.id, 'BBB');
const owner = await acct('human', 'owner', 'Europe/Bucharest');
const admin = await acct('human', 'admin', 'America/Los_Angeles');
const plain = await acct('human', 'plain', 'Europe/Bucharest');
const bot = await acct('agent', 'bot', null, oa.id);
await member(oa.id, owner.id, 'owner'); await member(oa.id, admin.id, 'admin'); await member(oa.id, plain.id, 'member');
await member(ob.id, plain.id, 'owner'); // owns beta only
await created(oa, pa, owner.id, 1);
await ev(oa.id, pa.id, bot.id, 'agent.run_started', { ref: 'x' });   // noise: excluded
await ev(oa.id, pa.id, bot.id, 'watchdog.nudge', {});               // noise: excluded
await ev(oa.id, pa.id, owner.id, 'item.updated', { ref: `${oa.slug}/AAA-1`, title: 'Thing 1', changes: { status: ['Review', 'Done'] } });
await created(ob, pb, plain.id, 1);

const T_BUC = new Date('2026-07-15T03:00:00Z');   // 06:00 in Bucharest (UTC+3), 20:00 previous day in LA
const T_LA = new Date('2026-07-15T13:00:00Z');    // 06:00 in Los Angeles (UTC-7)
const mine = [owner.email, admin.email, plain.email];
const count = () => mine.reduce((n, e) => n + to(e).length, 0);

// Opt-in required.
await mailTick(T_BUC);
assert.equal(count(), 0, 'nothing sent before opting in');

const on = (id: string) => sql`insert into email_prefs (account_id, topic, scope, enabled) values (${id}, 'project_digest', '', true) on conflict (account_id, topic, scope) do update set enabled = true`;
for (const a of [owner, admin, plain]) await on(a.id);

// Only 06:00 in the person's own zone; owner (Bucharest) first.
await mailTick(new Date('2026-07-15T02:00:00Z'));
assert.equal(count(), 0, 'not yet 06:00 anywhere');
await mailTick(T_BUC);
assert.equal(to(owner.email).length, 1, 'owner gets it at their 06:00');
assert.equal(to(admin.email).length, 0, 'LA admin waits for their own 06:00');
const m = to(owner.email)[0];
assert.match(m.subject, /^Project changes: 2 updates in 1 project$/);
assert.ok(m.text.includes('Thing 1') && m.text.includes('marked done'), 'created + done shown');
assert.ok(!m.text.includes('agent') && !/run_started|watchdog/.test(m.text), 'agent/watchdog events excluded');
assert.ok(!m.text.includes(`${ob.slug}`), 'only owned projects');
assert.ok(m.headers?.['List-Unsubscribe'], 'List-Unsubscribe header');
const tokens = [...m.text.matchAll(/unsubscribe\?t=([\w.-]+)/g)].map((x) => readToken(x[1])!);
assert.ok(tokens.some((t) => t.scope === ''), 'unsubscribe-all link');
assert.ok(tokens.some((t) => t.scope === pa.id), 'per-project link');
// Plain member who owns beta gets only beta's events.
assert.equal(to(plain.email).length, 1);
assert.ok(to(plain.email)[0].text.includes(`${ob.slug}/BBB-1`) && !to(plain.email)[0].text.includes('AAA-1'));
await mailTick(T_LA);
assert.equal(to(admin.email).length, 1, 'admin gets theirs at LA 06:00');
assert.ok(!to(admin.email)[0].text.includes('BBB-1'), 'admin does not own beta');

// Second tick the same day: no duplicate.
await mailTick(T_BUC); await mailTick(T_LA);
assert.equal(count(), 3, 'no duplicate for the same local date');

// Next day, nothing changed: no email. Then one later change sends only that event.
const D2 = new Date('2026-07-16T03:00:00Z');
await mailTick(D2);
assert.equal(to(owner.email).length, 1, 'empty window sends nothing');
await created(oa, pa, owner.id, 2);
await mailTick(new Date('2026-07-17T03:00:00Z'));
assert.equal(to(owner.email).length, 2);
assert.ok(to(owner.email)[1].text.includes('Thing 2') && !to(owner.email)[1].text.includes('Thing 1'), 'no event reported twice');

// Failing transport keeps the cursor; the retry has the same events.
const [{ lastEventId: before }] = await sql`select last_event_id from digest_cursors where account_id = ${owner.id}`;
await created(oa, pa, owner.id, 3);
failing = true;
await mailTick(new Date('2026-07-18T03:00:00Z'));
failing = false;
const [{ lastEventId: after }] = await sql`select last_event_id from digest_cursors where account_id = ${owner.id}`;
assert.equal(String(after), String(before), 'cursor not advanced by a failed send');
assert.equal(to(owner.email).length, 2);
await mailTick(new Date('2026-07-18T03:05:00Z'));
assert.equal(to(owner.email).length, 3, 'retried within the window');
assert.ok(to(owner.email)[2].text.includes('Thing 3'));

// Per-project unsubscribe drops only that project.
await sql`insert into email_prefs (account_id, topic, scope, enabled) values (${owner.id}, 'project_digest', ${pa.id}, false)`;
await created(oa, pa, owner.id, 4);
await created(oa, pa2, owner.id, 5);
await mailTick(new Date('2026-07-19T03:00:00Z'));
const m4 = to(owner.email)[3];
assert.ok(m4.text.includes('AAB-5') && !m4.text.includes('AAA-4'), 'opted-out project omitted, other kept');
assert.ok(tokens.every((t) => t.accountId === owner.id || t.accountId === admin.id));
// Unsubscribe-all stops the mail.
await sql`update email_prefs set enabled = false where account_id = ${owner.id} and scope = ''`;
await created(oa, pa2, owner.id, 6);
await mailTick(new Date('2026-07-20T03:00:00Z'));
assert.equal(to(owner.email).length, 4, 'unsubscribed from all');
// Re-subscribe restores.
await sql`update email_prefs set enabled = true where account_id = ${owner.id} and scope = ''`;
await mailTick(new Date('2026-07-21T03:00:00Z'));
assert.equal(to(owner.email).length, 5);
assert.ok(to(owner.email)[4].text.includes('AAB-6'));

// A tampered token is rejected.
const good = unsubscribeToken(owner.id, 'project_digest', pa.id);
assert.equal(readToken(good.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'))), null);

// Cap: pa2 already holds 2 events (AAB-5/6); with 57 more that is 59, so 50 shown and "and 9 more".
const big = await acct('human', 'big', 'Europe/Bucharest');
await member(oa.id, big.id, 'owner'); await on(big.id);
await sql`insert into email_prefs (account_id, topic, scope, enabled) select ${big.id}, 'project_digest', p.id::text, false from projects p where p.org_id = ${oa.id} and p.id <> ${pa2.id}`;
for (let i = 0; i < PER_PROJECT_CAP + 7; i++) await created(oa, pa2, owner.id, 100 + i);
await mailTick(new Date('2026-07-22T03:00:00Z'));
const mb = to(big.email)[0];
assert.ok(mb && /and 9 more/.test(mb.text), `cap footer, got: ${mb?.text.slice(-400)}`);
assert.equal((mb.text.match(/^- /gm) ?? []).length, PER_PROJECT_CAP);

console.log('✓ project digest (opt-in, roles, zones, windows, retry, unsubscribe, cap)');
await sql.end();

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql } from './db.js';
import { config } from './config.js';
import { requireActor, type Actor } from './auth.js';
import { badRequest, forbidden, HttpError } from './errors.js';
import { route } from './apidoc.js';

/** What a topic does when the account has made no explicit choice. TAS-22 adds project_digest (off). */
export const TOPIC_DEFAULTS: Record<string, boolean> = { assigned_summary: true, project_digest: false };
const TOPIC_LABELS: Record<string, string> = { assigned_summary: 'your daily summary of assigned items', project_digest: 'the project changes digest' };

// ---- tokens ----
// Stateless and without expiry: an old email must keep working. It grants only "turn this
// topic/scope off for this account", so a leaked link is low-risk.
const key = () => createHmac('sha256', config.secretsKey).update('email-unsubscribe').digest();
const sign = (payload: string) => createHmac('sha256', key()).update(payload).digest();

export function unsubscribeToken(accountId: string, topic: string, scope = '') {
  const payload = ['v1', accountId, topic, scope].join('|');
  return `${Buffer.from(payload).toString('base64url')}.${sign(payload).toString('base64url')}`;
}

export function unsubscribeUrl(token: string) {
  return `${config.publicUrl}/api/email/unsubscribe?t=${encodeURIComponent(token)}`;
}

/** Verifies (constant time) and decodes; null for anything malformed or tampered with. */
export function readToken(t: unknown): { accountId: string; topic: string; scope: string } | null {
  if (typeof t !== 'string') return null;
  const [p, s, ...rest] = t.split('.');
  if (!p || !s || rest.length) return null;
  const payload = Buffer.from(p, 'base64url').toString('utf8');
  const given = Buffer.from(s, 'base64url');
  const want = sign(payload);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
  const [v, accountId, topic, scope] = payload.split('|');
  if (v !== 'v1' || !accountId || !topic || scope === undefined || !(topic in TOPIC_DEFAULTS)) return null;
  return { accountId, topic, scope };
}

// ---- preferences ----
export async function isEnabled(accountId: string, topic: string, scope = ''): Promise<boolean> {
  const [row] = await sql`select enabled from email_prefs where account_id = ${accountId} and topic = ${topic} and scope = ${scope}`;
  return row ? (row.enabled as boolean) : (TOPIC_DEFAULTS[topic] ?? false);
}

/** Idempotent upsert of an explicit choice. Only human accounts have email preferences. */
export async function setEnabled(accountId: string, topic: string, scope: string, enabled: boolean) {
  const [acc] = await sql`select kind from accounts where id = ${accountId}`;
  if (!acc || acc.kind !== 'human') return false;
  await sql`
    insert into email_prefs (account_id, topic, scope, enabled) values (${accountId}, ${topic}, ${scope}, ${enabled})
    on conflict (account_id, topic, scope) do update set enabled = excluded.enabled, updated_at = now()`;
  return true;
}

export function validTimezone(tz: string) {
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; }
}
const timezone = z.string().min(1).max(60).refine(validTimezone, 'Unknown IANA timezone');

async function human(req: Parameters<typeof requireActor>[0]): Promise<Actor> {
  const actor = await requireActor(req);
  if (actor.kind !== 'human') throw forbidden('Email preferences are for people, not agents');
  return actor;
}

const DIGEST = 'project_digest';

/** Projects of every org where the person is owner/admin: the ones a project digest can cover. */
async function ownedProjects(accountId: string) {
  return sql`
    select p.id, p.key, p.name, o.slug as org_slug
    from projects p join orgs o on o.id = p.org_id
    join memberships m on m.org_id = o.id and m.account_id = ${accountId} and m.role in ('owner', 'admin')
    order by o.name, p.key`;
}

/** Master on: subscribe to everything owned, so explicit per-project rows (opt-outs) are cleared. */
async function setDigestMaster(accountId: string, enabled: boolean) {
  await setEnabled(accountId, DIGEST, '', enabled);
  if (enabled) await sql`delete from email_prefs where account_id = ${accountId} and topic = ${DIGEST} and scope <> ''`;
}

/** Effective state per project: master on and no explicit opt-out. */
async function projectDigestState(id: string) {
  const master = await isEnabled(id, DIGEST);
  const rows = await sql`select scope, enabled from email_prefs where account_id = ${id} and topic = ${DIGEST} and scope <> ''`;
  const explicit = new Map(rows.map((r) => [r.scope as string, r.enabled as boolean]));
  const projects = (await ownedProjects(id)).map((p) => ({
    id: p.id as string, orgSlug: p.orgSlug as string, key: p.key as string, name: p.name as string,
    enabled: master && (explicit.get(p.id as string) ?? true),
  }));
  return { enabled: master, projects };
}

async function emailSettings(id: string) {
  const [acc] = await sql`select timezone from accounts where id = ${id}`;
  return {
    timezone: (acc?.timezone as string | null) ?? null,
    topics: { assignedSummary: await isEnabled(id, 'assigned_summary'), projectDigest: await projectDigestState(id) },
  };
}

/**
 * Re-subscribing to one project while the master is off must not subscribe the person to more than
 * they clicked: turn the master on but explicitly opt out of their other owned projects.
 */
async function resubscribeProject(accountId: string, projectId: string) {
  if (await isEnabled(accountId, DIGEST)) return setEnabled(accountId, DIGEST, projectId, true);
  for (const p of await ownedProjects(accountId)) {
    if (p.id !== projectId) await setEnabled(accountId, DIGEST, p.id as string, false);
  }
  await setEnabled(accountId, DIGEST, projectId, true);
  return setEnabled(accountId, DIGEST, '', true);
}

// ---- pages ----
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#222}button{font:inherit;padding:.5rem 1rem;cursor:pointer}</style></head><body><h1>${esc(title)}</h1>${body}</body></html>`;

async function confirmPage(t: string, topic: string, scope: string, on: boolean) {
  let what = TOPIC_LABELS[topic] ?? topic;
  if (topic === DIGEST) {
    if (scope === '') what = 'all project summaries';
    else {
      // Unknown or deleted project (or a malformed id): generic wording, still a 200.
      const [p] = /^[0-9a-f-]{36}$/i.test(scope) ? await sql`select name from projects where id = ${scope}` : [];
      what = p ? (p.name as string) : 'this project summary';
    }
  }
  const action = on ? 'unsubscribe' : 'resubscribe';
  const msg = on ? `You'll get ${what} again.` : `You're unsubscribed from ${what}.`;
  const other = on ? 'Unsubscribe' : 'Re-subscribe';
  return page(on ? 'Re-subscribed' : "You're unsubscribed", `<p>${esc(msg)}</p><form method="post" action="/api/email/${action}?t=${encodeURIComponent(t)}"><button>${other}</button></form><p><a href="${esc(config.publicUrl)}/app/">Open Tasks</a> · change this any time in Settings.</p>`);
}

export function emailRoutes(app: FastifyInstance) {
  // RFC 8058 one-click posts a form body ("List-Unsubscribe=One-Click"); accept and ignore it.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, _body, done) => done(null, {}));

  async function apply(t: unknown, enabled: boolean) {
    const tok = readToken(t);
    if (!tok) return null;
    if (enabled && tok.topic === DIGEST) {
      if (tok.scope === '') await setDigestMaster(tok.accountId, true);
      else await resubscribeProject(tok.accountId, tok.scope);
    } else await setEnabled(tok.accountId, tok.topic, tok.scope, enabled);
    return tok;
  }
  const bad = (reply: any) => reply.code(400).type('text/html').send(page('Invalid link', '<p>This link is not valid, so nothing was changed.</p>'));
  const handler = (enabled: boolean, html: boolean) => async (req: any, _input: unknown, reply: any) => {
    const t = (req.query as { t?: string }).t;
    const tok = await apply(t, enabled);
    if (!tok) return bad(reply);
    return html ? reply.type('text/html').send(await confirmPage(t!, tok.topic, tok.scope, enabled)) : { ok: true };
  };
  // No session auth on these: the signed token is the credential. GET acts directly (one-click); it is
  // instantly reversible from the page it returns and from Settings.
  route(app, 'GET', '/api/email/unsubscribe', { section: 'Email', summary: 'unsubscribe link from an email (signed token, no login); shows a page' }, handler(false, true));
  route(app, 'POST', '/api/email/unsubscribe', { section: 'Email', summary: 'RFC 8058 one-click unsubscribe (signed token, no login)' }, handler(false, false));
  route(app, 'POST', '/api/email/resubscribe', { section: 'Email', summary: 'undo an unsubscribe (signed token, no login); shows a page' }, handler(true, true));

  route(app, 'GET', '/api/me/email', { section: 'You', summary: 'your email settings: time zone and which emails you get' }, async (req) =>
    emailSettings((await human(req)).id),
  );
  route(app, 'PUT', '/api/me/email', {
    section: 'You',
    summary: 'change your email time zone and/or turn the daily assigned-items summary or the project changes digest (master; on clears per-project opt-outs) on or off',
    body: z.object({ timezone: timezone.optional(), assignedSummary: z.boolean().optional(), projectDigest: z.boolean().optional() }),
  }, async (req, { body }) => {
    const actor = await human(req);
    if (body.timezone !== undefined) await sql`update accounts set timezone = ${body.timezone} where id = ${actor.id}`;
    if (body.assignedSummary !== undefined) await setEnabled(actor.id, 'assigned_summary', '', body.assignedSummary);
    if (body.projectDigest !== undefined) await setDigestMaster(actor.id, body.projectDigest);
    return emailSettings(actor.id);
  });
  route(app, 'PUT', '/api/me/email/projects/:projectId', {
    section: 'You',
    summary: 'turn the project changes digest on or off for one project you own (org owner/admin); the master switch must be on',
    body: z.object({ enabled: z.boolean() }),
  }, async (req, { body }) => {
    const actor = await human(req);
    const projectId = (req.params as { projectId: string }).projectId;
    if (!(await ownedProjects(actor.id)).some((p) => p.id === projectId)) throw forbidden('You can only change projects you own');
    if (!(await isEnabled(actor.id, DIGEST))) throw badRequest('Turn on the project changes digest first');
    await setEnabled(actor.id, DIGEST, projectId, body.enabled);
    return emailSettings(actor.id);
  });
  route(app, 'PUT', '/api/me/timezone', {
    section: 'You',
    summary: 'set your time zone only if it is not set yet (the app auto-detects it; never overwrites your choice)',
    body: z.object({ timezone }),
  }, async (req, { body }) => {
    const actor = await human(req);
    await sql`update accounts set timezone = ${body.timezone} where id = ${actor.id} and timezone is null`;
    return { timezone: (await emailSettings(actor.id)).timezone };
  });
}

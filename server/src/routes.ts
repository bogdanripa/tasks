import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql } from './db.js';
import { mintApiKey, requireActor } from './auth.js';
import { badRequest } from './errors.js';
import * as d from './domain.js';
import { config } from './config.js';
import { ROUTINE_INSTRUCTIONS } from './routine.js';
import { fullReference, route } from './apidoc.js';

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{1,38}$/, 'lowercase letters, digits and dashes (2–39 chars)');
const projectKey = z.string().regex(/^[A-Za-z][A-Za-z0-9]{1,9}$/, 'letter followed by 1–9 letters/digits');
const assignee = z.string().nullable().optional().describe('member name, email or id; null to unassign');
const webhook = z.string().url().nullable().optional().or(z.literal('').transform(() => null));

export function apiRoutes(app: FastifyInstance) {
  // ---- you ----
  route(app, 'GET', '/api/me', { section: 'You', summary: 'your account, organizations and unread count', agent: true }, async (req) => {
    const actor = await requireActor(req);
    const [me] = await sql`select id, kind, name, email, avatar_url from accounts where id = ${actor.id}`;
    const [{ n }] = await sql`select count(*)::int as n from notifications where account_id = ${actor.id} and read_at is null`;
    return { ...me, orgs: await d.listOrgs(actor), unread: n };
  });
  route(app, 'GET', '/api/me/work', { section: 'You', summary: 'open items assigned to you', agent: true }, async (req) => {
    const actor = await requireActor(req);
    return d.assignedTo(actor, actor.id);
  });
  route(app, 'GET', '/api/inbox', {
    section: 'You',
    summary: 'your notifications, newest first',
    query: z.object({ unread: z.enum(['1']).optional().describe('1: unread only') }),
    agent: true,
  }, async (req, { query }) => d.inbox(await requireActor(req), { unreadOnly: query.unread === '1' }));
  route(app, 'POST', '/api/inbox/read', {
    section: 'You',
    summary: 'mark notifications as read',
    body: z.object({ ids: z.union([z.array(z.number()), z.literal('all')]) }),
  }, async (req, { body }) => {
    await d.markRead(await requireActor(req), body.ids);
    return { ok: true };
  });
  route(app, 'GET', '/api/me/keys', { section: 'You', summary: 'your personal API keys' }, async (req) => d.listKeys((await requireActor(req)).id));
  route(app, 'POST', '/api/me/keys', {
    section: 'You',
    summary: 'create a personal API key (returned once)',
    body: z.object({ name: z.string().min(1).max(80) }),
  }, async (req, { body }) => mintApiKey((await requireActor(req)).id, body.name));
  route(app, 'DELETE', '/api/keys/:id', { section: 'You', summary: 'revoke an API key (yours, or an agent’s you administer)' }, async (req) => {
    await d.revokeKey(await requireActor(req), req.params.id);
    return { ok: true };
  });

  // ---- organizations ----
  route(app, 'POST', '/api/orgs', {
    section: 'Organizations',
    summary: 'create an organization (humans only); you become its owner',
    body: z.object({ slug, name: z.string().min(1).max(80) }),
  }, async (req, { body }) => d.createOrg(await requireActor(req), body));
  route(app, 'GET', '/api/orgs/:org', {
    section: 'Organizations',
    summary: 'an organization: projects, members (humans and agents), pending invites',
    agent: true,
  }, async (req) => d.orgDetail(await requireActor(req), req.params.org));
  route(app, 'DELETE', '/api/orgs/:org', {
    section: 'Organizations',
    summary: 'delete an organization and everything in it (owners only)',
    body: z.object({ confirm: z.string().describe('the organization slug, repeated') }),
  }, async (req, { body }) => {
    await d.deleteOrg(await requireActor(req), req.params.org, body.confirm);
    return { ok: true };
  });
  route(app, 'POST', '/api/orgs/:org/invites', {
    section: 'Organizations',
    summary: 'invite a person by Google account email (admins); they join on next sign-in',
    body: z.object({ email: z.email(), role: z.enum(['admin', 'member']).default('member') }),
  }, async (req, { body }) => d.inviteMember(await requireActor(req), req.params.org, body.email, body.role));
  route(app, 'DELETE', '/api/orgs/:org/invites/:email', { section: 'Organizations', summary: 'cancel a pending invite (admins)' }, async (req) => {
    await d.cancelInvite(await requireActor(req), req.params.org, req.params.email);
    return { ok: true };
  });
  route(app, 'DELETE', '/api/orgs/:org/members/:id', {
    section: 'Organizations',
    summary: 'remove a member or agent, or leave (your own id); their open items are unassigned',
  }, async (req) => d.removeMember(await requireActor(req), req.params.org, req.params.id));

  // ---- agents ----
  route(app, 'POST', '/api/orgs/:org/agents', {
    section: 'Agents',
    summary: 'create an agent (admins); returns it with an API key, shown once',
    body: z.object({ name: z.string().min(1).max(80), webhookUrl: webhook }),
  }, async (req, { body }) => {
    const agent = await d.createAgent(await requireActor(req), req.params.org, body);
    return { agent, key: await mintApiKey(agent.id, 'default') };
  });
  route(app, 'GET', '/api/agents/:id', { section: 'Agents', summary: 'an agent’s settings, keys, runs, queue and recent notifications (admins)' }, async (req) => {
    const agent = await d.requireAgentAdmin(await requireActor(req), req.params.id);
    const [deliveries, runs, [queue], [pause]] = await Promise.all([
      sql`
        select n.id, n.reason, n.delivery_status, n.attempts, n.last_error, n.created_at, n.read_at, n.next_attempt_at, v.ref as item_ref
        from notifications n left join item_view v on v.id = n.item_id
        where n.account_id = ${agent.id} order by n.id desc limit 30`,
      sql`
        select r.id, r.status, r.reasons, r.session_url, r.error, r.created_at, r.finished_at, v.ref as item_ref, v.title as item_title,
               k.last_used_at
        from agent_runs r left join item_view v on v.id = r.item_id left join api_keys k on k.id = r.key_id
        where r.agent_id = ${agent.id} order by r.created_at desc limit 20`,
      sql`
        select count(*)::int as updates, count(distinct item_id)::int as items, min(next_attempt_at) as next_at
        from notifications where account_id = ${agent.id} and delivery_status = 'pending'`,
      sql`select until, reason from routine_pauses where org_id = ${agent.orgId} and until > now()`,
    ]);
    const [{ slug: orgSlug }] = await sql`select slug from orgs where id = ${agent.orgId}`;
    return {
      agent: {
        id: agent.id,
        name: agent.name,
        orgSlug,
        webhookUrl: agent.webhookUrl,
        webhookSecret: agent.webhookSecret,
        routineUrl: agent.routineUrl,
        hasRoutineToken: !!agent.routineTokenEnc,
      },
      keys: await d.listKeys(agent.id),
      deliveries,
      runs,
      queue,
      pause: pause ?? null,
      routine: { instructions: ROUTINE_INSTRUCTIONS, allowDomain: new URL(config.publicUrl).host },
    };
  });
  route(app, 'PATCH', '/api/agents/:id', {
    section: 'Agents',
    summary: 'rename an agent or change how it gets work (admins)',
    body: z.object({
      name: z.string().min(1).max(80).optional(),
      webhookUrl: webhook,
      routineUrl: z.string().max(300).nullable().optional().describe('Claude Code routine /fire URL or routine id; null to remove'),
      routineToken: z.string().min(10).max(500).optional().describe('the routine’s API token; stored encrypted'),
    }),
  }, async (req, { body }) => d.updateAgent(await requireActor(req), req.params.id, body));
  route(app, 'DELETE', '/api/agents/:id', {
    section: 'Agents',
    summary: 'delete (deactivate) an agent: keys revoked, open items unassigned, history kept (admins)',
  }, async (req) => d.deleteAgent(await requireActor(req), req.params.id));
  route(app, 'POST', '/api/agents/:id/keys', {
    section: 'Agents',
    summary: 'create another API key for an agent (admins); returned once',
    body: z.object({ name: z.string().min(1).max(80).default('key') }),
  }, async (req, { body }) => {
    const agent = await d.requireAgentAdmin(await requireActor(req), req.params.id);
    return mintApiKey(agent.id, body.name);
  });

  // ---- projects ----
  route(app, 'GET', '/api/projects', { section: 'Projects', summary: 'projects you can access, with their board columns', agent: true }, async (req) =>
    d.listProjects(await requireActor(req)),
  );
  route(app, 'POST', '/api/orgs/:org/projects', {
    section: 'Projects',
    summary: 'create a project (admins)',
    body: z.object({
      name: z.string().min(1).max(80),
      key: projectKey.optional().describe('defaults to the first three letters of the name'),
      description: z.string().max(2000).optional(),
      columns: z.array(z.string().max(40)).max(12).optional().describe('board columns in order; the last means done'),
    }),
  }, async (req, { body }) => d.createProject(await requireActor(req), req.params.org, body));
  route(app, 'GET', '/api/projects/:org/:key', { section: 'Projects', summary: 'a board: the project and its items', agent: true }, async (req) => {
    const project = await d.resolveProject(await requireActor(req), `${req.params.org}/${req.params.key}`);
    return { project, items: await d.listItems(project) };
  });
  route(app, 'GET', '/api/projects/:org/:key/timeline', {
    section: 'Projects',
    summary: 'what happened in a project, newest first (50 per page)',
    query: z.object({ before: z.coerce.number().optional().describe('event id, for the next page') }),
    agent: true,
  }, async (req, { query }) => {
    const project = await d.resolveProject(await requireActor(req), `${req.params.org}/${req.params.key}`);
    return d.timeline(project, { before: query.before });
  });

  // ---- items (refs contain a slash, so they are wildcard segments) ----
  route(app, 'POST', '/api/projects/:org/:key/items', {
    section: 'Items',
    summary: 'create an issue, or a task under an issue',
    body: z.object({
      type: z.enum(['issue', 'task']),
      title: z.string().min(1).max(300),
      body: z.string().max(50_000).optional().describe('Markdown'),
      parent: z.string().optional().describe('tasks only: the issue it belongs to (same project)'),
      assignee,
      status: z.string().optional().describe('a board column; defaults to the first'),
      triggeredBy: z.string().optional().describe('item that caused this one, in any project; the link is permanent'),
    }),
    agent: true,
  }, async (req, { body }) => {
    const actor = await requireActor(req);
    const project = await d.resolveProject(actor, `${req.params.org}/${req.params.key}`);
    return d.createItem(actor, project, { ...body, parentRef: body.parent });
  });
  route(app, 'GET', '/api/items/*', {
    section: 'Items',
    summary: 'an item with its project columns, parent, tasks, links, comments and history',
    wildcard: 'ref',
    agent: true,
  }, async (req) => d.itemDetail(await requireActor(req), req.params['*']));
  route(app, 'PATCH', '/api/items/*', {
    section: 'Items',
    summary: 'update an item; moving it to the last column marks it done',
    wildcard: 'ref',
    body: z.object({
      title: z.string().max(300).optional(),
      body: z.string().max(50_000).optional().describe('Markdown'),
      status: z.string().optional().describe('a board column'),
      assignee,
      position: z.number().optional().describe('order within the column'),
    }),
    agent: true,
  }, async (req, { body }) => d.updateItem(await requireActor(req), req.params['*'], body));
  route(app, 'POST', '/api/comments/*', {
    section: 'Items',
    summary: 'comment on an item',
    wildcard: 'ref',
    body: z.object({ body: z.string().min(1).max(50_000).describe('Markdown') }),
    agent: true,
  }, async (req, { body }) => d.addComment(await requireActor(req), req.params['*'], body.body));
  route(app, 'POST', '/api/links', {
    section: 'Items',
    summary: 'link two items, in any projects',
    body: z.object({
      from: z.string().describe('item ref'),
      to: z.string().describe('item ref'),
      kind: z.enum(['triggered', 'blocks', 'relates']).describe('blocks: from must finish before to; triggered: from caused to (permanent)'),
    }),
    agent: true,
  }, async (req, { body }) => d.addLink(await requireActor(req), body.from, body.to, body.kind));
  route(app, 'DELETE', '/api/links/:id', { section: 'Items', summary: 'remove a blocks/relates link (triggered links are permanent)', agent: true }, async (req) => {
    await d.removeLink(await requireActor(req), req.params.id);
    return { ok: true };
  });
  route(app, 'GET', '/api/search', {
    section: 'Items',
    summary: 'search items by title, description or ref',
    query: z.object({ q: z.string().describe('at least 2 characters') }),
    agent: true,
  }, async (req, { query }) => {
    const q = query.q.trim();
    if (q.length < 2) throw badRequest('Query too short');
    return d.search(await requireActor(req), q);
  });

  route(app, 'GET', '/api/help', { section: 'Reference', summary: 'this reference, generated from the running server' }, async (_req, _input, reply) =>
    reply.type('text/plain').send(fullReference(config.publicUrl)),
  );
}

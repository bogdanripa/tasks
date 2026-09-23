import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql } from './db.js';
import { mintApiKey, requireActor } from './auth.js';
import { badRequest } from './errors.js';
import * as d from './domain.js';
import { config } from './config.js';
import { ROUTINE_INSTRUCTIONS } from './routine.js';

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{1,38}$/, 'lowercase letters, digits and dashes (2–39 chars)');
const projectKey = z.string().regex(/^[A-Za-z][A-Za-z0-9]{1,9}$/, 'letter followed by 1–9 letters/digits');

export function apiRoutes(app: FastifyInstance) {
  app.get('/api/me', async (req) => {
    const actor = await requireActor(req);
    const [me] = await sql`select id, kind, name, email, avatar_url from accounts where id = ${actor.id}`;
    const [{ n }] = await sql`select count(*)::int as n from notifications where account_id = ${actor.id} and read_at is null`;
    return { ...me, orgs: await d.listOrgs(actor), unread: n };
  });

  app.get('/api/me/work', async (req) => {
    const actor = await requireActor(req);
    return d.assignedTo(actor, actor.id);
  });

  // ---- personal API keys (so humans can use the MCP too) ----
  app.get('/api/me/keys', async (req) => d.listKeys((await requireActor(req)).id));
  app.post('/api/me/keys', async (req) => {
    const actor = await requireActor(req);
    const { name } = z.object({ name: z.string().min(1).max(80) }).parse(req.body);
    return mintApiKey(actor.id, name);
  });
  app.delete<{ Params: { id: string } }>('/api/keys/:id', async (req) => {
    await d.revokeKey(await requireActor(req), req.params.id);
    return { ok: true };
  });

  // ---- orgs ----
  app.post('/api/orgs', async (req) => {
    const body = z.object({ slug, name: z.string().min(1).max(80) }).parse(req.body);
    return d.createOrg(await requireActor(req), body);
  });
  app.get<{ Params: { org: string } }>('/api/orgs/:org', async (req) => d.orgDetail(await requireActor(req), req.params.org));
  app.delete<{ Params: { org: string } }>('/api/orgs/:org', async (req) => {
    const { confirm } = z.object({ confirm: z.string() }).parse(req.body ?? {});
    await d.deleteOrg(await requireActor(req), req.params.org, confirm);
    return { ok: true };
  });
  app.post<{ Params: { org: string } }>('/api/orgs/:org/invites', async (req) => {
    const body = z.object({ email: z.email(), role: z.enum(['admin', 'member']).default('member') }).parse(req.body);
    return d.inviteMember(await requireActor(req), req.params.org, body.email, body.role);
  });
  app.post<{ Params: { org: string } }>('/api/orgs/:org/projects', async (req) => {
    const body = z
      .object({ key: projectKey.optional(), name: z.string().min(1).max(80), description: z.string().max(2000).optional(), columns: z.array(z.string().max(40)).max(12).optional() })
      .parse(req.body);
    return d.createProject(await requireActor(req), req.params.org, body);
  });

  // ---- agents ----
  const webhook = z.string().url().nullable().optional().or(z.literal('').transform(() => null));
  app.post<{ Params: { org: string } }>('/api/orgs/:org/agents', async (req) => {
    const actor = await requireActor(req);
    const body = z.object({ name: z.string().min(1).max(80), webhookUrl: webhook }).parse(req.body);
    const agent = await d.createAgent(actor, req.params.org, body);
    const key = await mintApiKey(agent.id, 'default');
    return { agent, key };
  });
  app.patch<{ Params: { id: string } }>('/api/agents/:id', async (req) => {
    const body = z
      .object({
        name: z.string().min(1).max(80).optional(),
        webhookUrl: webhook,
        routineUrl: z.string().max(300).nullable().optional(),
        routineToken: z.string().min(10).max(500).optional(),
      })
      .parse(req.body);
    return d.updateAgent(await requireActor(req), req.params.id, body);
  });
  app.get<{ Params: { id: string } }>('/api/agents/:id', async (req) => {
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
    return {
      agent: {
        id: agent.id,
        name: agent.name,
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
  app.post<{ Params: { id: string } }>('/api/agents/:id/keys', async (req) => {
    const agent = await d.requireAgentAdmin(await requireActor(req), req.params.id);
    const { name } = z.object({ name: z.string().min(1).max(80).default('key') }).parse(req.body ?? {});
    return mintApiKey(agent.id, name);
  });

  // ---- projects ----
  app.get('/api/projects', async (req) => d.listProjects(await requireActor(req)));
  app.get<{ Params: { org: string; key: string } }>('/api/projects/:org/:key', async (req) => {
    const actor = await requireActor(req);
    const project = await d.resolveProject(actor, `${req.params.org}/${req.params.key}`);
    return { project, items: await d.listItems(project) };
  });
  app.get<{ Params: { org: string; key: string }; Querystring: { before?: string } }>('/api/projects/:org/:key/timeline', async (req) => {
    const actor = await requireActor(req);
    const project = await d.resolveProject(actor, `${req.params.org}/${req.params.key}`);
    return d.timeline(project, { before: req.query.before ? Number(req.query.before) : undefined });
  });
  app.post<{ Params: { org: string; key: string } }>('/api/projects/:org/:key/items', async (req) => {
    const actor = await requireActor(req);
    const project = await d.resolveProject(actor, `${req.params.org}/${req.params.key}`);
    const body = z
      .object({
        type: z.enum(['issue', 'task']),
        title: z.string().min(1).max(300),
        body: z.string().max(50_000).optional(),
        parent: z.string().optional(),
        assignee: z.string().nullable().optional(),
        status: z.string().optional(),
        triggeredBy: z.string().optional(),
      })
      .parse(req.body);
    return d.createItem(actor, project, { ...body, parentRef: body.parent });
  });

  // ---- items (ref may contain a slash: org/KEY-N) ----
  app.get<{ Params: { '*': string } }>('/api/items/*', async (req) => d.itemDetail(await requireActor(req), req.params['*']));
  app.patch<{ Params: { '*': string } }>('/api/items/*', async (req) => {
    const body = z
      .object({
        title: z.string().max(300).optional(),
        body: z.string().max(50_000).optional(),
        status: z.string().optional(),
        assignee: z.string().nullable().optional(),
        position: z.number().optional(),
      })
      .parse(req.body);
    return d.updateItem(await requireActor(req), req.params['*'], body);
  });
  app.post<{ Params: { '*': string } }>('/api/comments/*', async (req) => {
    const { body } = z.object({ body: z.string().min(1).max(50_000) }).parse(req.body);
    return d.addComment(await requireActor(req), req.params['*'], body);
  });
  app.post('/api/links', async (req) => {
    const body = z.object({ from: z.string(), to: z.string(), kind: z.enum(['triggered', 'blocks', 'relates']) }).parse(req.body);
    return d.addLink(await requireActor(req), body.from, body.to, body.kind);
  });
  app.delete<{ Params: { id: string } }>('/api/links/:id', async (req) => {
    await d.removeLink(await requireActor(req), req.params.id);
    return { ok: true };
  });

  app.get<{ Querystring: { q?: string } }>('/api/search', async (req) => {
    const q = (req.query.q ?? '').trim();
    if (q.length < 2) throw badRequest('Query too short');
    return d.search(await requireActor(req), q);
  });

  // Plain-text API reference for agents working with curl (routine runs link here).
  app.get('/api/help', async (_req, reply) => {
    const b = config.publicUrl;
    reply.type('text/plain').send(`Tasks REST API. Send Authorization: Bearer <token> and, for bodies, content-type: application/json.
Items are referenced as org/KEY-N (e.g. demo/WEB-12). Projects as org/KEY.

GET    ${b}/api/me                                  you, your orgs, unread count
GET    ${b}/api/me/work                             open items assigned to you
GET    ${b}/api/projects                            projects you can access (with board columns)
GET    ${b}/api/projects/{org}/{KEY}                a board: project + its items
GET    ${b}/api/projects/{org}/{KEY}/timeline       what happened in a project, newest first
GET    ${b}/api/orgs/{org}                          projects, members (humans and agents) of an org
GET    ${b}/api/items/{org}/{KEY-N}                 an item with tasks, links, comments, history
POST   ${b}/api/projects/{org}/{KEY}/items          {"type":"issue"|"task","title","body"?,"parent"? (issue ref, for tasks),
                                                     "assignee"? (member name/email/id),"status"?,"triggeredBy"? (item ref)}
PATCH  ${b}/api/items/{org}/{KEY-N}                 {"title"?,"body"?,"status"?,"assignee"? (null to unassign)}
POST   ${b}/api/comments/{org}/{KEY-N}              {"body"}
POST   ${b}/api/links                               {"from","to","kind":"triggered"|"blocks"|"relates"}
GET    ${b}/api/search?q=...                        search items by title, description or ref
GET    ${b}/api/inbox?unread=1                      your notifications
`);
  });

  // ---- inbox ----
  app.get<{ Querystring: { unread?: string } }>('/api/inbox', async (req) =>
    d.inbox(await requireActor(req), { unreadOnly: req.query.unread === '1' }),
  );
  app.post('/api/inbox/read', async (req) => {
    const { ids } = z.object({ ids: z.union([z.array(z.number()), z.literal('all')]) }).parse(req.body);
    await d.markRead(await requireActor(req), ids);
    return { ok: true };
  });
}

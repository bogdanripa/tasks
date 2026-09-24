import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql } from './db.js';
import { mintApiKey, requireActor } from './auth.js';
import { badRequest, notFound } from './errors.js';
import * as d from './domain.js';
import { config } from './config.js';
import { endRunById, routineInstructions } from './routine.js';
import { PIPELINE_TEMPLATE } from './starter.js';
import { fullReference, route } from './apidoc.js';
import * as sched from './schedules.js';
import * as llm from './llm.js';
import * as github from './github.js';

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{1,38}$/, 'lowercase letters, digits and dashes (2–39 chars)');
const projectKey = z.string().regex(/^[A-Za-z][A-Za-z0-9]{1,9}$/, 'letter followed by 1–9 letters/digits');
const assignee = z.string().nullable().optional().describe('member name, email or id; null to unassign');
const skill = z.string().max(31).nullable().optional().describe('skill the work needs, e.g. "backend"; routes it to a member with that skill when unassigned');
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
    body: z.object({
      slug,
      name: z.string().min(1).max(80),
      starterAgents: z.boolean().optional().describe('add a PM, Dev and QA agent with skills (default true)'),
    }),
  }, async (req, { body }) => d.createOrg(await requireActor(req), body));
  route(app, 'GET', '/api/orgs/:org', {
    section: 'Organizations',
    summary: 'an organization: projects, members (humans and agents), pending invites',
    agent: true,
  }, async (req) => d.orgDetail(await requireActor(req), req.params.org));
  route(app, 'PATCH', '/api/orgs/:org', {
    section: 'Organizations',
    summary: 'rename an organization or edit its guidelines (admins)',
    body: z.object({
      name: z.string().min(1).max(80).optional(),
      guidelines: z.string().max(20_000).optional().describe('Markdown; sent to agents with every run in this organization'),
    }),
  }, async (req, { body }) => d.updateOrg(await requireActor(req), req.params.org, body));
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
  route(app, 'PATCH', '/api/orgs/:org/members/:id', {
    section: 'Organizations',
    summary: 'set a member’s skills (admins) or role (owners); work waiting for those skills is routed',
    body: z.object({
      skills: z.array(z.string().max(31)).max(20).optional().describe('e.g. ["backend", "db"]'),
      role: z.enum(['owner', 'admin', 'member']).optional(),
    }),
  }, async (req, { body }) => d.updateMember(await requireActor(req), req.params.org, req.params.id, body));
  route(app, 'DELETE', '/api/orgs/:org/members/:id', {
    section: 'Organizations',
    summary: 'remove a member or agent, or leave (your own id); their open items are unassigned',
  }, async (req) => d.removeMember(await requireActor(req), req.params.org, req.params.id));

  // ---- AI providers (for agents Tasks runs itself) ----
  route(app, 'GET', '/api/orgs/:org/ai-providers', { section: 'AI providers', summary: 'the organization’s LLM providers (keys are never returned)' }, async (req) =>
    llm.listProviders(await requireActor(req), req.params.org),
  );
  route(app, 'POST', '/api/orgs/:org/ai-providers', {
    section: 'AI providers',
    summary: 'add an LLM provider key (admins); it’s tested against the provider, then stored encrypted',
    body: z.object({
      provider: z.enum(llm.PROVIDERS),
      apiKey: z.string().min(8).max(500),
      label: z.string().max(60).optional(),
      baseUrl: z.string().url().optional().describe('openai-compatible only, e.g. https://openrouter.ai/api/v1'),
    }),
  }, async (req, { body }) => llm.addProvider(await requireActor(req), req.params.org, body));
  route(app, 'GET', '/api/orgs/:org/ai-providers/:id/models', { section: 'AI providers', summary: 'models a provider key can use (also tests the key)' }, async (req) =>
    llm.providerModels(await requireActor(req), req.params.org, req.params.id),
  );
  route(app, 'DELETE', '/api/orgs/:org/ai-providers/:id', { section: 'AI providers', summary: 'remove a provider (admins); agents using it stop until given another' }, async (req) => {
    await llm.deleteProvider(await requireActor(req), req.params.org, req.params.id);
    return { ok: true };
  });

  // ---- GitHub ----
  route(app, 'GET', '/api/orgs/:org/github', { section: 'GitHub', summary: 'whether the org has the Tasks GitHub App installed, and which repositories it can reach' }, async (req) =>
    github.orgGithub(await requireActor(req), req.params.org),
  );
  route(app, 'GET', '/api/orgs/:org/github/install', { section: 'GitHub', summary: 'start installing the Tasks GitHub App for this org (admins; redirects to GitHub)' }, async (req, _input, reply) => {
    const { url, cookie } = await github.installStart(await requireActor(req), req.params.org);
    reply.setCookie(cookie.name, cookie.value, { path: '/api/github', httpOnly: true, sameSite: 'lax', secure: config.production, maxAge: 900 });
    return reply.redirect(url);
  });
  route(app, 'GET', '/api/github/callback', {
    section: 'GitHub',
    summary: 'where GitHub returns after installing the app (links the installation to the org)',
    query: z.object({ code: z.string().optional(), installation_id: z.string().optional(), setup_action: z.string().optional() }),
  }, async (req, { query }, reply) => {
    const actor = await requireActor(req);
    try {
      const slug = await github.installCallback(actor, query, req.cookies.gh_install);
      reply.clearCookie('gh_install', { path: '/api/github' });
      return reply.redirect(`/app/${slug}/settings?tab=github`);
    } catch (e) {
      return reply.redirect(`/app/?github_error=${encodeURIComponent((e as Error).message)}`);
    }
  });
  route(app, 'DELETE', '/api/orgs/:org/github', { section: 'GitHub', summary: 'unlink the org from its GitHub installation (admins; uninstall on GitHub separately)' }, async (req) => {
    await github.disconnectGithub(await requireActor(req), req.params.org);
    return { ok: true };
  });
  route(app, 'PATCH', '/api/projects/:org/:key/github', {
    section: 'GitHub',
    summary: 'set the project’s repository, development branch and production branch (admins)',
    body: z.object({
      repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'owner/name').nullable(),
      base: z.string().max(100).optional().describe('development branch: where work starts and lands (e.g. dev, deployed to staging)'),
      prod: z.string().max(100).optional().describe('production branch; the same as base means working directly on it, with no release step'),
    }),
  }, async (req, { body }) => github.setProjectRepo(await requireActor(req), `${req.params.org}/${req.params.key}`, body));
  route(app, 'POST', '/api/github/webhook', { section: 'GitHub', summary: 'GitHub App webhook (signed by GitHub): PRs and commits that mention KEY-N go into that item’s history' }, async (req, _input, reply) => {
    const raw = (req as { rawBody?: string }).rawBody ?? '';
    if (!github.verifyWebhook(raw, req.headers['x-hub-signature-256'] as string | undefined)) return reply.code(401).send({ error: 'Bad signature' });
    return github.handleWebhook(String(req.headers['x-github-event'] ?? ''), req.body);
  });

  // ---- agents ----
  route(app, 'POST', '/api/orgs/:org/agents', {
    section: 'Agents',
    summary: 'create an agent (admins); returns it with an API key, shown once',
    body: z.object({ name: z.string().min(1).max(80), webhookUrl: webhook }),
  }, async (req, { body }) => {
    const agent = await d.createAgent(await requireActor(req), req.params.org, body);
    return { agent, key: await mintApiKey(agent.id, 'default') };
  });
  route(app, 'POST', '/api/orgs/:org/starter-team', {
    section: 'Agents',
    summary: 'add the starter team (PM, Lead, Dev, QA) with skills and roles, skipping names already taken; optionally run them in Tasks (admins)',
    body: z.object({ runtime: z.object({ providerId: z.string(), model: z.string().min(1) }).nullable().optional() }),
  }, async (req, { body }) => d.addStarterTeam(await requireActor(req), req.params.org, body.runtime));
  route(app, 'GET', '/api/agents/:id', { section: 'Agents', summary: 'an agent’s settings, keys, runs, queue and recent notifications (admins)' }, async (req) => {
    const agent = await d.requireAgentAdmin(await requireActor(req), req.params.id);
    const [deliveries, runs, [queue], [pause]] = await Promise.all([
      sql`
        select n.id, n.reason, n.delivery_status, n.attempts, n.last_error, n.created_at, n.read_at, n.next_attempt_at, v.ref as item_ref,
               coalesce(lower(v.status) = 'backlog', false) as item_in_backlog,
               exists (select 1 from links l join items b on b.id = l.from_id
                       where l.to_id = n.item_id and l.kind = 'blocks' and l.removed_at is null and b.closed_at is null) as item_blocked
        from notifications n left join item_view v on v.id = n.item_id
        where n.account_id = ${agent.id} order by n.id desc limit 30`,
      sql`
        select r.id, r.status, r.reasons, r.session_url, r.error, r.created_at, r.finished_at, v.ref as item_ref, v.title as item_title,
               k.last_used_at, r.runtime, r.model, r.steps, r.input_tokens, r.output_tokens
        from agent_runs r left join item_view v on v.id = r.item_id left join api_keys k on k.id = r.key_id
        where r.agent_id = ${agent.id} order by r.created_at desc limit 20`,
      sql`
        select count(*)::int as updates, count(distinct n.item_id)::int as items, min(n.next_attempt_at) as next_at
        from notifications n left join item_view v on v.id = n.item_id
        where n.account_id = ${agent.id} and n.delivery_status = 'pending' and coalesce(lower(v.status), '') <> 'backlog'`,
      sql`select until, reason from routine_pauses where org_id = ${agent.orgId} and until > now()`,
    ]);
    const [{ slug: orgSlug }] = await sql`select slug from orgs where id = ${agent.orgId}`;
    const [{ skills }] = await sql`select skills from memberships where org_id = ${agent.orgId} and account_id = ${agent.id}`;
    const orgSkills = await sql`select distinct unnest(skills) as s from memberships where org_id = ${agent.orgId}`;
    return {
      agent: {
        id: agent.id,
        name: agent.name,
        orgSlug,
        webhookUrl: agent.webhookUrl,
        webhookSecret: agent.webhookSecret,
        routineUrl: agent.routineUrl,
        hasRoutineToken: !!agent.routineTokenEnc,
        description: agent.description,
        runtime: agent.runtimeProviderId ? { providerId: agent.runtimeProviderId, model: agent.runtimeModel, maxSteps: agent.runtimeMaxSteps } : null,
        skills,
        skillSuggestions: [...new Set([...d.SUGGESTED_SKILLS, ...orgSkills.map((r) => r.s as string)])].sort(),
      },
      keys: await d.listKeys(agent.id),
      deliveries,
      runs,
      queue,
      pause: pause ?? null,
      routine: { instructions: routineInstructions(agent.description), allowDomain: new URL(config.publicUrl).host },
    };
  });
  route(app, 'PATCH', '/api/agents/:id', {
    section: 'Agents',
    summary: 'rename an agent or change how it gets work (admins)',
    body: z.object({
      name: z.string().min(1).max(80).optional(),
      description: z.string().max(4000).optional().describe('the agent’s role and hard limits; fills its routine Instructions'),
      webhookUrl: webhook,
      routineUrl: z.string().max(300).nullable().optional().describe('Claude Code routine /fire URL or routine id; null to remove'),
      routineToken: z.string().min(10).max(500).optional().describe('the routine’s API token; stored encrypted'),
      runtime: z
        .object({ providerId: z.string().uuid(), model: z.string().min(1).max(120), maxSteps: z.number().int().min(3).max(200).optional() })
        .nullable()
        .optional()
        .describe('run the agent in Tasks with this provider and model; null to stop'),
    }),
  }, async (req, { body }) => d.updateAgent(await requireActor(req), req.params.id, body));
  route(app, 'DELETE', '/api/agents/:id', {
    section: 'Agents',
    summary: 'delete (deactivate) an agent: keys revoked, open items unassigned, history kept (admins)',
  }, async (req) => d.deleteAgent(await requireActor(req), req.params.id));
  route(app, 'POST', '/api/agents/:id/runs/:run/end', {
    section: 'Agents',
    summary: 'end one of an agent’s runs by hand, e.g. when it’s stuck (admins); the agent’s queue moves on',
  }, async (req) => {
    const actor = await requireActor(req);
    await d.requireAgentAdmin(actor, req.params.id);
    return { ended: await endRunById(req.params.run, actor.name) };
  });
  route(app, 'GET', '/api/runs/:id', { section: 'Agents', summary: 'an in-house run: its prompt, the model’s messages, tool calls and results' }, async (req) => {
    const actor = await requireActor(req);
    const [run] = await sql`
      select r.*, a.name as agent_name, a.org_id, v.ref as item_ref, v.title as item_title
      from agent_runs r join accounts a on a.id = r.agent_id left join item_view v on v.id = r.item_id where r.id = ${req.params.id}`;
    if (!run || !(await d.orgRole(actor.id, run.orgId))) throw notFound('Run');
    const steps = await sql`select id, kind, content, created_at from run_steps where run_id = ${run.id} order by id`;
    return { run, steps };
  });
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
      setup: z.enum(['agents', 'blank']).optional().describe('agents: Todo routes to product and guidelines start from the agent pipeline (default when the org has product, build and qa skills)'),
    }),
  }, async (req, { body }) => d.createProject(await requireActor(req), req.params.org, body));
  route(app, 'GET', '/api/projects/:org/:key', { section: 'Projects', summary: 'a board: the project and its items', agent: true }, async (req) => {
    const project = await d.resolveProject(await requireActor(req), `${req.params.org}/${req.params.key}`);
    return { project, items: await d.listItems(project) };
  });
  route(app, 'PATCH', '/api/projects/:org/:key', {
    section: 'Projects',
    summary: 'edit a project: name, description, guidelines, board columns (admins)',
    body: z.object({
      name: z.string().min(1).max(80).optional(),
      description: z.string().max(2000).optional(),
      guidelines: z.string().max(20_000).optional().describe('Markdown; sent to agents with every run on this project'),
      columns: z
        .array(
          z.object({
            name: z.string().max(40),
            from: z.string().nullable().optional().describe('existing column this one was; omit for a new column'),
            skill: z.string().max(31).nullable().optional().describe('default skill: unassigned items here go to a member with it'),
            handoff: z.string().max(31).nullable().optional().describe('hand tasks entering this column to a member with this skill (not the author), e.g. Review → review; sent back, they return to the author'),
          }),
        )
        .max(12)
        .optional()
        .describe('the full new list in order; the last means done; removed columns must be empty'),
    }),
  }, async (req, { body }) => d.updateProject(await requireActor(req), `${req.params.org}/${req.params.key}`, body));
  route(app, 'DELETE', '/api/projects/:org/:key', {
    section: 'Projects',
    summary: 'delete a project and everything in it (admins)',
    body: z.object({ confirm: z.string().describe('the project key, repeated') }),
  }, async (req, { body }) => {
    await d.deleteProject(await requireActor(req), `${req.params.org}/${req.params.key}`, body.confirm);
    return { ok: true };
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

  // ---- recurring items ----
  const scheduleBody = z.object({
    name: z.string().min(1).max(80),
    cron: z.string().min(9).max(100).describe('5-field cron, e.g. "0 9 * * *" = every day at 9:00'),
    timezone: z.string().min(1).max(60).describe('IANA timezone, e.g. Europe/Bucharest'),
    enabled: z.boolean().optional(),
    title: z.string().min(1).max(300).describe('{date} and {weekday} are filled in'),
    body: z.string().max(50_000).optional().describe('Markdown; {date} and {weekday} are filled in'),
    status: z.string().nullable().optional().describe('column to add it to; defaults to the first'),
    assignee: assignee,
    parent: z.string().nullable().optional().describe('issue ref: create a task under it instead of an issue'),
    skipIfOpen: z.boolean().optional().describe('skip a run while the previous item is still open'),
  });
  route(app, 'GET', '/api/projects/:org/:key/schedules', { section: 'Recurring items', summary: 'a project’s recurring schedules' }, async (req) =>
    sched.listSchedules(await requireActor(req), `${req.params.org}/${req.params.key}`),
  );
  route(app, 'POST', '/api/projects/:org/:key/schedules', {
    section: 'Recurring items',
    summary: 'create a schedule that adds an item on a timer (admins)',
    body: scheduleBody,
  }, async (req, { body }) => sched.createSchedule(await requireActor(req), `${req.params.org}/${req.params.key}`, body));
  route(app, 'PATCH', '/api/schedules/:id', {
    section: 'Recurring items',
    summary: 'replace a schedule’s settings (admins); you become its owner',
    body: scheduleBody,
  }, async (req, { body }) => sched.updateSchedule(await requireActor(req), req.params.id, body));
  route(app, 'DELETE', '/api/schedules/:id', { section: 'Recurring items', summary: 'delete a schedule (admins)' }, async (req) => {
    await sched.deleteSchedule(await requireActor(req), req.params.id);
    return { ok: true };
  });
  route(app, 'POST', '/api/schedules/:id/run', { section: 'Recurring items', summary: 'run a schedule now (admins)' }, async (req) =>
    sched.runScheduleNow(await requireActor(req), req.params.id),
  );

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
      skill,
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
      skill,
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
  route(app, 'POST', '/api/runs/end', {
    section: 'Items',
    summary: 'end your routine run without changing the task’s status (e.g. an issue now waiting on its tasks)',
    agent: true,
  }, async (req) => d.endRun(await requireActor(req)));
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

  route(app, 'GET', '/api/templates/agent-pipeline', { section: 'Reference', summary: 'the agent pipeline project guidelines template (Markdown)' }, async (_req, _input, reply) =>
    reply.type('text/markdown; charset=utf-8').send(PIPELINE_TEMPLATE),
  );
  route(app, 'GET', '/api/help', { section: 'Reference', summary: 'this reference, generated from the running server' }, async (_req, _input, reply) =>
    reply.type('text/plain').send(fullReference(config.publicUrl)),
  );
}

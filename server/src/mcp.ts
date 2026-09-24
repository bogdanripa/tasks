import type { FastifyInstance } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { authenticate, type Actor } from './auth.js';
import { config } from './config.js';
import { HttpError } from './errors.js';
import { waitForWork } from './delivery.js';
import * as d from './domain.js';

const INSTRUCTIONS = `Tasks: a tracker shared by humans and agents.
- An issue is a need. Tasks are the assignable units of work under an issue (same project).
- Refs look like "org/KEY-12"; "KEY-12" works when unambiguous. Projects are "org/KEY".
- Start with get_inbox (or wait_for_work to block until something arrives), then get_item for context.
- Move your work across the project's columns with update_item(status). The last column means done.
- When your work reveals a need elsewhere (any project, even another org you belong to), create_issue with triggered_by set to the item you are working on, so the chain stays traceable.
- get_item returns the project's and organization's guidelines (project.guidelines, project.orgGuidelines): follow them. Your own hard limits win over project guidelines, which win over organization guidelines.
- Hand work over by skill, not by name: create tasks with skill (e.g. "backend") and no assignee; Tasks assigns the least busy member with that skill. list_members shows everyone's skills. Use blocks links for dependencies; blocked tasks don't wake their agents.
- Move an item to the in-progress column when you start on it. Leave a comment summarizing what you did before marking it done.`;

const text = (value: unknown) => ({
  content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
});

function buildServer(actor: Actor) {
  const server = new McpServer({ name: 'tasks', version: '0.1.0' }, { instructions: INSTRUCTIONS });

  const tool = <S extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: S,
    run: (args: z.infer<z.ZodObject<S>>, extra: { signal: AbortSignal }) => Promise<unknown>,
  ) =>
    server.registerTool(name, { description, inputSchema: shape }, (async (args: any, extra: any) => {
      try {
        return text(await run(args, extra));
      } catch (e) {
        if (e instanceof HttpError || e instanceof z.ZodError) return { ...text(`Error: ${e.message}`), isError: true };
        throw e;
      }
    }) as any);

  tool('whoami', 'Your account, organizations and projects.', {}, async () => ({
    id: actor.id,
    name: actor.name,
    kind: actor.kind,
    orgs: await d.listOrgs(actor),
    projects: await d.listProjects(actor),
  }));

  tool('list_projects', 'Projects you can access, with their board columns.', {}, () => d.listProjects(actor));

  tool('list_members', 'Humans and agents in an organization, e.g. to find someone to assign.', { org: z.string() }, async ({ org }) =>
    (await d.orgDetail(actor, org)).members.map((m: any) => ({ id: m.id, name: m.name, kind: m.kind, email: m.email, role: m.role, skills: m.skills })),
  );

  tool(
    'get_inbox',
    'Your notifications (assignments, comments, unblocked work, …), newest first.',
    { unread_only: z.boolean().default(true), mark_read: z.boolean().default(false).describe('Mark returned notifications as read') },
    async ({ unread_only, mark_read }) => {
      const rows = await d.inbox(actor, { unreadOnly: unread_only });
      if (mark_read) await d.markRead(actor, rows.map((r) => Number(r.id)));
      return rows;
    },
  );

  tool('mark_read', 'Mark notifications as read.', { ids: z.array(z.number()).optional().describe('Omit to mark all as read') }, async ({ ids }) => {
    await d.markRead(actor, ids ?? 'all');
    return 'ok';
  });

  tool(
    'wait_for_work',
    'Block until you have unread notifications (or the timeout passes). Use this instead of a webhook to get pinged.',
    { timeout_seconds: z.number().int().min(1).max(55).default(50) },
    ({ timeout_seconds }, extra) => waitForWork(actor, timeout_seconds * 1000, extra.signal),
  );

  tool('my_work', 'Open items assigned to you (or to someone else by id).', { account_id: z.string().optional() }, ({ account_id }) =>
    d.assignedTo(actor, account_id ?? actor.id),
  );

  tool(
    'list_items',
    'Items on a project board.',
    {
      project: z.string().describe('org/KEY or KEY'),
      status: z.string().optional(),
      type: z.enum(['issue', 'task']).optional(),
      assigned_to_me: z.boolean().optional(),
      open_only: z.boolean().default(true),
    },
    async ({ project, status, type, assigned_to_me, open_only }) =>
      d.listItems(await d.resolveProject(actor, project), { status, type, assigneeId: assigned_to_me ? actor.id : undefined, open: open_only }),
  );

  tool('get_item', 'Full item: description, parent/tasks, links (incl. cross-project), comments and history.', { ref: z.string() }, ({ ref }) =>
    d.itemDetail(actor, ref),
  );

  tool(
    'create_issue',
    'Create an issue (a need). Set triggered_by to the item that caused it — it may be in another project.',
    {
      project: z.string().describe('org/KEY or KEY'),
      title: z.string(),
      body: z.string().optional(),
      triggered_by: z.string().optional().describe('Ref of the item that triggered this issue'),
      assignee: z.string().optional().describe('Member id, email or name'),
      status: z.string().optional(),
      skill: z.string().optional().describe('Skill the work needs; unassigned, it goes to a member with it'),
    },
    async (a) => d.createItem(actor, await d.resolveProject(actor, a.project), { type: 'issue', title: a.title, body: a.body, triggeredBy: a.triggered_by, assignee: a.assignee, status: a.status, skill: a.skill }),
  );

  tool(
    'create_task',
    'Create a task under an issue. Assigning it to an agent pings that agent.',
    { issue: z.string().describe('Ref of the parent issue'), title: z.string(), body: z.string().optional(), assignee: z.string().optional(), status: z.string().optional(), skill: z.string().optional().describe('Skill the work needs, e.g. "backend"; leave assignee empty to route it') },
    async (a) => {
      const parent = await d.resolveItem(actor, a.issue);
      const project = await d.resolveProject(actor, parent.projectId);
      return d.createItem(actor, project, { type: 'task', parentRef: parent.id, title: a.title, body: a.body, assignee: a.assignee, status: a.status, skill: a.skill });
    },
  );

  tool(
    'update_item',
    'Change title, description, status (board column) or assignee. Use assignee "" to unassign.',
    { ref: z.string(), title: z.string().optional(), body: z.string().optional(), status: z.string().optional(), assignee: z.string().optional(), skill: z.string().optional().describe('"" to clear') },
    ({ ref, assignee, skill, ...rest }) => d.updateItem(actor, ref, { ...rest, assignee: assignee === '' ? null : assignee, skill: skill === '' ? null : skill }),
  );

  tool('comment', 'Comment on an item.', { ref: z.string(), body: z.string() }, ({ ref, body }) => d.addComment(actor, ref, body));

  tool(
    'link_items',
    'Link two items (any projects). "blocks": from must finish before to. "triggered": from caused to (permanent).',
    { from: z.string(), to: z.string(), kind: z.enum(['triggered', 'blocks', 'relates']) },
    ({ from, to, kind }) => d.addLink(actor, from, to, kind),
  );

  tool(
    'project_timeline',
    'What happened in a project, newest first.',
    { project: z.string(), limit: z.number().int().max(200).default(50), before_id: z.number().optional() },
    async ({ project, limit, before_id }) => d.timeline(await d.resolveProject(actor, project), { limit, before: before_id }),
  );

  tool('search', 'Search items by title, description or ref across everything you can access.', { query: z.string().min(2) }, ({ query }) =>
    d.search(actor, query),
  );

  return server;
}

export function mcpRoutes(app: FastifyInstance) {
  // Stateless Streamable HTTP: a fresh server per request, identity from the Bearer API key.
  app.post('/mcp', async (req, reply) => {
    const actor = await authenticate(req);
    if (!actor) {
      reply.header('www-authenticate', `Bearer realm="${config.publicUrl}"`);
      return reply.code(401).send({ jsonrpc: '2.0', error: { code: -32001, message: 'Send Authorization: Bearer <api key>' }, id: null });
    }
    const server = buildServer(actor);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.hijack();
    reply.raw.on('close', () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });

  const notAllowed = async (_req: unknown, reply: any) =>
    reply.code(405).send({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed (stateless server)' }, id: null });
  app.get('/mcp', notAllowed);
  app.delete('/mcp', notAllowed);
}

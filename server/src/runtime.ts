import { generateText, stepCountIs, tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { sql, bus } from './db.js';
import type { Actor } from './auth.js';
import { HttpError } from './errors.js';
import * as d from './domain.js';
import { languageModel, providerFor } from './llm.js';
import { releaseRun } from './routine.js';
import { repoOps, type RunRepo } from './github.js';

/**
 * Agents that Tasks runs itself: an LLM with Tasks' own actions as tools, driven by the same payload
 * a Claude Code routine gets. Runs are I/O-bound (waiting on the provider), so a few run at once.
 */
const MAX_CONCURRENT = 3;
const RUN_TIMEOUT_MS = 30 * 60_000;
const MAX_TOOL_OUTPUT = 20_000;
const MAX_ATTEMPTS = 3;
let active = 0;

export const inHouseFull = () => active >= MAX_CONCURRENT;

export const REPO_TOOL_NAMES = ['repo_list_files', 'repo_read_file', 'repo_write_files', 'repo_open_pull_request', 'repo_merge_pull_request', 'repo_publish_pages'];

/** Git tools for the run's repository (a token limited to that one repository). */
function repoTools(r: RunRepo, wrap: <A>(fn: (a: A) => Promise<unknown>) => (a: A) => Promise<string>): ToolSet {
  const ops = repoOps(r);
  return {
    repo_list_files: tool({
      description: `All file paths in ${r.repo} on a branch (default ${r.base}).`,
      inputSchema: z.object({ branch: z.string().optional() }),
      execute: wrap(({ branch }: any) => ops.listFiles(branch)),
    }),
    repo_read_file: tool({
      description: 'The text of one file.',
      inputSchema: z.object({ path: z.string(), branch: z.string().optional() }),
      execute: wrap(({ path, branch }: any) => ops.readFile(path, branch)),
    }),
    repo_write_files: tool({
      description: `Create or replace files on a branch (created from ${r.base} if it doesn't exist). Give each file's full new content.`,
      inputSchema: z.object({ branch: z.string(), message: z.string(), files: z.array(z.object({ path: z.string(), content: z.string() })).min(1) }),
      execute: wrap(({ branch, message, files }: any) => ops.writeFiles(branch, message, files)),
    }),
    repo_open_pull_request: tool({
      description: `Open a pull request from a branch into ${r.base}.`,
      inputSchema: z.object({ branch: z.string(), title: z.string(), body: z.string() }),
      execute: wrap(({ branch, title, body }: any) => ops.openPullRequest(branch, title, body)),
    }),
    repo_merge_pull_request: tool({
      description: `Merge (squash) a pull request into ${r.base}.${r.delivery === 'pr' ? ' This project delivers by pull request: only merge if the guidelines or a human say so.' : ''}`,
      inputSchema: z.object({ number: z.number().int() }),
      execute: wrap(({ number }: any) => ops.mergePullRequest(number)),
    }),
    repo_publish_pages: tool({
      description: `Publish ${r.base} as a website with GitHub Pages (a static site: index.html at the root, or in /docs) and get its URL. It can take a minute to go live.`,
      inputSchema: z.object({ folder: z.enum(['/', '/docs']).optional() }),
      execute: wrap(({ folder }: any) => ops.publishPages(folder ?? '/')),
    }),
  };
}

/** The tools an in-house agent works with, acting as the agent (so the usual rules apply). */
export const TASK_TOOL_NAMES = ['get_item', 'update_item', 'comment', 'create_issue', 'create_task', 'link_items', 'list_items', 'search', 'list_members', 'end_run'];

function taskTools(actor: Actor, repo: RunRepo | null): ToolSet {
  const wrap =
    <A,>(fn: (a: A) => Promise<unknown>) =>
    async (a: A) => {
      try {
        const out = JSON.stringify((await fn(a)) ?? { ok: true });
        return out.length > MAX_TOOL_OUTPUT ? `${out.slice(0, MAX_TOOL_OUTPUT)}… (truncated)` : out;
      } catch (e) {
        if (e instanceof HttpError || e instanceof z.ZodError) return JSON.stringify({ error: e.message });
        throw e;
      }
    };
  const ref = z.string().describe('item reference, e.g. acme/WEB-12 or WEB-12');
  return {
    get_item: tool({
      description: 'An item with its project columns and guidelines, parent, tasks, links, comments and recent history.',
      inputSchema: z.object({ ref }),
      execute: wrap(async ({ ref }: { ref: string }) => {
        const detail = await d.itemDetail(actor, ref);
        return { ...detail, history: detail.history.slice(0, 30) };
      }),
    }),
    update_item: tool({
      description: 'Change status (a board column), title, description (Markdown), assignee (member name; "" to unassign) or needed skill.',
      inputSchema: z.object({
        ref,
        status: z.string().optional(),
        title: z.string().optional(),
        body: z.string().optional(),
        assignee: z.string().optional(),
        skill: z.string().optional(),
      }),
      execute: wrap(async ({ ref, assignee, skill, ...rest }: any) => {
        const item = await d.updateItem(actor, ref, { ...rest, assignee: assignee === '' ? null : assignee, skill: skill === '' ? null : skill });
        return { ref: item.ref, status: item.status, assignee: item.assigneeName, done: item.done };
      }),
    }),
    comment: tool({
      description: 'Comment on an item (Markdown).',
      inputSchema: z.object({ ref, body: z.string() }),
      execute: wrap(async ({ ref, body }: any) => {
        await d.addComment(actor, ref, body);
        return { ok: true };
      }),
    }),
    create_issue: tool({
      description: 'Create an issue (a need) in a project; set triggered_by to the item that caused it.',
      inputSchema: z.object({
        project: z.string().describe('org/KEY or KEY'),
        title: z.string(),
        body: z.string().optional(),
        status: z.string().optional(),
        assignee: z.string().optional(),
        skill: z.string().optional(),
        triggered_by: z.string().optional(),
      }),
      execute: wrap(async (a: any) => {
        const item = await d.createItem(actor, await d.resolveProject(actor, a.project), {
          type: 'issue', title: a.title, body: a.body, status: a.status, assignee: a.assignee, skill: a.skill, triggeredBy: a.triggered_by,
        });
        return { ref: item.ref, status: item.status, assignee: item.assigneeName };
      }),
    }),
    create_task: tool({
      description: 'Create a task under an issue. Give it a skill and no assignee to route it to the least busy member with that skill.',
      inputSchema: z.object({ issue: ref, title: z.string(), body: z.string().optional(), status: z.string().optional(), assignee: z.string().optional(), skill: z.string().optional() }),
      execute: wrap(async (a: any) => {
        const parent = await d.resolveItem(actor, a.issue);
        const item = await d.createItem(actor, await d.resolveProject(actor, parent.projectId), {
          type: 'task', parentRef: parent.id, title: a.title, body: a.body, status: a.status, assignee: a.assignee, skill: a.skill,
        });
        return { ref: item.ref, status: item.status, assignee: item.assigneeName };
      }),
    }),
    link_items: tool({
      description: '"blocks": from must finish before to (to’s agent waits). "triggered": from caused to (permanent). "relates": reference.',
      inputSchema: z.object({ from: ref, to: ref, kind: z.enum(['blocks', 'triggered', 'relates']) }),
      execute: wrap(({ from, to, kind }: any) => d.addLink(actor, from, to, kind)),
    }),
    list_items: tool({
      description: 'Items on a project board, optionally in one column.',
      inputSchema: z.object({ project: z.string(), status: z.string().optional(), open_only: z.boolean().optional() }),
      execute: wrap(async ({ project, status, open_only }: any) =>
        (await d.listItems(await d.resolveProject(actor, project), { status, open: open_only ?? true })).map((i: any) => ({
          ref: i.ref, type: i.type, title: i.title, status: i.status, assignee: i.assigneeName, skill: i.skill, blockedBy: i.blockedBy,
        })),
      ),
    }),
    search: tool({
      description: 'Search items by title, description or ref.',
      inputSchema: z.object({ query: z.string() }),
      execute: wrap(({ query }: any) => d.search(actor, query)),
    }),
    list_members: tool({
      description: 'People and agents in an organization, with their skills.',
      inputSchema: z.object({ org: z.string() }),
      execute: wrap(async ({ org }: any) =>
        (await d.orgDetail(actor, org)).members.map((m: any) => ({ name: m.name, kind: m.kind, skills: m.skills })),
      ),
    }),
    end_run: tool({
      description: 'End this run without changing the task’s status (e.g. an issue now waiting on its tasks). Call it last.',
      inputSchema: z.object({}),
      execute: wrap(() => d.endRun(actor)),
    }),
    ...(repo ? repoTools(repo, wrap) : {}),
  };
}

async function logStep(runId: string, kind: string, content: unknown) {
  await sql`insert into run_steps (run_id, kind, content) values (${runId}, ${kind}, ${sql.json(content as any)})`;
}

const runFinished = async (runId: string) => {
  const [r] = await sql`select finished_at from agent_runs where id = ${runId}`;
  return !r || !!r.finishedAt;
};

export type InHouseRun = {
  runId: string;
  itemId: string;
  agent: { id: string; name: string; orgId: string };
  keyId: string;
  providerId: string;
  model: string;
  maxSteps: number;
  system: string;
  prompt: string;
  notificationIds: number[];
  attempts: number;
  repo: RunRepo | null;
};

/** Start an in-house run in the background. The caller has recorded the run and marked its updates delivered. */
export function startInHouse(run: InHouseRun) {
  active++;
  void execute(run)
    .catch(async (e) => {
      console.error('in-house run', run.runId, e);
      await fail(run, `the run crashed: ${(e as Error).message}`, true).catch(() => {});
    })
    .finally(() => {
      active--;
      bus.emit('pulse'); // a slot is free
    });
}

async function execute(run: InHouseRun) {
  const actor: Actor = { id: run.agent.id, kind: 'agent', name: run.agent.name, email: null, orgId: run.agent.orgId, keyId: run.keyId };
  const provider = await providerFor(run.agent.orgId, run.providerId);
  if (!provider) return fail(run, 'the agent’s AI provider was removed; choose another on its Connection tab', false);

  await logStep(run.runId, 'system', { text: run.system });
  await logStep(run.runId, 'prompt', { text: run.prompt });
  let input = 0;
  let output = 0;
  let steps = 0;
  try {
    const result = await generateText({
      model: languageModel(provider, run.model),
      system: run.system,
      prompt: run.prompt,
      tools: taskTools(actor, run.repo),
      stopWhen: [stepCountIs(run.maxSteps), () => runFinished(run.runId)],
      maxRetries: 2,
      abortSignal: AbortSignal.timeout(RUN_TIMEOUT_MS),
      onStepFinish: async (step: any) => {
        steps++;
        input += step.usage?.inputTokens ?? 0;
        output += step.usage?.outputTokens ?? 0;
        if (step.text?.trim()) await logStep(run.runId, 'text', { text: step.text });
        for (const c of step.toolCalls ?? []) await logStep(run.runId, 'tool_call', { id: c.toolCallId, tool: c.toolName, input: c.input });
        for (const r of step.toolResults ?? []) await logStep(run.runId, 'tool_result', { id: r.toolCallId, tool: r.toolName, output: r.output });
        await sql`update agent_runs set steps = ${steps}, input_tokens = ${input}, output_tokens = ${output} where id = ${run.runId}`;
      },
    });
    void result;
  } catch (e) {
    const err = e as Error & { statusCode?: number };
    const transient = !err.statusCode || err.statusCode === 429 || err.statusCode >= 500;
    return fail(run, `the model call failed: ${err.message}`, transient);
  }

  if (await runFinished(run.runId)) return;
  if (steps >= run.maxSteps) {
    await logStep(run.runId, 'error', { text: `Stopped after ${run.maxSteps} steps (the agent’s limit).` });
    await releaseRun({ id: run.runId, agentId: run.agent.id, itemId: run.itemId, keyId: run.keyId }, `stopped at the limit of ${run.maxSteps} steps`);
    return;
  }
  // The model stopped without setting a status or ending the run: that's the end of this run.
  await logStep(run.runId, 'note', { text: 'The agent finished without changing the task’s status; the run is over.' });
  await d.endRun(actor);
}

/** A run that couldn't complete. Transient provider trouble puts its updates back in the queue (a few times). */
async function fail(run: InHouseRun, error: string, retry: boolean) {
  await logStep(run.runId, 'error', { text: error });
  const again = retry && run.attempts < MAX_ATTEMPTS;
  if (again && run.notificationIds.length) {
    const backoff = 60 * 2 ** run.attempts;
    await sql`
      update notifications set delivery_status = 'pending', attempts = ${run.attempts + 1},
        next_attempt_at = now() + ${backoff + ' seconds'}::interval, last_error = ${error}
      where id in ${sql(run.notificationIds)}`;
  }
  await releaseRun({ id: run.runId, agentId: run.agent.id, itemId: run.itemId, keyId: run.keyId }, again ? `${error} (will retry)` : error);
}

/**
 * On startup: in-house runs that were in flight when the server stopped (e.g. a deploy) are closed and
 * their updates queued again, so the work is retried rather than lost.
 */
export async function recoverInterruptedRuns() {
  const runs = await sql`select id, agent_id, key_id, notification_ids from agent_runs where runtime = 'builtin' and status = 'fired' and finished_at is null`;
  for (const r of runs) {
    if (r.notificationIds.length) {
      await sql`update notifications set delivery_status = 'pending', next_attempt_at = now() where id in ${sql(r.notificationIds.map(Number))}`;
    }
    await sql`insert into run_steps (run_id, kind, content) values (${r.id}, 'error', ${sql.json({ text: 'Interrupted by a restart of Tasks; the work was queued again.' })})`;
    await releaseRun({ id: r.id, agentId: r.agentId, itemId: null, keyId: r.keyId }, 'interrupted by a restart; queued again');
  }
  if (runs.length) console.log(`recovered ${runs.length} interrupted in-house run(s)`);
}

import { generateText, stepCountIs, tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { sql, bus } from './db.js';
import type { Actor } from './auth.js';
import { HttpError } from './errors.js';
import * as d from './domain.js';
import { languageModel, providerFor } from './llm.js';
import { releaseRun } from './routine.js';
import { repoOps, type RunRepo } from './github.js';
import { browser_, browserAvailable, closeSession } from './browser.js';
import { openConnectors } from './connectors.js';
import * as values from './projectValues.js';

/**
 * Agents that Tasks runs itself: an LLM with Tasks' own actions as tools, driven by the same payload
 * a Claude Code routine gets. Runs are I/O-bound (waiting on the provider), so a few run at once.
 */
const MAX_CONCURRENT = 3;
const RUN_TIMEOUT_MS = 30 * 60_000;
const MAX_TOOL_OUTPUT = 20_000;
const MAX_ATTEMPTS = 3;
let active = 0;
/** Runs this process is executing (never taken for dead here, however quiet). */
const mine = new Set<string>();

let draining = false;
export const inHouseFull = () => draining || active >= MAX_CONCURRENT;

/** Near the step limit, the agent is told to report, and only has the tools that report. */
const WRAP_UP_STEPS = 3;
const WRAP_UP_TEXT = '[Tasks] You are almost out of steps:';
const WRAP_UP_TOOLS = ['comment', 'update_item', 'end_run', 'create_task', 'link_items', 'set_project_value'];

export const REPO_TOOL_NAMES = ['repo_create_branch', 'repo_list_files', 'repo_read_file', 'repo_write_files', 'repo_open_pull_request', 'repo_merge_pull_request', 'repo_publish_pages'];

/** Git tools for the run's repository (a token limited to that one repository). */
function repoTools(r: RunRepo, wrap: <A>(fn: (a: A) => Promise<unknown>) => (a: A) => Promise<string>): ToolSet {
  const ops = repoOps(r);
  return {
    repo_create_branch: tool({
      description: `Create a branch if it doesn't exist, from another (default ${r.prod}, the production branch). An empty repository gets a first commit.`,
      inputSchema: z.object({ branch: z.string(), from: z.string().optional() }),
      execute: wrap(({ branch, from }: any) => ops.createBranch(branch, from)),
    }),
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
      description: `Create or replace files on a branch, one commit per file. A new branch is created from \`from\` (default ${r.base}). Give each file's full new content.`,
      inputSchema: z.object({
        branch: z.string(),
        message: z.string(),
        files: z.array(z.object({ path: z.string(), content: z.string() })).min(1),
        from: z.string().optional().describe(`branch to start a new branch from (default ${r.base})`),
      }),
      execute: wrap(({ branch, message, files, from }: any) => ops.writeFiles(branch, message, files, from)),
    }),
    repo_open_pull_request: tool({
      description: `Open a pull request from a branch into another (default ${r.base}).`,
      inputSchema: z.object({ branch: z.string(), title: z.string(), body: z.string(), into: z.string().optional() }),
      execute: wrap(({ branch, title, body, into }: any) => ops.openPullRequest(branch, title, body, into)),
    }),
    repo_merge_pull_request: tool({
      description: 'Merge a pull request into its target branch, when the project guidelines say you may.',
      inputSchema: z.object({ number: z.number().int() }),
      execute: wrap(({ number }: any) => ops.mergePullRequest(number)),
    }),
    repo_publish_pages: tool({
      description: 'Publish a branch of a static site (index.html at the root, or in /docs) with GitHub Pages and get its URL. Only if the project guidelines deploy this way. It can take a minute to go live.',
      inputSchema: z.object({ branch: z.string().optional(), folder: z.enum(['/', '/docs']).optional() }),
      execute: wrap(({ branch, folder }: any) => ops.publishPages(branch, folder ?? '/')),
    }),
  };
}

export const BROWSER_TOOL_NAMES = ['browser_open', 'browser_read', 'browser_click', 'browser_type', 'browser_press', 'browser_wait', 'browser_screenshot', 'browser_console', 'browser_eval'];

/** Screenshots waiting to be shown to the model (next step only), and kept for the transcript by tool call. */
type Shots = { pending: string[]; byCall: Map<string, string> };

/**
 * A headless browser (one per run) on the public internet. Pages come back as Playwright's AI snapshot: the
 * accessibility tree with element refs (e5), so any model can use it; screenshots also need a vision model.
 */
function browserTools(runId: string, shots: Shots): ToolSet {
  const safe =
    <A,>(fn: (a: A) => Promise<unknown>) =>
    async (a: A) => {
      try {
        const out = JSON.stringify(await fn(Object.fromEntries(Object.entries((a ?? {}) as object).filter(([, v]) => v !== '')) as A));
        return out.length > MAX_TOOL_OUTPUT ? `${out.slice(0, MAX_TOOL_OUTPUT)}… (truncated)` : out;
      } catch (e) {
        return JSON.stringify({ error: (e as Error).message.split('\n')[0] });
      }
    };
  const targetDesc = 'an element ref from the page snapshot (e.g. e5), or a Playwright selector (CSS, text=Start)';
  return {
    browser_open: tool({
      description: 'Open a URL in your browser and get the page: its accessibility tree, each element tagged with a ref like [ref=e5] for the other browser tools.',
      inputSchema: z.object({ url: z.string() }),
      execute: safe(({ url }: any) => browser_.open(runId, url)),
    }),
    browser_read: tool({
      description: 'The current page again (accessibility tree with refs).',
      inputSchema: z.object({}),
      execute: safe(() => browser_.read(runId)),
    }),
    browser_click: tool({
      description: `Click an element (${targetDesc}), or a point (x, y in CSS pixels, e.g. inside a canvas). Returns the page after the click.`,
      inputSchema: z.object({ target: z.string().optional(), x: z.number().optional(), y: z.number().optional() }),
      execute: safe((a: any) => browser_.click(runId, a)),
    }),
    browser_type: tool({
      description: `Fill a field (${targetDesc}) with text, or type into whatever has focus when no target is given. submit presses Enter.`,
      inputSchema: z.object({ target: z.string().optional(), text: z.string(), submit: z.boolean().optional() }),
      execute: safe((a: any) => browser_.type(runId, a)),
    }),
    browser_press: tool({
      description: 'Press a key (Enter, ArrowUp, w, Space, …), optionally several times or held down for hold_ms (for games).',
      inputSchema: z.object({ key: z.string(), times: z.number().int().optional(), hold_ms: z.number().int().optional() }),
      execute: safe((a: any) => browser_.press(runId, a)),
    }),
    browser_wait: tool({
      description: 'Wait up to 10 seconds (e.g. for an animation, or a deploy to finish before reloading).',
      inputSchema: z.object({ ms: z.number().int() }),
      execute: safe(({ ms }: any) => browser_.wait(runId, ms)),
    }),
    browser_screenshot: tool({
      description: 'See the page: a screenshot is shown to you in the next message (needs a model that reads images). Use it to check what the page looks like.',
      inputSchema: z.object({ full_page: z.boolean().optional() }),
      execute: async ({ full_page }: any, { toolCallId }: { toolCallId: string }) => {
        try {
          const { image, ...rest } = await browser_.screenshot(runId, full_page);
          shots.pending.push(image);
          shots.byCall.set(toolCallId, image);
          return JSON.stringify({ ...rest, note: 'The screenshot is attached in the next message.' });
        } catch (e) {
          return JSON.stringify({ error: (e as Error).message.split('\n')[0] });
        }
      },
    }),
    browser_console: tool({
      description: 'Console messages, uncaught errors, failed requests and HTTP errors since the last check.',
      inputSchema: z.object({}),
      execute: safe(() => browser_.console(runId)),
    }),
    browser_eval: tool({
      description: 'Evaluate a JavaScript expression in the page and get its JSON value (e.g. read game state).',
      inputSchema: z.object({ expression: z.string() }),
      execute: safe(({ expression }: any) => browser_.evaluate(runId, expression)),
    }),
  };
}

const SHOT_TEXT = '[browser screenshot]';

/** Show pending screenshots once, in the next step, and drop earlier ones so images don't pile up. */
function withScreenshots(messages: any[], shots: Shots) {
  const out = messages.map((m) =>
    m.role === 'user' && Array.isArray(m.content) && m.content[0]?.text === SHOT_TEXT
      ? { role: 'user', content: '(an earlier screenshot, no longer shown)' }
      : m,
  );
  if (shots.pending.length) {
    out.push({
      role: 'user',
      content: [{ type: 'text', text: SHOT_TEXT }, ...shots.pending.splice(0).map((image) => ({ type: 'image', image, mediaType: 'image/jpeg' }))],
    });
  }
  return out;
}

/** The tools an in-house agent works with, acting as the agent (so the usual rules apply). */
export const TASK_TOOL_NAMES = ['get_item', 'update_item', 'comment', 'create_issue', 'create_task', 'link_items', 'list_items', 'search', 'list_members', 'set_project_value', 'delete_project_value', 'end_run'];

function taskTools(actor: Actor, repo: RunRepo | null, browser: { runId: string; shots: Shots } | null): ToolSet {
  // Some providers (OpenAI's strict tool schemas) send every field, with "" for the ones the model means to
  // leave alone. Empty strings mean "not given"; clearing a value takes an explicit word (see update_item).
  const blankless = (a: any) => (a && typeof a === 'object' ? Object.fromEntries(Object.entries(a).filter(([, v]) => v !== '')) : a);
  const wrap =
    <A,>(fn: (a: A) => Promise<unknown>) =>
    async (a: A) => {
      try {
        const out = JSON.stringify((await fn(blankless(a) as A)) ?? { ok: true });
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
      description: 'Change status (a board column), title, description (Markdown), assignee (a member name, or "nobody" to unassign) or needed skill ("none" to clear). Leave out (or send "" for) what you don’t change.',
      inputSchema: z.object({
        ref,
        status: z.string().optional(),
        title: z.string().optional(),
        body: z.string().optional(),
        assignee: z.string().optional(),
        skill: z.string().optional(),
      }),
      execute: wrap(async ({ ref, assignee, skill, ...rest }: any) => {
        const item = await d.updateItem(actor, ref, {
          ...rest,
          ...(assignee !== undefined ? { assignee: /^(nobody|none|unassigned)$/i.test(assignee) ? null : assignee } : {}),
          ...(skill !== undefined ? { skill: /^none$/i.test(skill) ? null : skill } : {}),
        });
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
      description: 'Create a task under an issue. Give it a skill and no assignee to route it to the least busy member with that skill. To ask a human something, set assignee to their name. With neither, the task is yours.',
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
    set_project_value: tool({
      description: 'Save a shared project value (e.g. staging_url) that everyone on the project sees, in every run. Not for secrets.',
      inputSchema: z.object({ project: z.string().describe('org/KEY'), key: z.string(), value: z.string() }),
      execute: wrap(({ project, key, value }: any) => values.setValue(actor, project, key, value)),
    }),
    delete_project_value: tool({
      description: 'Delete a shared project value.',
      inputSchema: z.object({ project: z.string().describe('org/KEY'), key: z.string() }),
      execute: wrap(({ project, key }: any) => values.deleteValue(actor, project, key)),
    }),
    end_run: tool({
      description: 'End this run without changing the task’s status (e.g. an issue now waiting on its tasks). Call it last.',
      inputSchema: z.object({}),
      execute: wrap(() => d.endRun(actor)),
    }),
    ...(repo ? repoTools(repo, wrap) : {}),
    ...(browser ? browserTools(browser.runId, browser.shots) : {}),
  };
}

/**
 * Transcripts are read by people, so secrets that tools return or take (a database password in a URL, an API
 * key or token field) are masked there. The model itself still gets them: it may need them for the task.
 */
const SECRET_URL = /\b((?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|amqps?):\/\/[^:@\/\s"\\]+):([^@\s"\\]+)@/gi;
const SECRET_NAME = String.raw`(?:(?:[A-Za-z0-9]*[_-])?(?:key|token|secret|password|passwd|credential)s?|[A-Za-z0-9]*(?:Key|Token|Secret|Password|Credential)s?)`;
const SECRET_FIELD = new RegExp(String.raw`(\\?"${SECRET_NAME}\\?"\s*:\s*\\?")([^"\\]{8,})(\\?")`, 'g');
const SECRET_KEY = new RegExp(String.raw`^${SECRET_NAME}$`);
export function redact(text: string) {
  return text
    .replace(SECRET_URL, '$1:•••@')
    .replace(SECRET_FIELD, (_m, pre: string, v: string, post: string) => `${pre}${v.slice(0, 4)}•••${post}`);
}
const redactDeep = (v: unknown): unknown =>
  typeof v === 'string' ? redact(v)
  : Array.isArray(v) ? v.map(redactDeep)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) =>
      [k, typeof x === 'string' && SECRET_KEY.test(k) && x.length >= 8 ? `${x.slice(0, 4)}•••` : redactDeep(x)]))
  : v;

async function logStep(runId: string, kind: string, content: unknown) {
  const safe = kind === 'tool_call' || kind === 'tool_result' ? redactDeep(content) : content;
  await sql`insert into run_steps (run_id, kind, content) values (${runId}, ${kind}, ${sql.json(safe as any)})`;
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
  mine.add(run.runId);
  void execute(run)
    .catch(async (e) => {
      console.error('in-house run', run.runId, e);
      await fail(run, `the run crashed: ${(e as Error).message}`, true).catch(() => {});
    })
    .finally(() => {
      active--;
      mine.delete(run.runId);
      bus.emit('pulse'); // a slot is free
    });
}

async function execute(run: InHouseRun) {
  const actor: Actor = { id: run.agent.id, kind: 'agent', name: run.agent.name, email: null, orgId: run.agent.orgId, keyId: run.keyId };
  const provider = await providerFor(run.agent.orgId, run.providerId);
  if (!provider) return fail(run, 'the agent’s AI provider was removed; choose another on its Connection tab', false);

  // MCP connectors that apply: the org's, the item's project's and the agent's own.
  const [item] = await sql`select project_id from items where id = ${run.itemId}`;
  const mcp = await openConnectors(run.agent.orgId, item?.projectId ?? null, run.agent.id);
  const prompt = mcp.notes.length ? `${run.prompt}\n\n${mcp.notes.join('\n')}` : run.prompt;
  await logStep(run.runId, 'system', { text: run.system });
  await logStep(run.runId, 'prompt', { text: prompt });
  if (mcp.available.length || mcp.notes.length) {
    await logStep(run.runId, 'note', { text: `Connectors: ${[...mcp.available, ...mcp.notes.map((n) => n.split(':')[0].replace('Connector ', '') + ' (unavailable)')].join(', ')}` });
  }
  let input = 0;
  let output = 0;
  let steps = 0;
  const shots: Shots = { pending: [], byCall: new Map() };
  try {
    const result = await generateText({
      model: languageModel(provider, run.model),
      system: run.system,
      prompt,
      tools: { ...taskTools(actor, run.repo, browserAvailable() ? { runId: run.runId, shots } : null), ...mcp.tools },
      stopWhen: [stepCountIs(run.maxSteps), () => runFinished(run.runId)],
      prepareStep: ({ messages, stepNumber }: any) => {
        const left = run.maxSteps - stepNumber;
        if (left > WRAP_UP_STEPS || run.maxSteps <= WRAP_UP_STEPS * 2) return { messages: withScreenshots(messages, shots) };
        // Nearly out of steps: report now, with only the tools that report.
        const base = withScreenshots(messages, shots).filter((m: any) => !(m.role === 'user' && typeof m.content === 'string' && m.content.startsWith(WRAP_UP_TEXT)));
        return {
          messages: [...base, { role: 'user', content: `${WRAP_UP_TEXT} ${left} step${left === 1 ? '' : 's'} left in this run. Stop investigating: comment what you did and found (and what's left), then set the task's status or end the run. Tasks wakes you again when something changes.` }],
          activeTools: WRAP_UP_TOOLS,
        };
      },
      maxRetries: 2,
      abortSignal: AbortSignal.timeout(RUN_TIMEOUT_MS),
      onStepFinish: async (step: any) => {
        steps++;
        input += step.usage?.inputTokens ?? 0;
        output += step.usage?.outputTokens ?? 0;
        if (step.text?.trim()) await logStep(run.runId, 'text', { text: step.text });
        for (const c of step.toolCalls ?? []) await logStep(run.runId, 'tool_call', { id: c.toolCallId, tool: c.toolName, input: c.input });
        for (const r of step.toolResults ?? []) {
          const image = shots.byCall.get(r.toolCallId);
          shots.byCall.delete(r.toolCallId);
          await logStep(run.runId, 'tool_result', { id: r.toolCallId, tool: r.toolName, output: r.output, ...(image ? { image } : {}) });
        }
        await sql`update agent_runs set steps = ${steps}, input_tokens = ${input}, output_tokens = ${output} where id = ${run.runId}`;
      },
    });
    void result;
  } catch (e) {
    // The SDK wraps provider errors after its own retries; the last one says what happened.
    const err = ((e as { lastError?: unknown }).lastError ?? e) as Error & { statusCode?: number; responseBody?: string };
    if (outOfCredits(err)) return stopForCredits(run, actor, provider, err.message);
    const transient = !err.statusCode || err.statusCode === 429 || err.statusCode >= 500;
    return fail(run, `the model call failed: ${err.message}`, transient);
  } finally {
    await closeSession(run.runId);
    await mcp.close();
  }

  if (await runFinished(run.runId)) return;
  if (steps >= run.maxSteps) {
    await logStep(run.runId, 'error', { text: `Stopped after ${run.maxSteps} steps (the agent’s limit).` });
    // Say so on the item, so the unfinished work doesn't sit silently "In progress".
    await d
      .addComment(actor, run.itemId, `I ran out of steps (my limit is ${run.maxSteps}) before finishing this run, so this is unfinished. Comment here to wake me and I'll continue, or raise my step limit on my Connection tab.`)
      .catch(() => {});
    await releaseRun({ id: run.runId, agentId: run.agent.id, itemId: run.itemId, keyId: run.keyId }, `stopped at the limit of ${run.maxSteps} steps`);
    return;
  }
  // The model stopped without setting a status or ending the run: that's the end of this run.
  await logStep(run.runId, 'note', { text: 'The agent finished without changing the task’s status; the run is over.' });
  await d.endRun(actor);
}

const NO_CREDITS = /insufficient_quota|credit balance|exceeded your current quota|billing|payment required|prepayment|out of credits/i;
const outOfCredits = (err: Error & { statusCode?: number; responseBody?: string }) =>
  err.statusCode === 402 || NO_CREDITS.test(err.message) || NO_CREDITS.test(err.responseBody ?? '');

/**
 * The provider account is out of credits: retrying won't help, so a human gets a task to top it up (the one who
 * added the key, else an owner), and that task blocks the item. Marking it done wakes the agent again. One open
 * top-up task per provider, however many runs hit it.
 */
async function stopForCredits(run: InHouseRun, actor: Actor, provider: { id: string; label: string; createdBy?: string | null }, error: string) {
  const title = `Top up credits for ${provider.label}: agents that run on it are stopped`;
  let note = `the provider is out of credits: ${error}`;
  try {
    const item = await d.resolveItem(actor, run.itemId);
    const [existing] = await sql`select id from item_view where org_id = ${run.agent.orgId} and title = ${title} and not done order by created_at limit 1`;
    let blocker: string;
    if (existing) {
      blocker = existing.id;
    } else {
      const [human] = await sql`
        select a.id from accounts a join memberships m on m.account_id = a.id and m.org_id = ${run.agent.orgId}
        where a.kind = 'human' and a.deactivated_at is null
        order by (a.id = ${provider.createdBy ?? null}) desc nulls last, (m.role = 'owner') desc, m.created_at limit 1`;
      const issueId = item.type === 'issue' ? item.id : item.parentId;
      const task = await d.createItem(actor, await d.resolveProject(actor, item.projectId), {
        type: 'task',
        parentRef: issueId,
        title,
        assignee: human?.id,
        body: `The **${provider.label}** account ran out of credits, so agents running on it can't work. The provider said:\n\n> ${error.replace(/\n/g, ' ').slice(0, 500)}\n\nAdd credits (or put a key with credits under Settings → AI providers), then mark this task done: the agents it blocks pick up where they stopped.`,
      });
      blocker = task.id;
    }
    await d.addLink(actor, blocker, item.id, 'blocks').catch(() => {}); // already linked
    const [b] = await sql`select ref from item_view where id = ${blocker}`;
    note = `${note} (waiting on ${b.ref})`;
  } catch (e) {
    console.error('out-of-credits task', e);
  }
  await logStep(run.runId, 'error', { text: `Out of credits: ${note}` });
  await releaseRun({ id: run.runId, agentId: run.agent.id, itemId: run.itemId, keyId: run.keyId }, note);
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
 * In-house runs whose process died (a deploy, a crash) are released and their updates queued again. A run is
 * only taken for dead after a few minutes without a step, since during a rolling deploy the old process may
 * still be running it. Called at startup and by the delivery worker's sweep.
 */
const DEAD_AFTER_MINUTES = 10;
export async function recoverInterruptedRuns() {
  const runs = await sql`
    select r.id, r.agent_id, r.key_id, r.notification_ids from agent_runs r
    where r.runtime = 'builtin' and r.status = 'fired' and r.finished_at is null
      and greatest(r.created_at, (select max(s.created_at) from run_steps s where s.run_id = r.id)) < now() - ${DEAD_AFTER_MINUTES + ' minutes'}::interval`;
  for (const r of runs) {
    if (mine.has(r.id)) continue;
    if (r.notificationIds.length) {
      await sql`update notifications set delivery_status = 'pending', next_attempt_at = now() where id in ${sql(r.notificationIds.map(Number))}`;
    }
    await sql`insert into run_steps (run_id, kind, content) values (${r.id}, 'error', ${sql.json({ text: 'The run stopped (Tasks restarted or crashed); the work was queued again.' })})`;
    await releaseRun({ id: r.id, agentId: r.agentId, itemId: null, keyId: r.keyId }, 'stopped by a restart or crash; queued again');
  }
  if (runs.length) console.log(`recovered ${runs.length} interrupted in-house run(s)`);
}

/**
 * Shutting down (a deploy stops this container): start no new runs, give running ones a few seconds, then
 * release the rest and queue their updates again right away, so the next process picks them up without
 * waiting for them to look dead. (Docker allows ~10s between SIGTERM and SIGKILL.)
 */
export async function drainInHouse(ms: number) {
  draining = true;
  const until = Date.now() + ms;
  while (active > 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
  if (!mine.size) return;
  const runs = await sql`select id, agent_id, key_id, notification_ids from agent_runs where id in ${sql([...mine])} and finished_at is null`;
  for (const r of runs) {
    if (r.notificationIds.length) {
      await sql`update notifications set delivery_status = 'pending', next_attempt_at = now() where id in ${sql(r.notificationIds.map(Number))}`;
    }
    await sql`insert into run_steps (run_id, kind, content) values (${r.id}, 'error', ${sql.json({ text: 'Tasks restarted (a deploy) during this run; the work was queued again.' })})`;
    await releaseRun({ id: r.id, agentId: r.agentId, itemId: null, keyId: r.keyId }, 'Tasks restarted during the run; queued again');
  }
  console.log(`drained: queued ${runs.length} in-house run(s) again`);
}

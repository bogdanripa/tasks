import { fetchError } from './errors.js';
import { sql } from './db.js';
import { config } from './config.js';
import { mintApiKey } from './auth.js';
import { decrypt } from './crypto.js';
import { recordEvent, requeueAgent, workingColumn } from './domain.js';
import { compactReference } from './apidoc.js';
import { BROWSER_TOOL_NAMES, inHouseFull, REPO_TOOL_NAMES, startInHouse, TASK_TOOL_NAMES } from './runtime.js';
import { browserAvailable } from './browser.js';
import { runRepo, type RunRepo } from './github.js';
import { structuredPatch } from 'diff';

const RUN_TOKEN_HOURS = 4;
const MAX_RUNS_PER_ITEM_PER_HOUR = 10; // stops two agents from pinging each other forever
const MAX_ATTEMPTS = 6;

/**
 * What to paste into the routine's Instructions: just "act on the payload" plus the agent's role.
 * How to work with Tasks lives in the payload, so it can change without anyone re-pasting anything.
 */
const ROLE_PLACEHOLDER = `[Describe what this agent does and what it must never do without a human's explicit approval, e.g. "You operate the Pironman Raspberry Pi platform through the Pironman connector. Never delete apps or databases unless a human asked for it in a comment."]`;

/** The Instructions to paste into an agent's routine, with its role description when it has one. */
export function routineInstructions(description?: string) {
  return `You are an AI agent working in Tasks, a tracker shared by humans and AI agents. Tasks starts this run when a task assigned to you changes.

The assignment from Tasks (in a <routine-fire-payload> block, or the message below) is what to do in this run: the task, what changed, how to work with Tasks, and the guidelines for this project. Follow it.

Your role and hard limits:
${description?.trim() || ROLE_PLACEHOLDER}`;
}

const MAX_GUIDELINES = 6000;

export type Pending = {
  id: number;
  reason: string;
  attempts: number;
  agentId: string;
  agentName: string;
  agentOrgId: string;
  routineUrl: string;
  routineTokenEnc: string;
  itemId: string | null;
  itemAssigneeId: string | null;
  itemInBacklog: boolean;
  itemBlocked: boolean;
  itemClosed: boolean;
  runtimeProviderId: string | null;
  runtimeModel: string | null;
  runtimeMaxSteps: number;
};

/** A run that never calls Tasks within this long is released (usually the routine's network allowlist). */
const RUN_CHECKIN_MINUTES = 10;
/** A run with no API activity for this long is released (crashed or stuck). Real runs take minutes. */
const RUN_IDLE_MINUTES = 120;
/** The routine API accepts 65,536 characters of text; stay under it with room to spare. */
const MAX_PAYLOAD = 60_000;
const RECHECK_SECONDS = 30;
const q = (s: string) => `"${s.replace(/\s+/g, ' ').slice(0, 300)}"`;

const MAX_DIFF_LINES = 60;

/** Compact line diff of a description edit: changed lines with one line of context, capped. */
function describeDiff(before: string, after: string) {
  const patch = structuredPatch('before', 'after', before.endsWith('\n') ? before : before + '\n', after.endsWith('\n') ? after : after + '\n', '', '', { context: 1 });
  // Adding a first description (or clearing it) is all + (or all -), not a diff against an empty line.
  const lines = !before.trim()
    ? after.split('\n').map((l) => `+${l}`)
    : !after.trim()
      ? before.split('\n').map((l) => `-${l}`)
      : patch.hunks.flatMap((h, i) => [...(i > 0 ? ['  …'] : []), ...h.lines.filter((l) => !l.startsWith('\\'))]);
  const shown = lines.slice(0, MAX_DIFF_LINES).map((l) => `    ${l}`);
  if (lines.length > MAX_DIFF_LINES) shown.push(`    … ${lines.length - MAX_DIFF_LINES} more diff lines (the full current description is below)`);
  return shown.join('\n');
}

/** Every field an edit touched, with before and after. */
function describeEdits(who: string, changes: Record<string, [any, any]> = {}) {
  const parts: string[] = [];
  if (changes.status) parts.push(`${who} moved it from ${changes.status[0]} to ${changes.status[1]}`);
  if (changes.title) parts.push(`${who} changed the title from ${q(changes.title[0] ?? '')} to ${q(changes.title[1] ?? '')}`);
  if (changes.assignee) parts.push(`${who} reassigned it from ${changes.assignee[0] ?? 'nobody'} to ${changes.assignee[1] ?? 'nobody'}`);
  if (changes.body) {
    const [before, after] = changes.body;
    parts.push(
      typeof before === 'string' && typeof after === 'string'
        ? `${who} edited the description (- removed, + added):\n${describeDiff(before, after)}`
        : `${who} edited the description`,
    );
  }
  return parts.length ? parts.join('\n- ') : `${who} updated it`;
}

function describeChange(c: Record<string, any>, commentLimit = 4000): string {
  const d = c.data ?? {};
  const who = c.actorName;
  switch (c.reason) {
    case 'assigned':
      return `${who} assigned it to you`;
    case 'commented': {
      // The event keeps an excerpt; runs get the full comment (capped), quoted.
      const full: string = c.commentBody ?? d.excerpt ?? '';
      const text = full.length > commentLimit ? `${full.slice(0, commentLimit)}… (shortened; read it in full on the task)` : full;
      return `${who} commented:\n${text.split('\n').map((l: string) => `    > ${l}`).join('\n')}`;
    }
    case 'status_changed':
    case 'updated':
      return describeEdits(who, d.changes);
    case 'task_added':
      return `${who} added task ${d.ref} ${q(d.title ?? '')}`;
    case 'linked':
    case 'unlinked':
      return `${who} ${c.reason === 'linked' ? 'linked' : 'removed the link'}: ${d.from} ${d.kind} ${d.to}`;
    case 'review_requested':
      return `${who} finished it and moved it to review: it's yours to review`;
    case 'changes_requested':
      return `${who} reviewed it and sent it back to you with changes requested (see their comment)`;
    case 'unblocked':
      return `${d.ref} ${q(d.title ?? '')}, which blocked this, is done`;
    case 'triggered_item_done':
      return `${d.ref} ${q(d.title ?? '')}, which this triggered, is done`;
    case 'all_tasks_done':
      return `all tasks under this issue are done (last: ${d.ref})`;
    default:
      return `${who}: ${c.reason}`;
  }
}

/** The project's repository, and how to work with it in this runtime. */
function repoSection(p: { mode: 'routine' | 'builtin'; repo?: RunRepo | { error: string } | null }, item: Record<string, any>) {
  if (!p.repo) return '';
  if (!('token' in p.repo)) return `\nRepository: unavailable for this run (${p.repo.error}). Say so in a comment if you need it.\n`;
  const r = p.repo;
  const branch = `task/${item.ref.split('/')[1]}`;
  const branches =
    r.base === r.prod
      ? `Branch: ${r.prod} (production; work lands on it directly, there's no separate release).`
      : `Branches: ${r.base} is development (work starts from it and lands on it; staging), ${r.prod} is production (only released work).`;
  const flow = `${branches} Follow the project guidelines for reviews, merging, releasing and deploying. If they say nothing: work on a branch (e.g. ${branch}) from ${r.base}, open a pull request into ${r.base} and link it in your comment.`;
  if (p.mode === 'builtin') {
    return `
Repository: https://github.com/${r.repo}. ${flow}
Use the repo_* tools: list and read files, write files to a branch (one commit per file), open pull requests into any branch, and merge them.
`;
  }
  return `
Repository: https://github.com/${r.repo}. ${flow}
A token limited to this repository (valid until ${r.expiresAt.toISOString()}; never put it in comments):
  git clone https://x-access-token:${r.token}@github.com/${r.repo}.git
  Open a PR: curl -s -X POST -H "Authorization: Bearer ${r.token}" https://api.github.com/repos/${r.repo}/pulls -d '{"head":"${branch}","base":"${r.base}","title":"...","body":"..."}'
`;
}

function buildPayload(p: {
  /** routine: a Claude Code session using curl; builtin: Tasks runs the agent with tools. */
  mode: 'routine' | 'builtin';
  repo?: RunRepo | { error: string } | null;
  working?: string;
  /** The hand-off column, when this agent may send the task there (a task, and someone else can review). */
  reviewColumn?: string;
  /** The hand-off column's name, whenever the project has one. */
  reviewColumnName?: string;
  reviewing?: boolean;
  dodCheck?: boolean;
  agentName: string;
  item: Record<string, any>;
  project: Record<string, any>;
  orgGuidelines: string;
  team: { name: string; kind: string; skills: string[] }[];
  parent?: Record<string, any>;
  changes: string[];
  token: string;
  expiresAt: Date;
}) {
  const { item, project } = p;
  const done = project.columns[project.columns.length - 1];
  const auth = `-H "Authorization: Bearer $TASKS_TOKEN"`;
  const bySkill = new Map<string, string[]>();
  for (const m of p.team) {
    const label = `${m.name}${m.name === p.agentName ? ' (you)' : m.kind === 'human' ? ' (human)' : ''}`;
    for (const sk of m.skills.length ? m.skills : ['(no skills)']) bySkill.set(sk, [...(bySkill.get(sk) ?? []), label]);
  }
  const roster = [...bySkill].sort(([a], [b]) => (a.startsWith('(') ? 1 : b.startsWith('(') ? -1 : a.localeCompare(b)))
    .map(([sk, names]) => `- ${sk}: ${names.join(', ')}`).join('\n');
  const guidelines = (title: string, text: string) =>
    text.trim() ? `\n${title}:\n${text.trim().slice(0, MAX_GUIDELINES)}${text.length > MAX_GUIDELINES ? '\n(truncated)' : ''}\n` : '';
  const json = `-H 'content-type: application/json'`;
  const builtin = p.mode === 'builtin';
  const setStatus = (st: string) =>
    builtin ? `update_item {"ref":"${item.ref}","status":"${st}"}` : `curl -s -X PATCH ${auth} ${json} -d '{"status":"${st}"}' $TASKS/api/items/${item.ref}`;
  const readItem = builtin ? `get_item {"ref":"${item.ref}"}` : `curl -s ${auth} $TASKS/api/items/${item.ref}`;
  const addComment = builtin ? `comment {"ref":"${item.ref}","body":"..."}` : `curl -s -X POST ${auth} ${json} -d '{"body":"..."}' $TASKS/api/comments/${item.ref}`;
  const endRun = builtin ? 'end_run' : `curl -s -X POST ${auth} $TASKS/api/runs/end`;
  // What to do first depends on where the task is: reviewing, already done, already started, or new.
  const stepOne = () => {
    if (p.reviewing) return `This task is in "${item.status}" and assigned to you: you're reviewing someone else's work. Don't move it to "${p.working ?? 'In progress'}" (that sends it back to its author).`;
    if (item.done) return `This item is already done. Read what changed (usually a comment) and reply. Only reopen it (move it to "${p.working ?? project.columns[1]}") if the change asks for more work.`;
    if (!p.working) return 'This board has no in-progress column, so start right away.';
    if (item.status === p.working) return `It's already in "${p.working}".`;
    return `Move the task to "${p.working}" first, so people see you're on it (this doesn't end your run):\n   ${setStatus(p.working)}`;
  };
  return `Tasks run for agent "${p.agentName}".
${builtin ? '' : `
First, in your shell (the token acts as ${p.agentName} and expires ${p.expiresAt.toISOString()}; never put it in comments):
  export TASKS=${config.publicUrl} TASKS_TOKEN=${p.token}
`}
How to work (from Tasks):
1. ${stepOne()}
2. Read the task, including comments and links: ${readItem}
3. Do what it asks with your tools and connectors, following the guidelines below. If it's unclear or you're blocked, comment and say so instead of guessing.
4. Comment with what you did (${addComment}), then set its status: "${done}" when finished${p.reviewColumn ? `, or "${p.reviewColumn}" when code needs review (Tasks hands it to a reviewer)` : ', or another column'}. Any status other than "${p.working ?? '-'}" ends your run. If the status should stay as it is (e.g. an issue now waiting on its tasks), end the run instead: ${endRun}
5. Stop. Tasks starts a new run when something changes. While an unfinished item blocks your task, Tasks won't start runs for it; you're woken when the last blocker is done.${p.reviewColumn || p.reviewing ? `
Reviewing: a task in "${p.reviewColumnName}" assigned to you is someone else's work to review. Check it against the spec, design and guidelines. Approve by moving it to "${done}"; otherwise comment exactly what to change and move it back to "${p.working ?? project.columns[1]}" (it returns to its author). Never approve your own work.` : ''}${p.dodCheck ? `

ALL TASKS UNDER THIS ISSUE ARE DONE. This run is the definition-of-done check:
- Check the result against the spec's acceptance criteria and the definition of done in the project guidelines.
- Anything missing or wrong: create a task for it (with a skill), comment what's missing, and end the run. You'll be woken when it's done.
- Everything passes: deliver as the project guidelines say (pull request or merge), comment what shipped with the link, and move the issue to "${done}".` : ''}
Do the work yourself when you can. Create tasks only to hand parts to others or to split work you'll do next (tasks you assign yourself wake you after this run). To hand work to others, create tasks under the issue with a "skill" and no assignee; Tasks gives each to the least busy member with that skill. Express order with "blocks" links; a blocked task doesn't wake its agent until its blockers are done.
If rules conflict: your role's hard limits win, then the project guidelines, then the organization guidelines.${builtin ? '' : ' Never put the API token in comments.'}

Team, by skill:
${roster}
${guidelines(`Project guidelines (${project.name})`, project.guidelines)}${guidelines('Organization guidelines', p.orgGuidelines)}
Task: ${item.ref} (${item.type}) ${q(item.title)}
Status: ${item.status}. Board columns: ${project.columns.join(' → ')} (the last one means done).${item.skill ? `\nNeeds skill: ${item.skill}` : ''}${p.parent ? `\nParent issue: ${p.parent.ref} ${q(p.parent.title)}` : ''}
Link for humans: ${config.publicUrl}/app/i/${item.ref}

What changed since the last run:
${p.changes.map((c) => `- ${c}`).join('\n')}

Description:
${item.body ? item.body.slice(0, 8000) : '(none)'}

${repoSection(p, item)}
${builtin ? `Your tools: ${[...TASK_TOOL_NAMES, ...(p.repo && 'token' in p.repo ? REPO_TOOL_NAMES : []), ...(browserAvailable() ? BROWSER_TOOL_NAMES : [])].join(', ')}. They act as ${p.agentName}.${browserAvailable() ? ' The browser_* tools are a real browser on the public internet: test what you build or review there (open the URL, read the page, click, type, press keys, screenshot, check the console) instead of trusting the code alone.' : ''}` : `Tasks API (with the TASKS and TASKS_TOKEN set above).
Send JSON bodies (content-type: application/json); "?" marks optional fields. Full reference: GET $TASKS/api/help
${compactReference()}`}`;
}

async function markRows(ids: number[], status: 'delivered' | 'skipped' | 'failed', error: string | null, attempts?: number) {
  await sql`
    update notifications set delivery_status = ${status}, last_error = ${error},
      attempts = ${attempts === undefined ? sql`attempts` : attempts}
    where id in ${sql(ids)}`;
}

async function defer(ids: number[], until: Date) {
  await sql`update notifications set next_attempt_at = ${until} where id in ${sql(ids)}`;
}

/** When the agent may start its next run (null: now), and the DB time the check was made. */
async function agentBusyUntil(agentId: string, orgId: string): Promise<{ until: Date | null; checkedAt: Date }> {
  const [{ checkedAt }] = await sql`select now() as checked_at`;
  const [pause] = await sql`select until from routine_pauses where org_id = ${orgId} and until > now()`;
  if (pause) return { until: pause.until, checkedAt };
  // An unfinished run holds the agent; sweepStaleRuns releases runs that crashed or never started.
  const [active] = await sql`
    select 1 from agent_runs r where r.agent_id = ${agentId} and r.status = 'fired' and r.finished_at is null`;
  return { until: active ? new Date(Date.now() + RECHECK_SECONDS * 1000) : null, checkedAt };
}

/** Loop guard: when this agent+item has used its hourly budget, the time the oldest run in the window ages out. */
async function itemWindowOpensAt(agentId: string, itemId: string): Promise<Date | null> {
  const runs = await sql`
    select created_at from agent_runs
    where agent_id = ${agentId} and item_id = ${itemId} and status = 'fired' and created_at > now() - interval '1 hour'
    order by created_at desc limit ${MAX_RUNS_PER_ITEM_PER_HOUR}`;
  if (runs.length < MAX_RUNS_PER_ITEM_PER_HOUR) return null;
  return new Date(new Date(runs[runs.length - 1].createdAt).getTime() + 3600_000);
}

export async function releaseRun(run: Record<string, any>, error: string, revoke = true) {
  const [done] = await sql`
    update agent_runs set finished_at = clock_timestamp(), error = ${error} where id = ${run.id} and finished_at is null returning id`;
  if (!done) return false;
  if (revoke && run.keyId) await sql`update api_keys set revoked_at = now() where id = ${run.keyId} and revoked_at is null`;
  await requeueAgent(sql, run.agentId);
  if (run.itemId) {
    const [item] = await sql`select org_id, project_id from item_view where id = ${run.itemId}`;
    if (item) {
      await recordEvent({
        orgId: item.orgId, projectId: item.projectId, itemId: run.itemId, actorId: run.agentId, type: 'agent.run_failed',
        data: { error },
      });
    }
  }
  return true;
}

/** Release runs that never reached Tasks or went quiet, so the agent's queue moves on. Runs every worker tick. */
export async function sweepStaleRuns() {
  const host = new URL(config.publicUrl).host;
  const stale = await sql`
    select r.id, r.agent_id, r.item_id, r.key_id, k.last_used_at from agent_runs r left join api_keys k on k.id = r.key_id
    where r.status = 'fired' and r.finished_at is null and r.runtime = 'routine' and (
      (k.last_used_at is null and r.created_at < now() - ${RUN_CHECKIN_MINUTES + ' minutes'}::interval) or
      (k.last_used_at < now() - ${RUN_IDLE_MINUTES + ' minutes'}::interval))`;
  for (const run of stale) {
    if (run.lastUsedAt) {
      await releaseRun(run, `no activity for ${RUN_IDLE_MINUTES / 60} hours, so Tasks released the agent; the run may have crashed`);
    } else {
      // Keep its token: a session that merely started late can still do its work.
      await releaseRun(
        run,
        `the run hadn't reached Tasks after ${RUN_CHECKIN_MINUTES} minutes, so Tasks stopped waiting for it. If it never does, check that the routine's cloud environment allows ${host} (Network access → Custom), and open the session to see what happened`,
        false,
      );
    }
  }
}

/** An admin ends a run by hand (e.g. it's stuck), releasing the agent. */
export async function endRunById(runId: string, by: string) {
  const [run] = await sql`select id, agent_id, item_id, key_id from agent_runs where id = ${runId}`;
  if (!run) return false;
  return releaseRun(run, `ended by ${by}`);
}

/**
 * Queue discipline for routine agents: one run at a time per agent, oldest pending item first,
 * nothing dropped. Updates that can't fire yet are deferred and re-checked; when a run finishes
 * (see finishRun in domain.ts) the agent's queue is made due again.
 */
export async function processRoutineQueue(rows: Pending[]) {
  const byAgent = new Map<string, Pending[]>();
  for (const r of rows) byAgent.set(r.agentId, [...(byAgent.get(r.agentId) ?? []), r]);

  for (const [agentId, agentRows] of byAgent) {
    const stale = agentRows.filter((r) => !r.itemId || r.itemAssigneeId !== agentId);
    if (stale.length) await markRows(stale.map((r) => r.id), 'skipped', 'not assigned to this agent'); // stays in the inbox
    // On a closed item, workflow wake-ups (assigned, unblocked, …) are history; comments and edits still
    // come through, since someone may be asking for more.
    const closed = agentRows.filter((r) => !stale.includes(r) && r.itemClosed && !['commented', 'updated'].includes(r.reason));
    if (closed.length) await markRows(closed.map((r) => r.id), 'skipped', 'item is done');
    // Backlog is parked work: no runs. Moving the item out of Backlog is itself a change, so that starts one.
    const parked = agentRows.filter((r) => !stale.includes(r) && !closed.includes(r) && r.itemInBacklog);
    if (parked.length) await markRows(parked.map((r) => r.id), 'skipped', 'in backlog');
    // Waiting on an unfinished blocker: no runs. The last blocker finishing sends "unblocked", which starts one.
    const blocked = agentRows.filter((r) => !stale.includes(r) && !closed.includes(r) && !parked.includes(r) && r.itemBlocked);
    if (blocked.length) await markRows(blocked.map((r) => r.id), 'skipped', 'blocked');
    const live = agentRows.filter((r) => !stale.includes(r) && !closed.includes(r) && !parked.includes(r) && !blocked.includes(r));
    if (!live.length) continue;

    const busy = await agentBusyUntil(agentId, live[0].agentOrgId);
    if (busy.until) {
      // Skip the deferral if a run finished since the check: finishRun made the queue due and must win.
      await sql`
        update notifications set next_attempt_at = ${busy.until}
        where id in ${sql(live.map((r) => r.id))}
          and not exists (select 1 from agent_runs where agent_id = ${agentId} and finished_at >= ${busy.checkedAt})`;
      continue;
    }
    const group = live.filter((r) => r.itemId === live[0].itemId); // rows arrive oldest first
    const opensAt = await itemWindowOpensAt(agentId, group[0].itemId!);
    if (opensAt) {
      await defer(group.map((r) => r.id), opensAt);
      await noteThrottled(group[0], opensAt);
      continue;
    }
    // In-house runs share a few slots on this server; wait for one.
    if (group[0].runtimeProviderId && inHouseFull()) {
      await defer(group.map((r) => r.id), new Date(Date.now() + RECHECK_SECONDS * 1000));
      continue;
    }
    // One run covers every pending update on the item, including ones not due yet (e.g. on a retry timer).
    const extra = await sql`
      select id, reason, attempts from notifications
      where account_id = ${agentId} and item_id = ${group[0].itemId} and delivery_status = 'pending'
        and id not in ${sql(group.map((r) => r.id))}
      order by id`;
    await fireRoutine([...group, ...extra.map((e) => ({ ...group[0], id: Number(e.id), reason: e.reason, attempts: e.attempts }))]);
    // This agent's other items stay due; the next pass finds the new run active and defers them.
  }
}

async function noteThrottled(row: Pending, opensAt: Date) {
  const [recent] = await sql`
    select 1 from events where item_id = ${row.itemId} and actor_id = ${row.agentId}
      and type = 'agent.run_throttled' and created_at > now() - interval '1 hour'`;
  if (recent) return;
  const [item] = await sql`select org_id, project_id from item_view where id = ${row.itemId}`;
  await recordEvent({
    orgId: item.orgId, projectId: item.projectId, itemId: row.itemId, actorId: row.agentId, type: 'agent.run_throttled',
    data: { agent: row.agentName, limit: MAX_RUNS_PER_ITEM_PER_HOUR, resumesAt: opensAt.toISOString() },
  });
}

/** Fire one routine run covering all of an agent's pending updates on one item. */
async function fireRoutine(rows: Pending[]) {
  const first = rows[0];
  const ids = rows.map((r) => r.id);
  const [item] = await sql`select * from item_view where id = ${first.itemId}`;
  const [project] = await sql`
    select p.key, p.name, p.columns, p.column_handoffs, p.guidelines, o.guidelines as org_guidelines
    from projects p join orgs o on o.id = p.org_id where p.id = ${item.projectId}`;
  const [parent] = item.parentId ? await sql`select ref, title from item_view where id = ${item.parentId}` : [];
  const changes = await sql`
    select n.reason, e.data, a.name as actor_name, cm.body as comment_body from notifications n
    join events e on e.id = n.event_id join accounts a on a.id = e.actor_id
    left join comments cm on cm.id = (e.data->>'commentId')::uuid
    where n.id in ${sql(ids)} order by n.id`;

  const expiresAt = new Date(Date.now() + RUN_TOKEN_HOURS * 3600_000);
  const key = await mintApiKey(first.agentId, `run ${item.ref}`, expiresAt);
  const team = [...(await sql`
    select a.name, a.kind, m.skills from memberships m join accounts a on a.id = m.account_id
    where m.org_id = ${item.orgId} and a.deactivated_at is null order by a.kind desc, a.name`)] as any[];
  // A token limited to the project's repository, for this run (none when the project has no repository).
  const repo = await runRepo(item.projectId).catch((e) => ({ error: (e as Error).message }));
  const reviewColumn = Object.keys(project.columnHandoffs ?? {})[0];
  const build = (changeLines: string[]) =>
    buildPayload({
      mode: first.runtimeProviderId ? 'builtin' : 'routine',
      repo,
      working: workingColumn(project.columns),
      // Offer Review only where it works: tasks, with someone other than this agent holding the skill.
      reviewColumn: reviewColumn && item.type === 'task' && team.some((m) => m.name !== first.agentName && m.skills.includes(project.columnHandoffs[reviewColumn])) ? reviewColumn : undefined,
      reviewColumnName: reviewColumn,
      reviewing: !!reviewColumn && item.status === reviewColumn && item.type === 'task',
      dodCheck: item.type === 'issue' && rows.some((r) => r.reason === 'all_tasks_done'),
      orgGuidelines: project.orgGuidelines,
      team, agentName: first.agentName, item, project, parent, token: key.key, expiresAt,
      changes: changeLines,
    });
  const lines = (commentLimit?: number) => [...new Set(changes.map((c) => describeChange(c, commentLimit)))];
  let text = build(lines());
  // Too long for the routine API (many long comments or diffs): shorten comments first, then drop the
  // oldest comments. Assignments, status changes and blocker news are always kept.
  if (text.length > MAX_PAYLOAD) text = build(lines(500));
  if (text.length > MAX_PAYLOAD) {
    const short = changes.map((c) => ({ line: describeChange(c, 500), comment: c.reason === 'commented' }));
    let drop = 0;
    const commentCount = short.filter((x) => x.comment).length;
    while (text.length > MAX_PAYLOAD && drop < commentCount) {
      drop = Math.min(commentCount, Math.max(1, drop * 2));
      let skipped = 0;
      const kept = short.filter((x) => !(x.comment && skipped++ < drop)).map((x) => x.line);
      text = build([`(${drop} earlier comments omitted: read them on the task)`, ...new Set(kept)]);
    }
  }
  if (text.length > MAX_PAYLOAD) text = text.slice(0, MAX_PAYLOAD - 200) + '\n\n(truncated: fetch the task for the rest)';

  const reasons = [...new Set(rows.map((r) => r.reason))];
  if (first.runtimeProviderId && first.runtimeModel) {
    // Tasks runs this agent itself.
    const [runRow] = await sql`
      insert into agent_runs (agent_id, item_id, key_id, reasons, status, runtime, notification_ids, model)
      values (${first.agentId}, ${item.id}, ${key.id}, ${reasons}, 'fired', 'builtin', ${ids}, ${first.runtimeModel}) returning id`;
    const sessionUrl = `${config.publicUrl}/app/runs/${runRow.id}`;
    await sql`update agent_runs set session_url = ${sessionUrl} where id = ${runRow.id}`;
    await markRows(ids, 'delivered', null, first.attempts + 1);
    await recordEvent({
      orgId: item.orgId, projectId: item.projectId, itemId: item.id, actorId: first.agentId, type: 'agent.run_started',
      data: { agent: first.agentName, sessionUrl, reasons },
    });
    const [agentRow] = await sql`select description from accounts where id = ${first.agentId}`;
    startInHouse({
      runId: runRow.id, itemId: item.id, agent: { id: first.agentId, name: first.agentName, orgId: first.agentOrgId },
      keyId: key.id, providerId: first.runtimeProviderId, model: first.runtimeModel, maxSteps: first.runtimeMaxSteps,
      system: routineInstructions(agentRow?.description), prompt: text, notificationIds: ids, attempts: first.attempts,
      repo: repo && 'token' in repo ? repo : null,
    });
    return;
  }

  let error: string | null = null;
  let retryAfter: number | null = null;
  let rateLimited = false;
  let sessionUrl: string | null = null;
  try {
    const res = await fetch(first.routineUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${decrypt(first.routineTokenEnc)}`,
        'anthropic-beta': 'experimental-cc-routine-2026-04-01',
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await res.json().catch(() => ({}))) as any;
    if (res.ok) sessionUrl = body.claude_code_session_url ?? null;
    else {
      error = `HTTP ${res.status}${body?.error?.message ? `: ${body.error.message}` : ''}`;
      rateLimited = res.status === 429;
      if (res.status === 429 || res.status >= 500) retryAfter = Number(res.headers.get('retry-after')) || null;
      else retryAfter = -1; // a bad token or URL won't fix itself
    }
  } catch (e) {
    error = fetchError(e);
  }

  if (!error) {
    await sql`insert into agent_runs (agent_id, item_id, key_id, reasons, status, session_url)
              values (${first.agentId}, ${item.id}, ${key.id}, ${reasons}, 'fired', ${sessionUrl})`;
    await markRows(ids, 'delivered', null, first.attempts + 1);
    await recordEvent({
      orgId: item.orgId, projectId: item.projectId, itemId: item.id, actorId: first.agentId, type: 'agent.run_started',
      data: { agent: first.agentName, sessionUrl, reasons },
    });
    return;
  }

  await sql`update api_keys set revoked_at = now() where id = ${key.id}`;
  if (rateLimited) {
    // Account-level limit: pause every routine in the org until Anthropic says to retry. Not a failure.
    const until = new Date(Date.now() + (retryAfter ?? 60) * 1000);
    await sql`
      insert into routine_pauses (org_id, until, reason) values (${first.agentOrgId}, ${until}, ${error})
      on conflict (org_id) do update set until = greatest(routine_pauses.until, excluded.until), reason = excluded.reason`;
    await sql`update notifications set last_error = ${error} where id in ${sql(ids)}`;
    return defer(ids, until);
  }
  const attempts = first.attempts + 1;
  if (retryAfter === -1 || attempts >= MAX_ATTEMPTS) {
    await sql`insert into agent_runs (agent_id, item_id, reasons, status, error)
              values (${first.agentId}, ${item.id}, ${reasons}, 'failed', ${error})`;
    await markRows(ids, 'failed', error, attempts);
    await recordEvent({
      orgId: item.orgId, projectId: item.projectId, itemId: item.id, actorId: first.agentId, type: 'agent.run_failed',
      data: { agent: first.agentName, error },
    });
  } else {
    const backoff = retryAfter ?? Math.min(2 ** attempts * 15, 1800);
    await sql`
      update notifications set attempts = ${attempts}, last_error = ${error},
        next_attempt_at = now() + ${backoff + ' seconds'}::interval
      where id in ${sql(ids)}`;
  }
}

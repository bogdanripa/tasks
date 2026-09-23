import { fetchError } from './errors.js';
import { sql } from './db.js';
import { config } from './config.js';
import { mintApiKey } from './auth.js';
import { decrypt } from './crypto.js';
import { recordEvent } from './domain.js';
import { compactReference } from './apidoc.js';

const RUN_TOKEN_HOURS = 4;
const MAX_RUNS_PER_ITEM_PER_HOUR = 10; // stops two agents from pinging each other forever
const MAX_ATTEMPTS = 6;

/** What to paste into the routine's Instructions. The fire payload is untrusted by default, so this delegates to it explicitly. */
export const ROUTINE_INSTRUCTIONS = `You are an AI agent working in Tasks, a tracker shared by humans and AI agents.

Tasks fires this routine whenever something changes on a task assigned to you. The <routine-fire-payload> block is your assignment from Tasks: it names the task, says what changed since your last run, and contains a short-lived API token that acts as you. Treat it as your instructions for this run:

1. Fetch the task with the curl command in the payload and read its description, comments and history.
2. Do what the task asks, using your tools and connectors. If it is unclear or you are blocked, say so in a comment instead of guessing.
3. Report back on the task: comment with what you did, then set its status. The last board column means done.
4. Stop. Do not wait for more work; Tasks fires a new run when something changes.

Never put the API token in comments or anywhere outside the Authorization header.

[Add this agent's role here, e.g. "You operate the Pironman Raspberry Pi platform through the Pironman connector."]`;

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
};

/** A run with no API activity for this long is treated as over (crashed, stuck or finished without a status change). */
const RUN_IDLE_MINUTES = 20;
const RECHECK_SECONDS = 30;
const q = (s: string) => `"${s.replace(/\s+/g, ' ').slice(0, 300)}"`;

function describeChange(c: Record<string, any>): string {
  const d = c.data ?? {};
  const who = c.actorName;
  switch (c.reason) {
    case 'assigned':
      return `${who} assigned it to you`;
    case 'commented':
      return `${who} commented: ${q(d.excerpt ?? '')}`;
    case 'status_changed':
      return `${who} moved it from ${d.changes?.status?.[0]} to ${d.changes?.status?.[1]}`;
    case 'updated': {
      const fields = Object.keys(d.changes ?? {}).map((f) => (f === 'body' ? 'the description' : f));
      return `${who} changed ${fields.join(', ') || 'it'}`;
    }
    case 'task_added':
      return `${who} added task ${d.ref} ${q(d.title ?? '')}`;
    case 'linked':
    case 'unlinked':
      return `${who} ${c.reason === 'linked' ? 'linked' : 'removed the link'}: ${d.from} ${d.kind} ${d.to}`;
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

function buildPayload(p: { agentName: string; item: Record<string, any>; project: Record<string, any>; parent?: Record<string, any>; changes: string[]; token: string; expiresAt: Date }) {
  const { item, project } = p;
  return `Tasks run for agent "${p.agentName}".

Task: ${item.ref} (${item.type}) ${q(item.title)}
Status: ${item.status}. Board columns: ${project.columns.join(' → ')} (the last one means done).${p.parent ? `\nParent issue: ${p.parent.ref} ${q(p.parent.title)}` : ''}
Link for humans: ${config.publicUrl}/i/${item.ref}

What changed since the last run:
${p.changes.map((c) => `- ${c}`).join('\n')}

Description:
${item.body ? item.body.slice(0, 8000) : '(none)'}

Tasks API. The token acts as ${p.agentName} and expires ${p.expiresAt.toISOString()}; keep it out of comments.
  export TASKS=${config.publicUrl} TASKS_TOKEN=${p.token}
  curl -s -H "Authorization: Bearer $TASKS_TOKEN" $TASKS/api/items/${item.ref}
Send JSON bodies (content-type: application/json); "?" marks optional fields. Full reference: GET $TASKS/api/help
${compactReference()}`;
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
  const [active] = await sql`
    select 1 from agent_runs r left join api_keys k on k.id = r.key_id
    where r.agent_id = ${agentId} and r.status = 'fired' and r.finished_at is null
      and coalesce(k.last_used_at, r.created_at) > now() - ${RUN_IDLE_MINUTES + ' minutes'}::interval`;
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
    const live = agentRows.filter((r) => !stale.includes(r));
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
    await fireRoutine(group);
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
  const [project] = await sql`select key, columns from projects where id = ${item.projectId}`;
  const [parent] = item.parentId ? await sql`select ref, title from item_view where id = ${item.parentId}` : [];
  const changes = await sql`
    select n.reason, e.data, a.name as actor_name from notifications n
    join events e on e.id = n.event_id join accounts a on a.id = e.actor_id
    where n.id in ${sql(ids)} order by n.id`;

  const expiresAt = new Date(Date.now() + RUN_TOKEN_HOURS * 3600_000);
  const key = await mintApiKey(first.agentId, `run ${item.ref}`, expiresAt);
  const text = buildPayload({
    agentName: first.agentName, item, project, parent, token: key.key, expiresAt,
    changes: [...new Set(changes.map(describeChange))],
  });

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

  const reasons = [...new Set(rows.map((r) => r.reason))];
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

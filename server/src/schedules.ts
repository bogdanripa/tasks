import { CronExpressionParser } from 'cron-parser';
import { sql, bus } from './db.js';
import type { Actor } from './auth.js';
import { badRequest, forbidden, notFound } from './errors.js';
import { createItem, orgRole, resolveItem, resolveMember, resolveProject } from './domain.js';

export type ScheduleInput = {
  name: string;
  cron: string;
  timezone: string;
  enabled?: boolean;
  title: string;
  body?: string;
  status?: string | null;
  assignee?: string | null;
  parent?: string | null;
  skipIfOpen?: boolean;
};

function checkTimezone(tz: string) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
  } catch {
    throw badRequest(`Unknown timezone "${tz}"`);
  }
}

/** Next run strictly after `after`, in the schedule's timezone. Throws a 400 on a bad expression. */
export function nextRun(cron: string, timezone: string, after = new Date()) {
  checkTimezone(timezone);
  try {
    return CronExpressionParser.parse(cron, { tz: timezone, currentDate: after }).next().toDate();
  } catch (e) {
    throw badRequest(`Invalid schedule "${cron}": ${(e as Error).message}`);
  }
}

/** {date} → 2026-09-24 and {weekday} → Thursday, in the schedule's timezone. */
function fill(template: string, timezone: string, at: Date) {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
  const weekday = new Intl.DateTimeFormat('en', { timeZone: timezone, weekday: 'long' }).format(at);
  return template.replaceAll('{date}', date).replaceAll('{weekday}', weekday);
}

async function requireProjectAdmin(actor: Actor, ref: string) {
  const project = await resolveProject(actor, ref);
  if ((await orgRole(actor.id, project.orgId)) === 'member') throw forbidden('Requires an org admin');
  return project;
}

async function scheduleForAdmin(actor: Actor, id: string) {
  const [s] = await sql`select s.*, p.org_id from schedules s join projects p on p.id = s.project_id where s.id = ${id}`;
  if (!s) throw notFound('Schedule');
  const role = await orgRole(actor.id, s.orgId);
  if (!role) throw notFound('Schedule');
  if (role === 'member') throw forbidden('Requires an org admin');
  return s;
}

/** Validate an input against its project and turn refs/names into ids. */
async function normalize(actor: Actor, project: Record<string, any>, input: ScheduleInput) {
  if (input.status && !project.columns.includes(input.status)) throw badRequest(`Unknown column "${input.status}"`);
  const assignee = input.assignee ? await resolveMember(project.orgId, input.assignee) : null;
  let parentId: string | null = null;
  if (input.parent) {
    const parent = await resolveItem(actor, input.parent);
    if (parent.type !== 'issue' || parent.projectId !== project.id) throw badRequest('The parent must be an issue in this project');
    parentId = parent.id;
  }
  if (!input.title.trim()) throw badRequest('Title is required');
  return { assigneeId: assignee?.id ?? null, parentId, next: nextRun(input.cron, input.timezone) };
}

const listSql = (where: ReturnType<typeof sql>) => sql`
  select s.id, s.name, s.cron, s.timezone, s.enabled, s.title, s.body, s.status, s.skip_if_open,
         s.next_run_at, s.last_run_at, s.last_error, s.created_at,
         a.id as assignee_id, a.name as assignee_name, a.kind as assignee_kind,
         par.ref as parent_ref, last.ref as last_item_ref, c.name as created_by_name
  from schedules s
  left join accounts a on a.id = s.assignee_id
  left join item_view par on par.id = s.parent_id
  left join item_view last on last.id = s.last_item_id
  join accounts c on c.id = s.created_by
  where ${where} order by s.created_at`;

export async function listSchedules(actor: Actor, projectRef: string) {
  const project = await resolveProject(actor, projectRef);
  return listSql(sql`s.project_id = ${project.id}`);
}

export async function createSchedule(actor: Actor, projectRef: string, input: ScheduleInput) {
  const project = await requireProjectAdmin(actor, projectRef);
  const n = await normalize(actor, project, input);
  const enabled = input.enabled ?? true;
  const [row] = await sql`
    insert into schedules (project_id, name, cron, timezone, enabled, title, body, status, assignee_id, parent_id, skip_if_open, created_by, next_run_at)
    values (${project.id}, ${input.name.trim()}, ${input.cron.trim()}, ${input.timezone}, ${enabled}, ${input.title.trim()}, ${input.body ?? ''},
            ${input.status ?? null}, ${n.assigneeId}, ${n.parentId}, ${input.skipIfOpen ?? false}, ${actor.id}, ${enabled ? n.next : null})
    returning id`;
  bus.emit('schedules');
  return (await listSql(sql`s.id = ${row.id}`))[0];
}

export async function updateSchedule(actor: Actor, id: string, input: ScheduleInput) {
  const s = await scheduleForAdmin(actor, id);
  const project = await resolveProject(actor, s.projectId);
  const n = await normalize(actor, project, input);
  const enabled = input.enabled ?? s.enabled;
  // Whoever saves a schedule owns it: its items are created as them.
  await sql`
    update schedules set name = ${input.name.trim()}, cron = ${input.cron.trim()}, timezone = ${input.timezone}, enabled = ${enabled},
      title = ${input.title.trim()}, body = ${input.body ?? ''}, status = ${input.status ?? null}, assignee_id = ${n.assigneeId},
      parent_id = ${n.parentId}, skip_if_open = ${input.skipIfOpen ?? false}, next_run_at = ${enabled ? n.next : null}, last_error = null,
      created_by = ${actor.id}
    where id = ${id}`;
  bus.emit('schedules');
  return (await listSql(sql`s.id = ${id}`))[0];
}

export async function deleteSchedule(actor: Actor, id: string) {
  await scheduleForAdmin(actor, id);
  await sql`delete from schedules where id = ${id}`;
}

/** Create the schedule's item now. Used by the scheduler and by "Run now". */
async function runSchedule(s: Record<string, any>, at: Date) {
  const [creator] = await sql`
    select a.id, a.kind, a.name, a.email, a.org_id from accounts a
    join projects p on p.id = ${s.projectId}
    join memberships m on m.account_id = a.id and m.org_id = p.org_id
    where a.id = ${s.createdBy} and a.deactivated_at is null`;
  if (!creator) throw new Error('The person who created this schedule is no longer in the organization; edit and save it to take it over');
  if (s.skipIfOpen && s.lastItemId) {
    const [open] = await sql`select 1 from items where id = ${s.lastItemId} and closed_at is null`;
    if (open) return { skipped: true as const };
  }
  const actor = creator as Actor;
  const project = await resolveProject(actor, s.projectId);
  const item = await createItem(actor, project, {
    type: s.parentId ? 'task' : 'issue',
    parentRef: s.parentId ?? undefined,
    title: fill(s.title, s.timezone, at),
    body: fill(s.body, s.timezone, at),
    status: s.status ?? undefined,
    assignee: s.assigneeId,
    schedule: s.name,
  });
  await sql`update schedules set last_item_id = ${item.id} where id = ${s.id}`;
  return { item };
}

export async function runScheduleNow(actor: Actor, id: string) {
  const s = await scheduleForAdmin(actor, id);
  try {
    const result = await runSchedule(s, new Date());
    await sql`update schedules set last_run_at = now(), last_error = null where id = ${id}`;
    return result.skipped ? { skipped: true, reason: 'the previous item is still open' } : { ref: result.item.ref };
  } catch (e) {
    await sql`update schedules set last_error = ${(e as Error).message} where id = ${id}`;
    throw badRequest((e as Error).message);
  }
}

/**
 * Runs due schedules. Claims each run by advancing next_run_at first, so a slow or failing run is never
 * repeated; after downtime a schedule runs once to catch up, not once per missed slot.
 */
async function runDue() {
  const due = await sql`select * from schedules where enabled and next_run_at <= now() order by next_run_at limit 50`;
  for (const s of due) {
    let next: Date | null;
    try {
      next = nextRun(s.cron, s.timezone);
    } catch {
      next = null; // expression went bad (shouldn't happen: validated on save); stop rather than spin
    }
    // Claim atomically: only while still due (an edit or another tick may have moved it on).
    const claimed = await sql`
      update schedules set next_run_at = ${next}, enabled = ${next !== null}, last_run_at = now()
      where id = ${s.id} and enabled and next_run_at <= now() returning id`;
    if (!claimed.length) continue;
    try {
      await runSchedule(s, s.nextRunAt);
      await sql`update schedules set last_error = null where id = ${s.id}`;
    } catch (e) {
      await sql`update schedules set last_error = ${(e as Error).message} where id = ${s.id}`;
      console.error(`schedule ${s.id}`, e);
    }
  }
}

export function startScheduler() {
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runDue();
      // Sleep until the next due schedule (at most a minute, so edits and clock drift are picked up).
      const [{ next }] = await sql`select min(next_run_at) as next from schedules where enabled`;
      const wait = next ? Math.min(Math.max(new Date(next).getTime() - Date.now(), 0) + 100, 60_000) : 60_000;
      clearTimeout(timer);
      timer = setTimeout(tick, wait);
    } catch (e) {
      console.error('scheduler', e);
      clearTimeout(timer);
      timer = setTimeout(tick, 60_000);
    } finally {
      running = false;
    }
  };
  bus.on('schedules', tick);
  tick();
  return () => {
    clearTimeout(timer);
    bus.off('schedules', tick);
  };
}

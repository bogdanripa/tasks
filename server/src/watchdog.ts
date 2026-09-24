import { bus, sql } from './db.js';
import { config } from './config.js';
import { watchdogSignal } from './domain.js';

/**
 * The watchdog looks for work that has silently stopped: an item assigned to an agent, not in Backlog, not
 * done, not blocked, not an issue waiting on its open tasks, with no run going, nothing queued and no
 * activity for a while (a run cut off by its step limit, one that ended without setting a status, a crash).
 *
 * It nudges the agent (a run that says the work stalled) up to twice per status. When that doesn't help, or
 * the agent can't run at all (not connected), it pings the human who created the project, once, until the
 * item moves again.
 */
const W = config.watchdog;

type Stalled = {
  id: string; ref: string; title: string; status: string; orgId: string; projectId: string;
  agentId: string; agentName: string; connected: boolean; lastActivity: Date;
  nudges: number | null; stateStatus: string | null; escalatedAt: Date | null;
};

/** One pass. Tests scope it to one item and a shorter stall time. */
export async function watchdogTick(opts: { itemId?: string; stallSeconds?: number } = {}) {
  const stalled = (await sql`
    select v.id, v.ref, v.title, v.status, v.org_id, v.project_id,
           a.id as agent_id, a.name as agent_name,
           (a.routine_url is not null or a.webhook_url is not null or a.runtime_provider_id is not null) as connected,
           greatest(v.updated_at, (select max(e.created_at) from events e where e.item_id = v.id),
                    (select max(r.finished_at) from agent_runs r where r.item_id = v.id)) as last_activity,
           w.nudges, w.status as state_status, w.escalated_at
    from item_view v
    join accounts a on a.id = v.assignee_id and a.kind = 'agent' and a.deactivated_at is null
    left join watchdog_state w on w.item_id = v.id
    where not v.done and v.closed_at is null and lower(v.status) <> 'backlog'
      -- blocked items wait for their blockers; issues wait for their open tasks
      and not exists (select 1 from links l join items b on b.id = l.from_id
                      where l.to_id = v.id and l.kind = 'blocks' and l.removed_at is null and b.closed_at is null)
      and not exists (select 1 from item_view t where t.parent_id = v.id and not t.done)
      -- nothing running or queued for it
      and not exists (select 1 from agent_runs r where r.item_id = v.id and r.finished_at is null)
      and not exists (select 1 from notifications n where n.item_id = v.id and n.account_id = a.id and n.delivery_status = 'pending')
      ${opts.itemId ? sql`and v.id = ${opts.itemId}` : sql``}
  `) as unknown as Stalled[];

  const cutoff = Date.now() - (opts.stallSeconds ?? W.stallSeconds) * 1000;
  for (const it of stalled) {
    if (new Date(it.lastActivity).getTime() > cutoff) continue;
    // The count starts over whenever the item changes column.
    const fresh = it.stateStatus !== it.status;
    const nudges = fresh ? 0 : (it.nudges ?? 0);
    if (!fresh && it.escalatedAt) continue; // a human already knows
    const idle = Math.round((Date.now() - new Date(it.lastActivity).getTime()) / 60_000);

    if (it.connected && nudges < W.maxNudges) {
      await sql`
        insert into watchdog_state (item_id, status, nudges, last_nudged_at) values (${it.id}, ${it.status}, ${nudges + 1}, now())
        on conflict (item_id) do update set status = excluded.status, nudges = excluded.nudges, last_nudged_at = now(), escalated_at = null`;
      await watchdogSignal(it, { id: it.agentId, name: it.agentName }, { id: it.agentId }, { ref: it.ref, title: it.title, status: it.status, idleMinutes: idle, nudge: nudges + 1 });
      bus.emit('pulse');
      continue;
    }

    const human = await projectOwner(it.projectId, it.orgId);
    if (!human) continue;
    await sql`
      insert into watchdog_state (item_id, status, nudges, escalated_at) values (${it.id}, ${it.status}, ${nudges}, now())
      on conflict (item_id) do update set status = excluded.status, nudges = excluded.nudges, escalated_at = now()`;
    await watchdogSignal(it, { id: it.agentId, name: it.agentName }, { id: human }, {
      ref: it.ref, title: it.title, status: it.status, idleMinutes: idle, agent: it.agentName,
      why: it.connected ? `still stalled after ${nudges} nudge${nudges === 1 ? '' : 's'}` : `${it.agentName} isn't connected, so it can't work on it`,
    });
  }
}

/** The human who created the project (from its history), or an owner of the org if they've left. */
async function projectOwner(projectId: string, orgId: string): Promise<string | null> {
  const [row] = await sql`
    select coalesce(
      (select a.id from events e join accounts a on a.id = e.actor_id
         join memberships m on m.account_id = a.id and m.org_id = ${orgId}
       where e.project_id = ${projectId} and e.type = 'project.created' and a.kind = 'human' and a.deactivated_at is null limit 1),
      (select m.account_id from memberships m join accounts a on a.id = m.account_id
       where m.org_id = ${orgId} and m.role = 'owner' and a.kind = 'human' and a.deactivated_at is null order by m.created_at limit 1)
    ) as id`;
  return row?.id ?? null;
}

export function startWatchdog() {
  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await watchdogTick();
    } catch (e) {
      console.error('watchdog', e);
    } finally {
      running = false;
    }
  }, W.intervalSeconds * 1000).unref();
}

import { createHmac } from 'node:crypto';
import { fetchError } from './errors.js';
import { sql, bus } from './db.js';
import { config } from './config.js';
import type { Actor } from './auth.js';
import { inbox } from './domain.js';
import { processRoutineQueue, sweepStaleRuns, type Pending } from './routine.js';
import { recoverInterruptedRuns } from './runtime.js';

const QUEUE_LOCK = 72_451_001; // pg advisory lock id for the delivery queue

const MAX_ATTEMPTS = 8;
const BATCH = 20;

/** Signed POST: `X-Tasks-Signature: sha256=hex(hmac(secret, "<timestamp>.<body>"))`. */
export function sign(secret: string, timestamp: string, body: string) {
  return 'sha256=' + createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

async function deliverDue() {
  const due = await sql`
    select n.id, n.reason, n.attempts, n.created_at, n.item_id, a.id as agent_id, a.name as agent_name, a.org_id as agent_org_id,
           a.webhook_url, a.webhook_secret, a.routine_url, a.routine_token_enc, v.assignee_id as item_assignee_id,
           a.runtime_provider_id, a.runtime_model, a.runtime_max_steps,
           lower(v.status) = 'backlog' as item_in_backlog,
           v.closed_at is not null as item_closed,
           exists (select 1 from links l join items b on b.id = l.from_id
                   where l.to_id = n.item_id and l.kind = 'blocks' and l.removed_at is null and b.closed_at is null) as item_blocked,
           e.type as event_type, e.data as event_data, actor.name as actor_name, actor.kind as actor_kind,
           v.ref as item_ref, v.title as item_title, v.type as item_type, v.status as item_status
    from notifications n
    join accounts a on a.id = n.account_id
    join events e on e.id = n.event_id
    join accounts actor on actor.id = e.actor_id
    left join item_view v on v.id = n.item_id
    where n.delivery_status = 'pending' and n.next_attempt_at <= now()
    order by n.id limit ${BATCH}`;

  // Routine agents go through their queue; webhook agents get one POST per notification.
  const routine = due.filter((n) => (n.routineUrl && n.routineTokenEnc) || (n.runtimeProviderId && n.runtimeModel));
  if (routine.length) await processRoutineQueue(routine as unknown as Pending[]);

  await Promise.all(
    due.filter((n) => !routine.includes(n)).map(async (n) => {
      if (!n.webhookUrl) {
        await sql`update notifications set delivery_status = null where id = ${n.id}`;
        return;
      }
      if (n.itemInBacklog || n.itemBlocked) {
        // Parked or waiting on a blocker: stays in the inbox, no ping. Leaving Backlog / the last blocker finishing pings.
        await sql`update notifications set delivery_status = 'skipped', last_error = ${n.itemInBacklog ? 'in backlog' : 'blocked'} where id = ${n.id}`;
        return;
      }
      const body = JSON.stringify({
        id: n.id,
        reason: n.reason,
        agent: { id: n.agentId, name: n.agentName },
        item: n.itemRef && {
          ref: n.itemRef,
          title: n.itemTitle,
          type: n.itemType,
          status: n.itemStatus,
          url: `${config.publicUrl}/app/i/${n.itemRef}`,
        },
        event: { type: n.eventType, data: n.eventData, actor: { name: n.actorName, kind: n.actorKind } },
        mcp: `${config.publicUrl}/mcp`,
        created_at: n.createdAt,
      });
      const ts = String(Math.floor(Date.now() / 1000));
      let error: string | null = null;
      try {
        const res = await fetch(n.webhookUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-tasks-event': n.reason,
            'x-tasks-delivery': String(n.id),
            'x-tasks-timestamp': ts,
            'x-tasks-signature': sign(n.webhookSecret, ts, body),
          },
          body,
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) error = `HTTP ${res.status}`;
      } catch (e) {
        error = fetchError(e);
      }
      const attempts = n.attempts + 1;
      if (!error) {
        await sql`update notifications set delivery_status = 'delivered', attempts = ${attempts}, last_error = null where id = ${n.id}`;
      } else if (attempts >= MAX_ATTEMPTS) {
        await sql`update notifications set delivery_status = 'failed', attempts = ${attempts}, last_error = ${error} where id = ${n.id}`;
      } else {
        const backoff = Math.min(2 ** attempts * 5, 3600); // 10s, 20s, 40s … capped at 1h
        await sql`
          update notifications set attempts = ${attempts}, last_error = ${error},
            next_attempt_at = now() + ${backoff + ' seconds'}::interval
          where id = ${n.id}`;
      }
    }),
  );
  return due.length;
}

export function startDeliveryWorker() {
  let running = false;
  let again = false;
  let wake: NodeJS.Timeout | undefined;
  // Sleep until the next deferred delivery is due (debounce, queue re-check, backoff) rather than polling for it.
  const scheduleWake = async () => {
    const [{ next }] = await sql`select min(next_attempt_at) as next from notifications where delivery_status = 'pending'`;
    clearTimeout(wake);
    if (next) wake = setTimeout(tick, Math.min(Math.max(new Date(next).getTime() - Date.now(), 0) + 50, 60_000));
  };
  const tick = async () => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    // One Tasks process delivers at a time (a rolling deploy briefly runs two), or both could start the same run.
    let lock: Awaited<ReturnType<typeof sql.reserve>> | undefined;
    try {
      lock = await sql.reserve();
      const [{ ok }] = await lock`select pg_try_advisory_lock(${QUEUE_LOCK}) as ok`;
      if (!ok) {
        clearTimeout(wake);
        wake = setTimeout(tick, 5_000); // the other process has it; look again shortly
        return;
      }
      try {
        await sweepStaleRuns(); // release runs that crashed or never reached Tasks before looking at queues
        await recoverInterruptedRuns();
        do {
          again = false;
          while ((await deliverDue()) === BATCH);
        } while (again);
      } finally {
        await lock`select pg_advisory_unlock(${QUEUE_LOCK})`;
      }
      await scheduleWake();
    } catch (e) {
      console.error('delivery worker', e);
    } finally {
      lock?.release();
      running = false;
    }
  };
  bus.on('pulse', tick);
  const timer = setInterval(tick, 60_000); // safety net; scheduleWake handles the precise timing
  tick();
  return () => {
    clearInterval(timer);
    clearTimeout(wake);
    bus.off('pulse', tick);
  };
}

/** Long-poll: resolve with unread notifications as soon as any exist, or [] after the timeout. */
export async function waitForWork(actor: Actor, timeoutMs: number, signal?: AbortSignal) {
  type Rows = Record<string, any>[];
  const check = async (): Promise<Rows> => [...(await inbox(actor, { unreadOnly: true, limit: 50 }))];
  const first = await check();
  if (first.length) return first;
  return new Promise<Rows>((resolve) => {
    let done = false;
    const finish = (rows: Rows) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      bus.off('pulse', onPulse);
      signal?.removeEventListener('abort', onAbort);
      resolve(rows);
    };
    const onPulse = async () => {
      const rows = await check();
      if (rows.length) finish(rows);
    };
    const onAbort = () => finish([]);
    const timer = setTimeout(() => finish([]), timeoutMs);
    bus.on('pulse', onPulse);
    signal?.addEventListener('abort', onAbort);
  });
}

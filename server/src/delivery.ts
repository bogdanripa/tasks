import { createHmac } from 'node:crypto';
import { sql, bus } from './db.js';
import { config } from './config.js';
import type { Actor } from './auth.js';
import { inbox } from './domain.js';

const MAX_ATTEMPTS = 8;
const BATCH = 20;

/** Signed POST: `X-Tasks-Signature: sha256=hex(hmac(secret, "<timestamp>.<body>"))`. */
export function sign(secret: string, timestamp: string, body: string) {
  return 'sha256=' + createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

async function deliverDue() {
  const due = await sql`
    select n.id, n.reason, n.attempts, n.created_at, a.id as agent_id, a.name as agent_name, a.webhook_url, a.webhook_secret,
           e.type as event_type, e.data as event_data, actor.name as actor_name, actor.kind as actor_kind,
           v.ref as item_ref, v.title as item_title, v.type as item_type, v.status as item_status
    from notifications n
    join accounts a on a.id = n.account_id
    join events e on e.id = n.event_id
    join accounts actor on actor.id = e.actor_id
    left join item_view v on v.id = n.item_id
    where n.delivery_status = 'pending' and n.next_attempt_at <= now()
    order by n.id limit ${BATCH}`;

  await Promise.all(
    due.map(async (n) => {
      if (!n.webhookUrl) {
        await sql`update notifications set delivery_status = null where id = ${n.id}`;
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
          url: `${config.publicUrl}/i/${n.itemRef}`,
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
        error = (e as Error).message;
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
  const tick = async () => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        while ((await deliverDue()) === BATCH);
      } while (again);
    } catch (e) {
      console.error('delivery worker', e);
    } finally {
      running = false;
    }
  };
  bus.on('pulse', tick);
  const timer = setInterval(tick, 5000); // picks up retries whose backoff elapsed
  tick();
  return () => {
    clearInterval(timer);
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

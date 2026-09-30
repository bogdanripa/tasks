import { sql } from './db.js';
import { config } from './config.js';
import { sendEmail, type Email } from './mailer.js';

export type DailyJobResult = {
  email: Omit<Email, 'headers' | 'to'>;
  /** Unsubscribe token (see emailPrefs.ts); the scheduler turns it into the link and headers. */
  unsubscribe: string;
  /** Runs once the email was sent (TAS-22 advances its window here). */
  after?: () => Promise<void>;
};

export type DailyJob = {
  topic: string;
  /** Local hour to send at. */
  hour: number;
  defaultEnabled: boolean;
  /** Return null when there is nothing to send. */
  build(account: { id: string; email: string; name: string; timezone: string }, ctx: { localDate: string }): Promise<DailyJobResult | null>;
};

const jobs: DailyJob[] = [];

export function registerDailyJob(job: DailyJob) {
  if (jobs.some((j) => j.topic === job.topic)) throw new Error(`Daily job "${job.topic}" already registered`);
  jobs.push(job);
}

const TAKEOVER_MINUTES = 10;

/** The user's wall-clock date (YYYY-MM-DD) and minutes since local midnight at `now`, DST-safe. */
export function localParts(now: Date, timezone: string): { localDate: string; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return { localDate: `${get('year')}-${get('month')}-${get('day')}`, minutes: Number(get('hour')) * 60 + Number(get('minute')) };
}

/** Insert the day's claim, or take over a crashed one. True when this process now owns the send. */
async function claim(accountId: string, topic: string, localDate: string): Promise<boolean> {
  const ins = await sql`
    insert into email_sends (account_id, topic, local_date, status) values (${accountId}, ${topic}, ${localDate}, 'sending')
    on conflict do nothing returning 1`;
  if (ins.length) return true;
  const took = await sql`
    update email_sends set claimed_at = now()
    where account_id = ${accountId} and topic = ${topic} and local_date = ${localDate}
      and status = 'sending' and claimed_at < now() - make_interval(mins => ${TAKEOVER_MINUTES})
    returning 1`;
  return took.length > 0;
}

async function runJobFor(job: DailyJob, a: { id: string; email: string; name: string; timezone: string }, localDate: string) {
  if (!(await claim(a.id, job.topic, localDate))) return;
  try {
    const built = await job.build(a, { localDate });
    if (!built) {
      await sql`update email_sends set status = 'empty' where account_id = ${a.id} and topic = ${job.topic} and local_date = ${localDate}`;
      return;
    }
    await sendEmail({ ...built.email, to: a.email, unsubscribeUrl: `${config.publicUrl}/api/email/unsubscribe?t=${built.unsubscribe}` });
    await sql`update email_sends set status = 'sent', sent_at = now() where account_id = ${a.id} and topic = ${job.topic} and local_date = ${localDate}`;
    try {
      await built.after?.();
    } catch (e) {
      console.error('mail', job.topic, a.id, 'after hook failed', e);
    }
  } catch (e) {
    console.error('mail', job.topic, a.id, e);
    // Release the claim so the next tick retries within the window. If even that fails, the
    // 10-minute takeover picks it up.
    await sql`delete from email_sends where account_id = ${a.id} and topic = ${job.topic} and local_date = ${localDate} and status = 'sending'`
      .catch((e2) => console.error('mail', 'release claim failed', e2));
  }
}

/** One pass over every job and candidate. `now` is injectable so tests can simulate time across zones. */
export async function mailTick(now: Date = new Date()) {
  const windowMin = config.email.windowHours * 60;
  for (const job of jobs) {
    let candidates: { id: string; email: string; name: string; timezone: string }[];
    try {
      candidates = (await sql`
        select a.id, a.email, a.name, a.timezone from accounts a
        left join email_prefs p on p.account_id = a.id and p.topic = ${job.topic} and p.scope = ''
        where a.kind = 'human' and a.deactivated_at is null and a.email is not null and a.timezone is not null
          and coalesce(p.enabled, ${job.defaultEnabled})`) as unknown as typeof candidates;
    } catch (e) {
      console.error('mail', job.topic, 'candidate query failed', e);
      continue;
    }
    for (const a of candidates) {
      try {
        const { localDate, minutes } = localParts(now, a.timezone);
        const start = job.hour * 60;
        if (minutes < start || minutes >= start + windowMin) continue;
        await runJobFor(job, a, localDate);
      } catch (e) {
        console.error('mail', job.topic, a.id, e); // e.g. an invalid stored time zone: skip this user only
      }
    }
  }
}

export function startMailScheduler() {
  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await mailTick();
    } catch (e) {
      console.error('mail', e);
    } finally {
      running = false;
    }
  }, config.email.tickSeconds * 1000).unref();
}

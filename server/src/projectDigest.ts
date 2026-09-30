import { sql } from './db.js';
import { config } from './config.js';
import { registerDailyJob, type DailyJobResult } from './mailScheduler.js';
import { unsubscribeToken, unsubscribeUrl } from './emailPrefs.js';

const TOPIC = 'project_digest';
/** Allowlist, not blocklist: agent.*, watchdog.*, item.no_reviewer, link.*, task.added (duplicates the task's item.created) and admin events stay out, and so does any future type. */
export const DIGEST_EVENT_TYPES = ['item.created', 'item.updated', 'comment.created', 'item.deleted'];
export const PER_PROJECT_CAP = 50;
export const TOTAL_CAP = 300;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

type Ev = { id: string; type: string; data: any; actor: string; projectId: string };

function describe(e: Ev, lastColumn: string): { verb: string; ref?: string; title?: string } {
  const d = e.data ?? {};
  const base = { ref: d.ref as string | undefined, title: d.title as string | undefined };
  switch (e.type) {
    case 'item.created': return { verb: `created ${d.type ?? 'item'}`, ...base };
    case 'comment.created': return { verb: 'commented on', ...base };
    case 'item.deleted': return { verb: 'deleted', ...base };
    case 'item.updated': {
      const c = (d.changes ?? {}) as Record<string, [unknown, unknown]>;
      const parts: string[] = [];
      for (const [k, v] of Object.entries(c)) {
        const [a, b] = Array.isArray(v) ? v : [null, v];
        if (k === 'status') parts.push(b === lastColumn ? `marked done (${a} → ${b})` : `moved ${a} → ${b}`);
        else if (k === 'assignee') parts.push(`assigned ${a ?? 'nobody'} → ${b ?? 'nobody'}`);
        else parts.push(`changed ${k}`);
      }
      return { verb: parts.join(', ') || 'updated', ...base };
    }
    default: return { verb: 'updated', ...base };
  }
}

export async function buildProjectDigest(
  account: { id: string; email: string; name: string; timezone: string },
): Promise<DailyJobResult | null> {
  // Owned = every project of an org where the person is owner/admin, minus explicit per-project opt-outs.
  const owned = await sql`
    select p.id, p.key, p.name, p.columns, o.slug as org_slug, o.name as org_name
    from projects p join orgs o on o.id = p.org_id
    join memberships m on m.org_id = o.id and m.account_id = ${account.id} and m.role in ('owner', 'admin')
    where not exists (select 1 from email_prefs e where e.account_id = ${account.id} and e.topic = ${TOPIC}
                        and e.scope = p.id::text and not e.enabled)
    order by o.name, p.key`;
  if (!owned.length) return null;

  const [cur] = await sql`select last_event_id from digest_cursors where account_id = ${account.id}`;
  const [{ hi }] = await sql`select coalesce(max(id), 0) as hi from events`;
  const lastId = cur ? String(cur.lastEventId) : '0';
  const rows = await sql`
    select e.id, e.type, e.data, e.project_id, a.name as actor
    from events e join accounts a on a.id = e.actor_id
    where e.project_id in ${sql(owned.map((p) => p.id))}
      and e.type in ${sql(DIGEST_EVENT_TYPES)}
      and e.id > ${lastId} and e.id <= ${hi}
      and e.created_at > now() - ${cur ? sql`interval '7 days'` : sql`interval '24 hours'`}
    order by e.id`;
  if (!rows.length) return null;

  const byProject = new Map<string, Ev[]>();
  for (const r of rows) {
    const list = byProject.get(r.projectId) ?? [];
    list.push({ id: r.id, type: r.type, data: r.data, actor: r.actor, projectId: r.projectId });
    byProject.set(r.projectId, list);
  }

  const text: string[] = [`Hi ${account.name},`, '', 'Here is what changed in your projects since the last summary.'];
  const html: string[] = [`<p>Hi ${esc(account.name)},</p><p>Here is what changed in your projects since the last summary.</p>`];
  let shown = 0;
  let projects = 0;
  for (const p of owned) {
    const evs = byProject.get(p.id);
    if (!evs) continue;
    projects++;
    const link = `${config.publicUrl}/app/${p.orgSlug}/${p.key}`;
    const room = Math.max(0, Math.min(PER_PROJECT_CAP, TOTAL_CAP - shown));
    const visible = evs.slice(0, room);
    shown += visible.length;
    const last = p.columns[p.columns.length - 1];
    text.push('', `== ${p.orgName} / ${p.name} (${p.key}) ==`);
    html.push(`<h3>${esc(p.orgName)} / <a href="${esc(link)}">${esc(p.name)}</a></h3><ul>`);
    for (const e of visible) {
      const d = describe(e, last);
      const url = d.ref ? `${config.publicUrl}/app/i/${d.ref}` : link;
      const label = [d.ref?.split('/').pop(), d.title].filter(Boolean).join(' ');
      text.push(`- ${e.actor} ${d.verb}${label ? ` ${label}` : ''} ${url}`);
      html.push(`<li>${esc(e.actor)} ${esc(d.verb)}${label ? ` <a href="${esc(url)}">${esc(label)}</a>` : ''}</li>`);
    }
    const more = evs.length - visible.length;
    if (more > 0) {
      text.push(`and ${more} more — see ${link}`);
      html.push(`<li>and ${more} more — <a href="${esc(link)}">see the project</a></li>`);
    }
    const unsub = unsubscribeUrl(unsubscribeToken(account.id, TOPIC, p.id));
    text.push(`Unsubscribe from ${p.name}: ${unsub}`);
    html.push(`</ul><p><small><a href="${esc(unsub)}">Unsubscribe from ${esc(p.name)}</a></small></p>`);
  }
  const all = unsubscribeToken(account.id, TOPIC, '');
  const allUrl = unsubscribeUrl(all);
  const settings = `${config.publicUrl}/app/settings`;
  text.push('', `Unsubscribe from all project summaries: ${allUrl}`, `Settings: ${settings}`);
  html.push(`<hr><p><small><a href="${esc(allUrl)}">Unsubscribe from all project summaries</a> · <a href="${esc(settings)}">Settings</a></small></p>`);

  return {
    email: {
      subject: `Project changes: ${rows.length} update${rows.length === 1 ? '' : 's'} in ${projects} project${projects === 1 ? '' : 's'}`,
      text: text.join('\n'),
      html: html.join('\n'),
    },
    unsubscribe: all,
    // Runs only after a successful send, so a failed send retries over the same window.
    after: async () => {
      await sql`
        insert into digest_cursors (account_id, last_event_id, sent_at) values (${account.id}, ${hi}, now())
        on conflict (account_id) do update set last_event_id = excluded.last_event_id, sent_at = excluded.sent_at`;
    },
  };
}

export function registerProjectDigest() {
  registerDailyJob({ topic: TOPIC, hour: 6, defaultEnabled: false, build: (a) => buildProjectDigest(a) });
}

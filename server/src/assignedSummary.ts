import { sql } from './db.js';
import { config } from './config.js';
import { registerDailyJob } from './mailScheduler.js';
import { unsubscribeToken, unsubscribeUrl } from './emailPrefs.js';

export const SUMMARY_TOPIC = 'assigned_summary';
export const SUMMARY_CAP = 200;

type Row = { ref: string; title: string; status: string; project_key: string; project_name: string; org_slug: string; parent_ref: string | null; parent_title: string | null };

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const itemLink = (ref: string) => `${config.publicUrl}/app/i/${ref}`;

/**
 * Open items assigned to the account, restricted to orgs it is a member of right now (an item in an org
 * the user has left must not leak). Backlog is excluded: nobody is working on it. Ordered by org, project
 * key, the project's own column order, then number.
 */
async function openItems(accountId: string): Promise<Row[]> {
  return (await sql`
    select v.ref, v.title, v.status, v.project_key, p.name as project_name, v.org_slug,
           par.ref as parent_ref, par.title as parent_title
    from item_view v
    join memberships m on m.org_id = v.org_id and m.account_id = ${accountId}
    join projects p on p.id = v.project_id
    left join item_view par on par.id = v.parent_id
    where v.assignee_id = ${accountId} and v.closed_at is null and not v.done and lower(v.status) <> 'backlog'
    order by v.org_slug, v.project_key, array_position(p.columns, v.status), v.number`) as unknown as Row[];
}

/** Pure: rows → subject/text/html. Exported for tests. */
export function renderSummary(all: Row[], token: string) {
  const shown = all.slice(0, SUMMARY_CAP);
  const more = all.length - shown.length;
  const groups = new Map<string, Row[]>();
  for (const r of shown) {
    const k = `${r.org_slug}/${r.project_key}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(r);
  }
  const unsub = unsubscribeUrl(token);
  const settings = `${config.publicUrl}/app/settings`;
  const allProjects = new Set(all.map((r) => `${r.org_slug}/${r.project_key}`)).size;
  const subject = `Your open items: ${all.length} in ${allProjects} project${allProjects === 1 ? '' : 's'}`;

  const text: string[] = [subject, ''];
  const html: string[] = [`<h2 style="font:600 18px system-ui,sans-serif">${esc(subject)}</h2>`];
  for (const [k, rows] of groups) {
    text.push(`${k} — ${rows[0].project_name}`);
    html.push(`<h3 style="font:600 15px system-ui,sans-serif;margin:1.2em 0 .3em">${esc(k)} — ${esc(rows[0].project_name)}</h3><ul style="padding-left:1.2em;margin:0">`);
    for (const r of rows) {
      const parent = r.parent_ref ? ` (in ${r.parent_ref} ${r.parent_title})` : '';
      text.push(`  ${r.ref}  ${r.title}${parent} — ${r.status}`, `    ${itemLink(r.ref)}`);
      html.push(`<li><a href="${esc(itemLink(r.ref))}">${esc(r.ref)}</a> ${esc(r.title)}${r.parent_ref ? ` <span style="color:#666">(in ${esc(r.parent_ref)} ${esc(r.parent_title ?? '')})</span>` : ''} — <em>${esc(r.status)}</em></li>`);
    }
    text.push('');
    html.push('</ul>');
  }
  if (more > 0) {
    text.push(`…and ${more} more — see ${config.publicUrl}/app/`, '');
    html.push(`<p>…and ${more} more — <a href="${esc(config.publicUrl)}/app/">see them in Mustered</a></p>`);
  }
  text.push('--', `Unsubscribe from this daily summary: ${unsub}`, `Settings: ${settings}`);
  html.push(`<hr><p style="font:13px system-ui,sans-serif;color:#666"><a href="${esc(unsub)}">Unsubscribe</a> from this daily summary · <a href="${esc(settings)}">Settings</a></p>`);
  return { subject, text: text.join('\n'), html: `<div style="font:14px/1.5 system-ui,sans-serif">${html.join('')}</div>` };
}

registerDailyJob({
  topic: SUMMARY_TOPIC,
  hour: 7,
  defaultEnabled: true,
  async build(account) {
    const rows = await openItems(account.id);
    if (rows.length === 0) return null;
    const token = unsubscribeToken(account.id, SUMMARY_TOPIC);
    return { email: renderSummary(rows, token), unsubscribe: token };
  },
});

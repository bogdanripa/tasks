import { afterCommit, sql, type Db } from './db.js';
import type { Actor } from './auth.js';
import { config } from './config.js';
import { sendEmail } from './mailer.js';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const excerpt = (s: string) => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > 200 ? t.slice(0, 200).trimEnd() + '…' : t;
};

/**
 * Tell a human they were given an item (TAS-34). Decides inside the transaction, sends only after it
 * commits, and never waits on or fails because of the mail server. Same assignee, self-assignment and
 * unassigning are no-ops; agents are filtered out when the assignee is loaded.
 */
export function emailAssignment(
  tx: Db,
  actor: Actor,
  a: { itemId: string; assigneeId: string | null; previousAssigneeId: string | null },
) {
  if (!a.assigneeId || a.assigneeId === a.previousAssigneeId || a.assigneeId === actor.id) return;
  const { itemId, assigneeId } = a;
  afterCommit(tx, async () => {
    let ref = itemId;
    try {
      const [who] = await sql`
        select email from accounts where id = ${assigneeId} and kind = 'human' and email is not null and deactivated_at is null`;
      if (!who) return;
      const [item] = await sql`
        select v.ref, v.type, v.title, v.body, v.org_slug, v.project_key, v.number, p.name as project_name,
               par.title as parent_title, o.slug || '/' || v.project_key || '-' || par.number as parent_ref
        from item_view v
        join projects p on p.id = v.project_id
        left join items par on par.id = v.parent_id
        left join orgs o on o.id = v.org_id
        where v.id = ${itemId}`;
      if (!item) return;
      ref = item.ref;
      const [by] = await sql`select name from accounts where id = ${actor.id}`;
      const assigner: string = by?.name ?? actor.name;
      const url = `${config.publicUrl}/app/i/${item.orgSlug}/${item.projectKey}-${item.number}`;
      const note = excerpt(item.body);
      const parent = item.parentRef ? `${item.parentRef} — ${item.parentTitle}` : null;
      const lines: [string, string][] = [
        ['Type', item.type],
        ['Item', `${item.ref} — ${item.title}`],
        ...(parent ? [['Issue', parent] as [string, string]] : []),
        ['Project', item.projectName],
      ];
      const text = [
        `${assigner} assigned you ${item.ref}: ${item.title}`,
        '',
        ...lines.map(([k, v]) => `${k}: ${v}`),
        ...(note ? ['', note] : []),
        '',
        `Open it: ${url}`,
      ].join('\n');
      const html = `<p>${esc(assigner)} assigned you <b>${esc(item.ref)}</b>: ${esc(item.title)}</p>
<ul>${lines.map(([k, v]) => `<li>${esc(k)}: ${esc(v)}</li>`).join('')}</ul>
${note ? `<p>${esc(note)}</p>` : ''}<p><a href="${esc(url)}">Open it in Tasks</a></p>`;
      await sendEmail({ to: who.email, subject: `${assigner} assigned you ${item.ref}: ${item.title}`, text, html });
    } catch (err) {
      console.error('assignment email failed', { ref, to: assigneeId, error: err instanceof Error ? err.message : String(err) });
    }
  });
}

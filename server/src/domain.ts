import { randomBytes } from 'node:crypto';
import { sql, mutate, type Db } from './db.js';
import type { Actor } from './auth.js';
import { badRequest, forbidden, notFound } from './errors.js';
import { encrypt } from './crypto.js';
import { config } from './config.js';

export type Role = 'owner' | 'admin' | 'member';
export type ItemType = 'issue' | 'task';
export type LinkKind = 'triggered' | 'blocks' | 'relates';

type Row = Record<string, any>;

// ---------- access ----------

export async function orgRole(accountId: string, orgId: string, db: Db = sql): Promise<Role | null> {
  const [m] = await db`select role from memberships where org_id = ${orgId} and account_id = ${accountId}`;
  return (m?.role as Role) ?? null;
}

async function requireMember(actor: Actor, orgId: string, db: Db = sql, admin = false) {
  const role = await orgRole(actor.id, orgId, db);
  if (!role) throw notFound('Organization');
  if (admin && role === 'member') throw forbidden('Requires an org admin');
  return role;
}

export async function resolveOrg(actor: Actor, slug: string, admin = false) {
  const [org] = await sql`select * from orgs where slug = ${slug.toLowerCase()}`;
  if (!org) throw notFound('Organization');
  const role = await requireMember(actor, org.id, sql, admin);
  return { ...org, role } as Row;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROJECT_REF = /^(?:([a-z0-9-]+)\/)?([A-Za-z][A-Za-z0-9]{1,9})$/;
const ITEM_REF = /^(?:([a-z0-9-]+)\/)?([A-Za-z][A-Za-z0-9]{1,9})-(\d+)$/;

/** Accepts a uuid, "org/KEY" or bare "KEY" (must be unambiguous across the actor's orgs). */
export async function resolveProject(actor: Actor, ref: string): Promise<Row> {
  ref = ref.trim();
  let rows: Row[];
  if (UUID.test(ref)) {
    rows = await sql`
      select p.*, o.slug as org_slug from projects p join orgs o on o.id = p.org_id
      join memberships m on m.org_id = p.org_id and m.account_id = ${actor.id}
      where p.id = ${ref}`;
  } else {
    const m = PROJECT_REF.exec(ref);
    if (!m) throw badRequest(`Bad project reference "${ref}" (use ORG/KEY or KEY)`);
    const [, slug, key] = m;
    rows = await sql`
      select p.*, o.slug as org_slug from projects p join orgs o on o.id = p.org_id
      join memberships mm on mm.org_id = p.org_id and mm.account_id = ${actor.id}
      where p.key = ${key.toUpperCase()} ${slug ? sql`and o.slug = ${slug}` : sql``}`;
  }
  if (rows.length === 0) throw notFound(`Project ${ref}`);
  if (rows.length > 1) throw badRequest(`Project key ${ref} is ambiguous; use org/${ref}`);
  return rows[0];
}

/** Accepts a uuid, "org/KEY-12" or "KEY-12". */
export async function resolveItem(actor: Actor, ref: string): Promise<Row> {
  ref = ref.trim();
  let rows: Row[];
  if (UUID.test(ref)) {
    rows = await sql`
      select v.* from item_view v
      join memberships m on m.org_id = v.org_id and m.account_id = ${actor.id}
      where v.id = ${ref}`;
  } else {
    const m = ITEM_REF.exec(ref);
    if (!m) throw badRequest(`Bad item reference "${ref}" (use ORG/KEY-N or KEY-N)`);
    const [, slug, key, num] = m;
    rows = await sql`
      select v.* from item_view v
      join memberships mm on mm.org_id = v.org_id and mm.account_id = ${actor.id}
      where v.project_key = ${key.toUpperCase()} and v.number = ${Number(num)}
      ${slug ? sql`and v.org_slug = ${slug}` : sql``}`;
  }
  if (rows.length === 0) throw notFound(`Item ${ref}`);
  if (rows.length > 1) throw badRequest(`Item ${ref} is ambiguous; prefix it with the org slug`);
  return rows[0];
}

/** Resolve an assignee by id, email or name within an org. */
export async function resolveMember(orgId: string, who: string, db: Db = sql): Promise<Row> {
  const w = who.trim();
  const rows = await db`
    select a.id, a.name, a.kind, a.email from accounts a
    join memberships m on m.account_id = a.id and m.org_id = ${orgId}
    where ${UUID.test(w) ? db`a.id = ${w}` : db`lower(a.email) = ${w.toLowerCase()} or lower(a.name) = ${w.toLowerCase()}`}`;
  if (rows.length === 0) throw badRequest(`"${who}" is not a member of this org`);
  if (rows.length > 1) throw badRequest(`"${who}" matches several members; use their id`);
  return rows[0];
}

// ---------- events & notifications ----------

type EventInput = { orgId: string; projectId?: string | null; itemId?: string | null; actorId: string; type: string; data?: Row };

/** For background workers (e.g. routine runs) that need to write to an item's history. */
export async function recordEvent(e: EventInput) {
  return mutate((tx) => emit(tx, e));
}

async function emit(tx: Db, e: EventInput): Promise<number> {
  const [row] = await tx`
    insert into events (org_id, project_id, item_id, actor_id, type, data)
    values (${e.orgId}, ${e.projectId ?? null}, ${e.itemId ?? null}, ${e.actorId}, ${e.type}, ${tx.json(e.data ?? {})})
    returning id`;
  return Number(row.id);
}

async function notify(tx: Db, accountId: string | null | undefined, eventId: number, itemId: string | null, reason: string, actor: Actor) {
  if (!accountId || accountId === actor.id) return;
  await tx`
    insert into notifications (account_id, event_id, item_id, reason, delivery_status, next_attempt_at)
    select a.id, ${eventId}, ${itemId}, ${reason},
           case when a.routine_url is not null or a.webhook_url is not null then 'pending' end,
           case when a.routine_url is not null then now() + ${config.routineDebounceSeconds + ' seconds'}::interval /* a burst of edits becomes one run */
                when a.webhook_url is not null then now() end
    from accounts a
    where a.id = ${accountId}
      and not exists (select 1 from notifications n where n.account_id = a.id and n.event_id = ${eventId})`;
}

// ---------- orgs, members, agents, projects ----------

export async function listOrgs(actor: Actor) {
  return sql`
    select o.id, o.slug, o.name, m.role from orgs o
    join memberships m on m.org_id = o.id and m.account_id = ${actor.id}
    order by o.name`;
}

export async function createOrg(actor: Actor, input: { slug: string; name: string }) {
  if (actor.kind !== 'human') throw forbidden('Only humans can create organizations');
  return mutate(async (tx) => {
    const [exists] = await tx`select 1 from orgs where slug = ${input.slug}`;
    if (exists) throw badRequest(`Slug "${input.slug}" is taken`);
    const [org] = await tx`insert into orgs (slug, name) values (${input.slug}, ${input.name}) returning *`;
    await tx`insert into memberships (org_id, account_id, role) values (${org.id}, ${actor.id}, 'owner')`;
    await emit(tx, { orgId: org.id, actorId: actor.id, type: 'org.created', data: { name: org.name } });
    return org;
  });
}

export async function orgDetail(actor: Actor, slug: string) {
  const org = await resolveOrg(actor, slug);
  const [projects, members, invites] = await Promise.all([
    sql`
      select p.id, p.key, p.name, p.description,
             count(i.*) filter (where i.closed_at is null)::int as open_items
      from projects p left join items i on i.project_id = p.id
      where p.org_id = ${org.id} group by p.id order by p.key`,
    sql`
      select a.id, a.kind, a.name, a.email, a.avatar_url, m.role,
             case when a.routine_url is not null then 'routine' when a.webhook_url is not null then 'webhook' else 'poll' end as delivery,
             case when ${org.role !== 'member'} then a.webhook_url end as webhook_url
      from memberships m join accounts a on a.id = m.account_id
      where m.org_id = ${org.id} order by a.kind desc, a.name`,
    org.role === 'member' ? [] : sql`select email, role, created_at from invites where org_id = ${org.id} order by created_at`,
  ]);
  return { org, projects, members, invites };
}

/**
 * Owner-only, and the caller must repeat the slug. Cascades to projects, items, comments, links
 * (including links from other orgs' items), events, invites, memberships and the org's agents.
 */
export async function deleteOrg(actor: Actor, slug: string, confirm: string) {
  const org = await resolveOrg(actor, slug);
  if (org.role !== 'owner') throw forbidden('Only an owner can delete an organization');
  if (confirm !== org.slug) throw badRequest(`Type the organization slug "${org.slug}" to confirm`);
  // Explicit order: the org's agents are referenced (created_by, actor_id, author_id) by rows that a
  // single cascading delete would only reach after the agents themselves, failing the FK check.
  await mutate(async (tx) => {
    await tx`delete from projects where org_id = ${org.id}`;
    await tx`delete from events where org_id = ${org.id}`;
    await tx`delete from orgs where id = ${org.id}`;
  });
}

/** Unassign everything open that `accountId` holds in the org, recording it in each item's history. */
async function unassignAll(tx: Db, actor: Actor, orgId: string, accountId: string, name: string) {
  const items = await tx`
    update items i set assignee_id = null, updated_at = now()
    from projects p
    where p.id = i.project_id and p.org_id = ${orgId} and i.assignee_id = ${accountId} and i.closed_at is null
    returning i.id, i.project_id, i.title, p.key, i.number`;
  const [org] = await tx`select slug from orgs where id = ${orgId}`;
  for (const i of items) {
    await emit(tx, {
      orgId, projectId: i.projectId, itemId: i.id, actorId: actor.id, type: 'item.updated',
      data: { ref: `${org.slug}/${i.key}-${i.number}`, title: i.title, changes: { assignee: [name, null] } },
    });
  }
  return items.length;
}

async function deactivateAgent(tx: Db, actor: Actor, agent: Row) {
  const unassigned = await unassignAll(tx, actor, agent.orgId, agent.id, agent.name);
  await tx`delete from memberships where account_id = ${agent.id}`;
  await tx`update api_keys set revoked_at = now() where account_id = ${agent.id} and revoked_at is null`;
  await tx`
    update accounts set deactivated_at = now(), webhook_url = null, routine_url = null, routine_token_enc = null
    where id = ${agent.id}`;
  await tx`
    update notifications set delivery_status = 'skipped', last_error = 'agent deleted'
    where account_id = ${agent.id} and delivery_status = 'pending'`;
  await tx`update agent_runs set finished_at = now() where agent_id = ${agent.id} and finished_at is null`;
  await emit(tx, { orgId: agent.orgId, actorId: actor.id, type: 'agent.deleted', data: { agentId: agent.id, name: agent.name, unassigned } });
  return { unassigned };
}

export async function deleteAgent(actor: Actor, agentId: string) {
  const agent = await requireAgentAdmin(actor, agentId);
  return mutate((tx) => deactivateAgent(tx, actor, agent));
}

/**
 * Remove someone from an org. Admins remove members and agents; only owners remove admins or owners;
 * anyone may leave; the last owner stays. Their open items in the org are unassigned.
 */
export async function removeMember(actor: Actor, slug: string, accountId: string) {
  const self = accountId === actor.id;
  const org = await resolveOrg(actor, slug, !self);
  const [target] = await sql`
    select a.id, a.kind, a.name, a.org_id, m.role from memberships m join accounts a on a.id = m.account_id
    where m.org_id = ${org.id} and m.account_id = ${accountId}`;
  if (!target) throw notFound('Member');
  if (!self && target.role !== 'member' && org.role !== 'owner') throw forbidden('Only an owner can remove an admin or owner');
  return mutate(async (tx) => {
    if (target.role === 'owner') {
      const [{ n }] = await tx`select count(*)::int as n from memberships where org_id = ${org.id} and role = 'owner'`;
      if (n <= 1) throw badRequest('An organization needs at least one owner. Make someone else an owner first, or delete the organization.');
    }
    if (target.kind === 'agent') return deactivateAgent(tx, actor, target);
    const unassigned = await unassignAll(tx, actor, org.id, target.id, target.name);
    await tx`delete from memberships where org_id = ${org.id} and account_id = ${target.id}`;
    await emit(tx, { orgId: org.id, actorId: actor.id, type: self ? 'member.left' : 'member.removed', data: { accountId: target.id, name: target.name, unassigned } });
    return { unassigned };
  });
}

export async function cancelInvite(actor: Actor, slug: string, email: string) {
  const org = await resolveOrg(actor, slug, true);
  const rows = await sql`delete from invites where org_id = ${org.id} and email = ${email.toLowerCase()} returning email`;
  if (!rows.length) throw notFound('Invite');
}

export async function inviteMember(actor: Actor, slug: string, email: string, role: 'admin' | 'member') {
  const org = await resolveOrg(actor, slug, true);
  email = email.trim().toLowerCase();
  return mutate(async (tx) => {
    const [existing] = await tx`select id from accounts where lower(email) = ${email} and kind = 'human'`;
    if (existing) {
      await tx`insert into memberships (org_id, account_id, role) values (${org.id}, ${existing.id}, ${role}) on conflict do nothing`;
      await emit(tx, { orgId: org.id, actorId: actor.id, type: 'member.added', data: { email, role } });
      return { added: true };
    }
    await tx`
      insert into invites (org_id, email, role, invited_by) values (${org.id}, ${email}, ${role}, ${actor.id})
      on conflict (org_id, email) do update set role = excluded.role`;
    return { invited: true };
  });
}

function checkWebhook(url: string | null | undefined) {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw badRequest('Webhook URL is not a valid URL');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw badRequest('Webhook URL must be http(s)');
  return u.toString();
}

export async function createAgent(actor: Actor, slug: string, input: { name: string; webhookUrl?: string | null }) {
  const org = await resolveOrg(actor, slug, true);
  const webhook = checkWebhook(input.webhookUrl);
  return mutate(async (tx) => {
    const [agent] = await tx`
      insert into accounts (kind, name, org_id, webhook_url, webhook_secret, created_by)
      values ('agent', ${input.name}, ${org.id}, ${webhook}, ${randomBytes(24).toString('base64url')}, ${actor.id})
      returning id, name, kind, webhook_url, webhook_secret`;
    await tx`insert into memberships (org_id, account_id, role) values (${org.id}, ${agent.id}, 'member')`;
    await emit(tx, { orgId: org.id, actorId: actor.id, type: 'agent.created', data: { agentId: agent.id, name: agent.name } });
    return agent;
  });
}

/** Agents are managed by admins of their home org. */
export async function requireAgentAdmin(actor: Actor, agentId: string) {
  const [agent] = await sql`select * from accounts where id = ${agentId} and kind = 'agent' and deactivated_at is null`;
  if (!agent) throw notFound('Agent');
  await requireMember(actor, agent.orgId, sql, true);
  return agent;
}

/** Accepts the routine's full /fire URL or just its id. */
function checkRoutineUrl(value: string) {
  const v = value.trim();
  const prefix = `${config.routineApiBase}/v1/claude_code/routines/`;
  const url = /^[A-Za-z0-9_-]+$/.test(v) ? `${prefix}${v}/fire` : v;
  const id = url.startsWith(prefix) ? url.slice(prefix.length).replace(/\/fire$/, '') : '';
  if (!/^[A-Za-z0-9_-]+$/.test(id) || !url.endsWith('/fire')) throw badRequest(`Routine URL must look like ${prefix}<id>/fire`);
  return url;
}

export async function updateAgent(
  actor: Actor,
  agentId: string,
  patch: { name?: string; webhookUrl?: string | null; routineUrl?: string | null; routineToken?: string },
) {
  const agent = await requireAgentAdmin(actor, agentId);
  const webhook = patch.webhookUrl === undefined ? undefined : checkWebhook(patch.webhookUrl);
  const routine = patch.routineUrl === undefined ? undefined : patch.routineUrl ? checkRoutineUrl(patch.routineUrl) : null;
  if (routine && !patch.routineToken && !agent.routineTokenEnc) throw badRequest('Paste the routine’s API token too');
  const tokenEnc = routine === null ? null : patch.routineToken ? encrypt(patch.routineToken.trim()) : undefined;
  const [row] = await sql`
    update accounts set
      name = coalesce(${patch.name ?? null}, name),
      webhook_url = ${webhook === undefined ? sql`webhook_url` : webhook},
      routine_url = ${routine === undefined ? sql`routine_url` : routine},
      routine_token_enc = ${tokenEnc === undefined ? sql`routine_token_enc` : tokenEnc}
    where id = ${agentId} returning id, name, webhook_url, webhook_secret, routine_url`;
  return row;
}

export async function listKeys(accountId: string) {
  return sql`
    select id, name, prefix, created_at, last_used_at from api_keys
    where account_id = ${accountId} and revoked_at is null and expires_at is null order by created_at`;
}

export async function revokeKey(actor: Actor, keyId: string) {
  const [key] = await sql`select k.id, k.account_id, a.kind from api_keys k join accounts a on a.id = k.account_id where k.id = ${keyId}`;
  if (!key) throw notFound('Key');
  if (key.accountId !== actor.id) {
    if (key.kind !== 'agent') throw forbidden();
    await requireAgentAdmin(actor, key.accountId);
  }
  await sql`update api_keys set revoked_at = now() where id = ${keyId}`;
}

/** Default project key: the first three letters/digits of the name, uppercased ("Website" → "WEB"). */
export function defaultProjectKey(name: string) {
  const clean = name.normalize('NFD').replace(/[^A-Za-z0-9]/g, '').replace(/^[0-9]+/, '').toUpperCase();
  return clean.length >= 2 ? clean.slice(0, 3) : 'PRJ';
}

export async function createProject(actor: Actor, slug: string, input: { key?: string; name: string; description?: string; columns?: string[] }) {
  const org = await resolveOrg(actor, slug, true);
  let key = input.key?.toUpperCase();
  if (!key) {
    // No explicit key: derive one and take the first free variant (WEB, WEB2, WEB3, …).
    const base = defaultProjectKey(input.name);
    const taken = new Set((await sql`select key from projects where org_id = ${org.id} and key like ${base + '%'}`).map((r) => r.key));
    key = base;
    for (let n = 2; taken.has(key); n++) key = `${base}${n}`;
  }
  const columns = input.columns?.map((c) => c.trim()).filter(Boolean);
  if (columns && columns.length < 2) throw badRequest('A project needs at least two columns');
  return mutate(async (tx) => {
    const [dupe] = await tx`select 1 from projects where org_id = ${org.id} and key = ${key}`;
    if (dupe) throw badRequest(`Project key ${key} already exists`);
    const [p] = await tx`
      insert into projects (org_id, key, name, description ${columns ? tx`, columns` : tx``})
      values (${org.id}, ${key}, ${input.name}, ${input.description ?? ''} ${columns ? tx`, ${columns}` : tx``})
      returning *`;
    await emit(tx, { orgId: org.id, projectId: p.id, actorId: actor.id, type: 'project.created', data: { key, name: p.name } });
    return { ...p, orgSlug: org.slug };
  });
}

export async function listProjects(actor: Actor) {
  return sql`
    select o.slug || '/' || p.key as ref, p.key, p.name, p.description, p.columns, o.slug as org_slug
    from projects p join orgs o on o.id = p.org_id
    join memberships m on m.org_id = p.org_id and m.account_id = ${actor.id}
    order by o.slug, p.key`;
}

// ---------- items ----------

const doneColumn = (p: Row) => p.columns[p.columns.length - 1] as string;

export async function listItems(project: Row, f: { status?: string; type?: ItemType; assigneeId?: string; open?: boolean } = {}) {
  return sql`
    select v.id, v.ref, v.number, v.type, v.title, v.status, v.position, v.assignee_id, v.assignee_name, v.assignee_kind,
           v.parent_id, par.ref as parent_ref, v.done, v.created_at, v.updated_at,
           (select count(*)::int from items c where c.parent_id = v.id) as tasks_total,
           (select count(*)::int from items c where c.parent_id = v.id and c.closed_at is not null) as tasks_done,
           (select count(*)::int from links l where (l.from_id = v.id or l.to_id = v.id) and l.removed_at is null) as link_count
    from item_view v
    left join item_view par on par.id = v.parent_id
    where v.project_id = ${project.id}
      ${f.status ? sql`and v.status = ${f.status}` : sql``}
      ${f.type ? sql`and v.type = ${f.type}` : sql``}
      ${f.assigneeId ? sql`and v.assignee_id = ${f.assigneeId}` : sql``}
      ${f.open ? sql`and v.closed_at is null` : sql``}
    order by v.position, v.number`;
}

export async function assignedTo(actor: Actor, accountId: string, includeDone = false) {
  return sql`
    select v.ref, v.type, v.title, v.status, v.done, v.updated_at, par.ref as parent_ref
    from item_view v
    join memberships m on m.org_id = v.org_id and m.account_id = ${actor.id}
    left join item_view par on par.id = v.parent_id
    where v.assignee_id = ${accountId} ${includeDone ? sql`` : sql`and v.closed_at is null`}
    order by v.updated_at desc limit 200`;
}

export type CreateItemInput = {
  type: ItemType;
  title: string;
  body?: string;
  parentRef?: string;
  assignee?: string | null;
  status?: string;
  triggeredBy?: string;
};

export async function createItem(actor: Actor, project: Row, input: CreateItemInput) {
  const title = input.title.trim();
  if (!title) throw badRequest('Title is required');
  const parent = input.parentRef ? await resolveItem(actor, input.parentRef) : null;
  if (input.type === 'task') {
    if (!parent) throw badRequest('A task must belong to an issue (parent)');
    if (parent.type !== 'issue') throw badRequest('A task’s parent must be an issue');
    if (parent.projectId !== project.id) throw badRequest('A task must live in the same project as its issue');
  } else if (parent) {
    throw badRequest('Issues cannot have a parent; use triggered_by to link issues');
  }
  const trigger = input.triggeredBy ? await resolveItem(actor, input.triggeredBy) : null;
  const status = input.status ?? project.columns[0];
  if (!project.columns.includes(status)) throw badRequest(`Unknown status "${status}". Columns: ${project.columns.join(', ')}`);

  return mutate(async (tx) => {
    const assignee = input.assignee ? await resolveMember(project.orgId, input.assignee, tx) : null;
    const [{ n }] = await tx`update projects set next_number = next_number + 1 where id = ${project.id} returning next_number - 1 as n`;
    const [{ pos }] = await tx`select coalesce(max(position), 0) + 1 as pos from items where project_id = ${project.id} and status = ${status}`;
    const [item] = await tx`
      insert into items (project_id, number, type, parent_id, title, body, status, position, assignee_id, created_by, closed_at)
      values (${project.id}, ${n}, ${input.type}, ${parent?.id ?? null}, ${title}, ${input.body ?? ''}, ${status}, ${pos},
              ${assignee?.id ?? null}, ${actor.id}, ${status === doneColumn(project) ? tx`now()` : null})
      returning id`;
    const ref = `${project.orgSlug}/${project.key}-${n}`;
    const ev = await emit(tx, {
      orgId: project.orgId, projectId: project.id, itemId: item.id, actorId: actor.id, type: 'item.created',
      data: { ref, type: input.type, title, status, parentRef: parent?.ref, assignee: assignee?.name, triggeredBy: trigger?.ref },
    });
    if (assignee) await notify(tx, assignee.id, ev, item.id, 'assigned', actor);
    if (parent) {
      const pev = await emit(tx, {
        orgId: project.orgId, projectId: project.id, itemId: parent.id, actorId: actor.id, type: 'task.added', data: { ref, title },
      });
      await notify(tx, parent.assigneeId, pev, parent.id, 'task_added', actor);
    }
    if (trigger) await insertLink(tx, actor, trigger, { id: item.id, ref, projectId: project.id, orgId: project.orgId }, 'triggered');
    return ref;
  }).then((ref) => resolveItem(actor, ref));
}

async function insertLink(tx: Db, actor: Actor, from: Row, to: Row, kind: LinkKind) {
  const [dupe] = await tx`select 1 from links where from_id = ${from.id} and to_id = ${to.id} and kind = ${kind} and removed_at is null`;
  if (dupe) throw badRequest(`${from.ref} already ${kind} ${to.ref}`);
  const [link] = await tx`insert into links (from_id, to_id, kind, created_by) values (${from.id}, ${to.id}, ${kind}, ${actor.id}) returning id`;
  const data = { linkId: link.id, kind, from: from.ref, to: to.ref };
  const e1 = await emit(tx, { orgId: from.orgId, projectId: from.projectId, itemId: from.id, actorId: actor.id, type: 'link.created', data: { ...data, direction: 'out' } });
  const e2 = await emit(tx, { orgId: to.orgId, projectId: to.projectId, itemId: to.id, actorId: actor.id, type: 'link.created', data: { ...data, direction: 'in' } });
  await notify(tx, from.assigneeId, e1, from.id, 'linked', actor);
  await notify(tx, to.assigneeId, e2, to.id, 'linked', actor);
  return link;
}

export async function addLink(actor: Actor, fromRef: string, toRef: string, kind: LinkKind) {
  const [from, to] = await Promise.all([resolveItem(actor, fromRef), resolveItem(actor, toRef)]);
  if (from.id === to.id) throw badRequest('Cannot link an item to itself');
  await mutate((tx) => insertLink(tx, actor, from, to, kind));
  return { from: from.ref, to: to.ref, kind };
}

export async function removeLink(actor: Actor, linkId: string) {
  const [link] = await sql`select * from links where id = ${linkId} and removed_at is null`;
  if (!link) throw notFound('Link');
  if (link.kind === 'triggered') throw badRequest('Triggered links are permanent');
  const [from, to] = await Promise.all([resolveItem(actor, link.fromId), resolveItem(actor, link.toId)]);
  await mutate(async (tx) => {
    await tx`update links set removed_at = now() where id = ${linkId}`;
    const data = { linkId, kind: link.kind, from: from.ref, to: to.ref };
    const e1 = await emit(tx, { orgId: from.orgId, projectId: from.projectId, itemId: from.id, actorId: actor.id, type: 'link.removed', data });
    const e2 = await emit(tx, { orgId: to.orgId, projectId: to.projectId, itemId: to.id, actorId: actor.id, type: 'link.removed', data });
    await notify(tx, from.assigneeId, e1, from.id, 'unlinked', actor);
    await notify(tx, to.assigneeId, e2, to.id, 'unlinked', actor);
  });
}

export type ItemPatch = { title?: string; body?: string; status?: string; assignee?: string | null; position?: number };

export async function updateItem(actor: Actor, ref: string, patch: ItemPatch) {
  const item = await resolveItem(actor, ref);
  const [project] = await sql`select * from projects where id = ${item.projectId}`;
  if (patch.status !== undefined && !project.columns.includes(patch.status)) {
    throw badRequest(`Unknown status "${patch.status}". Columns: ${project.columns.join(', ')}`);
  }
  if (patch.title !== undefined && !patch.title.trim()) throw badRequest('Title cannot be empty');

  await mutate(async (tx) => {
    const assignee = patch.assignee ? await resolveMember(item.orgId, patch.assignee, tx) : patch.assignee === null ? null : undefined;
    const changes: Record<string, [unknown, unknown]> = {};
    if (patch.title !== undefined && patch.title.trim() !== item.title) changes.title = [item.title, patch.title.trim()];
    if (patch.body !== undefined && patch.body !== item.body) changes.body = [null, null]; // bodies are long; record that it changed
    if (patch.status !== undefined && patch.status !== item.status) changes.status = [item.status, patch.status];
    if (assignee !== undefined && (assignee?.id ?? null) !== item.assigneeId) changes.assignee = [item.assigneeName, assignee?.name ?? null];
    const moved = patch.position !== undefined && patch.position !== item.position;
    if (Object.keys(changes).length === 0 && !moved) return;

    const status = patch.status ?? item.status;
    const done = doneColumn(project);
    let position = patch.position;
    if (position === undefined && changes.status) {
      const [{ pos }] = await tx`select coalesce(max(position), 0) + 1 as pos from items where project_id = ${project.id} and status = ${status}`;
      position = Number(pos);
    }
    await tx`
      update items set
        title = ${patch.title?.trim() ?? item.title},
        body = ${patch.body ?? item.body},
        status = ${status},
        position = ${position ?? item.position},
        assignee_id = ${assignee === undefined ? item.assigneeId : (assignee?.id ?? null)},
        closed_at = ${status === done ? (item.closedAt ?? new Date()) : null},
        updated_at = now()
      where id = ${item.id}`;
    if (Object.keys(changes).length === 0) return; // pure reorder: not worth a history entry

    const ev = await emit(tx, {
      orgId: item.orgId, projectId: item.projectId, itemId: item.id, actorId: actor.id, type: 'item.updated',
      data: { ref: item.ref, title: patch.title?.trim() ?? item.title, changes },
    });
    if (changes.assignee && assignee) await notify(tx, assignee.id, ev, item.id, 'assigned', actor);
    // A routine run's last step is setting its task's status: that ends the run and lets the agent's queue move.
    if (changes.status && actor.keyId) await finishRun(tx, actor.id, actor.keyId, item.id);

    // Any change by someone else reaches the assignee (for a routine agent, that fires a run).
    await notify(tx, item.assigneeId, ev, item.id, changes.status ? 'status_changed' : 'updated', actor);

    if (changes.status && status === done) {
      // Wake whoever was waiting on this: items it blocks, items that triggered it, and its issue when all tasks are done.
      const waiting = await tx`
        select i.id, coalesce(i.assignee_id, i.created_by) as account_id, l.kind
        from links l join items i on i.id = case when l.kind = 'blocks' then l.to_id else l.from_id end
        where l.removed_at is null and i.closed_at is null and (
          (l.kind = 'blocks' and l.from_id = ${item.id}) or (l.kind = 'triggered' and l.to_id = ${item.id}))
        order by (l.kind = 'blocks') desc`; // one notification per account per event: "unblocked" wins
      for (const w of waiting) await notify(tx, w.accountId, ev, w.id, w.kind === 'blocks' ? 'unblocked' : 'triggered_item_done', actor);
      if (item.parentId) {
        const [open] = await tx`select count(*)::int as n from items where parent_id = ${item.parentId} and closed_at is null`;
        if (open.n === 0) {
          const [parent] = await tx`select id, coalesce(assignee_id, created_by) as account_id from items where id = ${item.parentId}`;
          await notify(tx, parent.accountId, ev, parent.id, 'all_tasks_done', actor);
        }
      }
    }
  });
  return resolveItem(actor, item.id);
}

async function finishRun(tx: Db, agentId: string, keyId: string, itemId: string) {
  const [run] = await tx`
    update agent_runs set finished_at = now()
    where key_id = ${keyId} and item_id = ${itemId} and finished_at is null
    returning id`;
  if (!run) return;
  // Leave the run a few minutes for a closing comment, then the token dies.
  await tx`update api_keys set expires_at = least(expires_at, now() + interval '10 minutes') where id = ${keyId}`;
  await tx`update notifications set next_attempt_at = now() where account_id = ${agentId} and delivery_status = 'pending'`;
}

export async function addComment(actor: Actor, ref: string, body: string) {
  const item = await resolveItem(actor, ref);
  if (!body.trim()) throw badRequest('Comment is empty');
  return mutate(async (tx) => {
    const [c] = await tx`insert into comments (item_id, author_id, body) values (${item.id}, ${actor.id}, ${body}) returning *`;
    const ev = await emit(tx, {
      orgId: item.orgId, projectId: item.projectId, itemId: item.id, actorId: actor.id, type: 'comment.created',
      data: { ref: item.ref, title: item.title, commentId: c.id, excerpt: body.slice(0, 280) },
    });
    await notify(tx, item.assigneeId, ev, item.id, 'commented', actor);
    await notify(tx, item.createdBy, ev, item.id, 'commented', actor);
    return c;
  });
}

const eventCols = sql`
  e.id, e.type, e.data, e.created_at, e.item_id,
  a.id as actor_id, a.name as actor_name, a.kind as actor_kind, a.avatar_url as actor_avatar`;

export async function itemDetail(actor: Actor, ref: string) {
  const item = await resolveItem(actor, ref);
  const [project, parent, tasks, links, comments, history] = await Promise.all([
    sql`select id, key, name, columns from projects where id = ${item.projectId}`.then((r) => r[0]),
    item.parentId ? sql`select ref, title, status, done from item_view where id = ${item.parentId}`.then((r) => r[0]) : null,
    sql`select ref, title, status, done, assignee_name, assignee_kind from item_view where parent_id = ${item.id} order by number`,
    // Links the actor can see; the other end may live in another project or org.
    sql`
      select l.id, l.kind, l.created_at, (l.from_id = ${item.id}) as outgoing,
             o.ref, o.title, o.status, o.done, o.type
      from links l
      join item_view o on o.id = case when l.from_id = ${item.id} then l.to_id else l.from_id end
      join memberships m on m.org_id = o.org_id and m.account_id = ${actor.id}
      where (l.from_id = ${item.id} or l.to_id = ${item.id}) and l.removed_at is null
      order by l.created_at`,
    sql`
      select c.id, c.body, c.created_at, a.id as author_id, a.name as author_name, a.kind as author_kind, a.avatar_url as author_avatar
      from comments c join accounts a on a.id = c.author_id
      where c.item_id = ${item.id} order by c.created_at`,
    sql`
      select ${eventCols} from events e join accounts a on a.id = e.actor_id
      where e.item_id = ${item.id} or e.item_id in (select id from items where parent_id = ${item.id})
      order by e.id desc limit 300`,
  ]);
  return { item, project, parent, tasks, links, comments, history };
}

export async function timeline(project: Row, opts: { before?: number; limit?: number } = {}) {
  const limit = Math.min(opts.limit ?? 50, 200);
  return sql`
    select ${eventCols}, v.ref as item_ref, v.title as item_title, v.type as item_type
    from events e join accounts a on a.id = e.actor_id
    left join item_view v on v.id = e.item_id
    where e.project_id = ${project.id} ${opts.before ? sql`and e.id < ${opts.before}` : sql``}
    order by e.id desc limit ${limit}`;
}

export async function search(actor: Actor, q: string, limit = 30) {
  const like = `%${q.replace(/[%_]/g, '\\$&')}%`;
  return sql`
    select v.ref, v.type, v.title, v.status, v.done, v.assignee_name
    from item_view v join memberships m on m.org_id = v.org_id and m.account_id = ${actor.id}
    where v.title ilike ${like} or v.ref ilike ${like} or v.body ilike ${like}
    order by v.closed_at nulls first, v.updated_at desc limit ${limit}`;
}

// ---------- inbox ----------

export async function inbox(actor: Actor, opts: { unreadOnly?: boolean; afterId?: number; limit?: number } = {}) {
  return sql`
    select n.id, n.reason, n.created_at, n.read_at, e.type as event_type, e.data as event_data,
           a.name as actor_name, a.kind as actor_kind, v.ref as item_ref, v.title as item_title, v.type as item_type, v.status as item_status
    from notifications n
    join events e on e.id = n.event_id
    join accounts a on a.id = e.actor_id
    left join item_view v on v.id = n.item_id
    where n.account_id = ${actor.id}
      and (v.id is null or exists (select 1 from memberships m where m.org_id = v.org_id and m.account_id = ${actor.id}))
      ${opts.unreadOnly ? sql`and n.read_at is null` : sql``}
      ${opts.afterId ? sql`and n.id > ${opts.afterId}` : sql``}
    order by n.id desc limit ${Math.min(opts.limit ?? 50, 200)}`;
}

export async function markRead(actor: Actor, ids: number[] | 'all') {
  if (ids === 'all') await sql`update notifications set read_at = now() where account_id = ${actor.id} and read_at is null`;
  else if (ids.length) await sql`update notifications set read_at = now() where account_id = ${actor.id} and id in ${sql(ids)} and read_at is null`;
}

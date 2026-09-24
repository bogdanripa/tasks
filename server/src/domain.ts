import { randomBytes } from 'node:crypto';
import { sql, mutate, bus, type Db } from './db.js';
import type { Actor } from './auth.js';
import { badRequest, forbidden, notFound } from './errors.js';
import { encrypt } from './crypto.js';
import { config } from './config.js';
import { agentReady, PIPELINE_TEMPLATE, seedStarterAgents, STARTER_AGENTS } from './starter.js';
import { canUseTools } from './llm.js';

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

/**
 * The watchdog's two moves on a stalled item: nudge its agent (a run that says so), or ping a human. Both go in
 * the item's history, recorded as the agent (the watchdog has no account of its own).
 */
export async function watchdogSignal(item: { id: string; orgId: string; projectId: string }, agent: { id: string; name: string }, to: { id: string }, data: Row) {
  const actor: Actor = { id: agent.id, kind: 'agent', name: agent.name, email: null, orgId: item.orgId };
  return mutate(async (tx) => {
    const ev = await emit(tx, { orgId: item.orgId, projectId: item.projectId, itemId: item.id, actorId: agent.id, type: to.id === agent.id ? 'watchdog.nudged' : 'watchdog.escalated', data });
    await notify(tx, to.id, ev, item.id, 'stalled', actor);
  });
}

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

/**
 * Workflow notifications that matter even when you caused them: a task you routed to yourself, a
 * blocker you finished, the last task under your issue. (Edits and comments you make never wake you.)
 */
const SELF_NOTIFY = new Set(['assigned', 'unblocked', 'all_tasks_done', 'triggered_item_done', 'stalled']);

async function notify(tx: Db, accountId: string | null | undefined, eventId: number, itemId: string | null, reason: string, actor: Actor) {
  if (!accountId) return;
  if (accountId === actor.id && !(actor.kind === 'agent' && SELF_NOTIFY.has(reason))) return;
  const quiet = `${config.agentQuietSeconds} seconds`;
  const [row] = await tx`
    insert into notifications (account_id, event_id, item_id, reason, delivery_status, next_attempt_at)
    select a.id, ${eventId}, ${itemId}, ${reason},
           case when a.routine_url is not null or a.webhook_url is not null or a.runtime_provider_id is not null then 'pending' end,
           case when a.routine_url is not null or a.webhook_url is not null or a.runtime_provider_id is not null then now() + ${quiet}::interval end
    from accounts a
    where a.id = ${accountId}
      and not exists (select 1 from notifications n where n.account_id = a.id and n.event_id = ${eventId} and n.item_id is not distinct from ${itemId})
    returning delivery_status`;
  // Quiet period restarts on every change: pushes for this item wait until nobody has touched it for a while.
  if (row?.deliveryStatus === 'pending' && itemId) {
    await tx`
      update notifications set next_attempt_at = greatest(next_attempt_at, now() + ${quiet}::interval)
      where account_id = ${accountId} and item_id = ${itemId} and delivery_status = 'pending'`;
  }
}

// ---------- skills & routing ----------

const SKILL = /^[a-z0-9][a-z0-9-]{0,30}$/;
/** Skills are short lowercase tags: "Backend Dev" → "backend-dev". */
export function normalizeSkill(raw: string) {
  const s = raw.trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (!SKILL.test(s)) throw badRequest(`"${raw}" isn't a valid skill (letters, digits and dashes)`);
  return s;
}
export const SUGGESTED_SKILLS = ['product', 'architecture', 'db', 'backend', 'frontend', 'qa', 'design', 'devops'];

/** The org member with this skill who has the fewest open items (ties: longest-standing member). */
async function pickBySkill(tx: Db, orgId: string, skill: string, exclude: string | null = null) {
  const [m] = await tx`
    select a.id, a.name from memberships m join accounts a on a.id = m.account_id
    where m.org_id = ${orgId} and ${skill} = any(m.skills) and a.deactivated_at is null
      ${exclude ? tx`and a.id <> ${exclude}` : tx``}
    order by (select count(*) from items i join projects p on p.id = i.project_id
              where p.org_id = ${orgId} and i.assignee_id = a.id and i.closed_at is null), m.created_at
    limit 1`;
  return m ?? null;
}

/**
 * If an open item has no assignee, give it to someone: by the skill it needs, else by its column's
 * default skill. Never overrides an assignee someone chose.
 */
async function routeItem(tx: Db, actor: Actor, itemId: string) {
  const [item] = await tx`
    select v.*, p.column_skills from item_view v join projects p on p.id = v.project_id where v.id = ${itemId}`;
  if (!item || item.assigneeId || item.closedAt) return;
  const skill: string | undefined = item.skill ?? item.columnSkills?.[item.status];
  if (!skill) return;
  const member = await pickBySkill(tx, item.orgId, skill);
  if (!member) return; // stays unassigned; the board shows "needs <skill>"
  await tx`update items set assignee_id = ${member.id}, updated_at = now() where id = ${itemId} and assignee_id is null`;
  const ev = await emit(tx, {
    orgId: item.orgId, projectId: item.projectId, itemId, actorId: actor.id, type: 'item.updated',
    data: { ref: item.ref, title: item.title, changes: { assignee: [null, member.name] }, routedBy: skill },
  });
  await notify(tx, member.id, ev, itemId, 'assigned', actor);
}

/**
 * Review hand-off. A task entering a hand-off column (e.g. Review → skill "review") goes to the least
 * busy member with that skill other than its author; sent back out of it to anything but done, it
 * returns to the author. Issues aren't handed off: they stay with their owner.
 */
async function handOff(tx: Db, actor: Actor, itemId: string, from: string, to: string, handoffs: Record<string, string>, done: string) {
  const [cur] = await tx`select * from item_view where id = ${itemId}`;
  if (!cur || cur.type !== 'task') return;
  if (handoffs[to] && !handoffs[from]) {
    const reviewer = await pickBySkill(tx, cur.orgId, handoffs[to], cur.assigneeId);
    if (!reviewer) {
      // Nobody else has the skill: it stays with its author; tell whoever filed it so it isn't stranded.
      const ev = await emit(tx, {
        orgId: cur.orgId, projectId: cur.projectId, itemId, actorId: actor.id, type: 'item.no_reviewer',
        data: { ref: cur.ref, title: cur.title, skill: handoffs[to] },
      });
      await notify(tx, cur.createdBy, ev, itemId, 'needs_reviewer', actor);
      return;
    }
    await tx`update items set assignee_id = ${reviewer.id}, handed_off_from = ${cur.assigneeId} where id = ${itemId}`;
    const ev = await emit(tx, {
      orgId: cur.orgId, projectId: cur.projectId, itemId, actorId: actor.id, type: 'item.updated',
      data: { ref: cur.ref, title: cur.title, changes: { assignee: [cur.assigneeName, reviewer.name] }, handoff: handoffs[to] },
    });
    await notify(tx, reviewer.id, ev, itemId, 'review_requested', actor);
  } else if (handoffs[from] && !handoffs[to]) {
    if (to === done || !cur.handedOffFrom) {
      await tx`update items set handed_off_from = null where id = ${itemId}`;
      return;
    }
    const [author] = await tx`
      select a.id, a.name from accounts a join memberships m on m.account_id = a.id and m.org_id = ${cur.orgId}
      where a.id = ${cur.handedOffFrom} and a.deactivated_at is null`;
    await tx`update items set handed_off_from = null ${author ? tx`, assignee_id = ${author.id}` : tx``} where id = ${itemId}`;
    if (!author) return;
    const ev = await emit(tx, {
      orgId: cur.orgId, projectId: cur.projectId, itemId, actorId: actor.id, type: 'item.updated',
      data: { ref: cur.ref, title: cur.title, changes: { assignee: [cur.assigneeName, author.name] }, returned: true },
    });
    await notify(tx, author.id, ev, itemId, 'changes_requested', actor);
  }
}

/** Route every open, unassigned item in an org (or one project) that some skill could now place. */
async function routeUnassigned(tx: Db, actor: Actor, where: { orgId?: string; projectId?: string }) {
  const items = await tx`
    select i.id from items i join projects p on p.id = i.project_id
    where i.assignee_id is null and i.closed_at is null
      and (i.skill is not null or p.column_skills ? i.status)
      ${where.orgId ? tx`and p.org_id = ${where.orgId}` : tx``}
      ${where.projectId ? tx`and p.id = ${where.projectId}` : tx``}
    order by i.created_at`;
  for (const i of items) await routeItem(tx, actor, i.id);
}

/** Admins set a member's skills (and owners their role); newly placeable work is routed right away. */
export async function updateMember(actor: Actor, slug: string, accountId: string, patch: { skills?: string[]; role?: Role }) {
  const org = await resolveOrg(actor, slug, true);
  const [target] = await sql`select role from memberships where org_id = ${org.id} and account_id = ${accountId}`;
  if (!target) throw notFound('Member');
  if (patch.role && patch.role !== target.role) {
    if (org.role !== 'owner') throw forbidden('Only an owner can change roles');
    const [acc] = await sql`select kind from accounts where id = ${accountId}`;
    if (acc.kind === 'agent' && patch.role !== 'member') throw badRequest('Agents are always members');
  }
  const skills = patch.skills ? [...new Set(patch.skills.map(normalizeSkill))] : undefined;
  return mutate(async (tx) => {
    if (patch.role && target.role === 'owner' && patch.role !== 'owner') {
      const [{ n }] = await tx`select count(*)::int as n from memberships where org_id = ${org.id} and role = 'owner'`;
      if (n <= 1) throw badRequest('An organization needs at least one owner');
    }
    const [m] = await tx`
      update memberships set
        skills = ${skills ? tx`${skills}` : tx`skills`},
        role = ${patch.role ?? target.role}
      where org_id = ${org.id} and account_id = ${accountId} returning skills, role`;
    if (skills) await routeUnassigned(tx, actor, { orgId: org.id });
    return m;
  });
}

// ---------- orgs, members, agents, projects ----------

export async function listOrgs(actor: Actor) {
  return sql`
    select o.id, o.slug, o.name, m.role from orgs o
    join memberships m on m.org_id = o.id and m.account_id = ${actor.id}
    order by o.name`;
}

export async function createOrg(actor: Actor, input: { slug: string; name: string; starterAgents?: boolean }) {
  if (actor.kind !== 'human') throw forbidden('Only humans can create organizations');
  return mutate(async (tx) => {
    const [exists] = await tx`select 1 from orgs where slug = ${input.slug}`;
    if (exists) throw badRequest(`Slug "${input.slug}" is taken`);
    const [org] = await tx`insert into orgs (slug, name) values (${input.slug}, ${input.name}) returning *`;
    await tx`insert into memberships (org_id, account_id, role) values (${org.id}, ${actor.id}, 'owner')`;
    await emit(tx, { orgId: org.id, actorId: actor.id, type: 'org.created', data: { name: org.name } });
    if (input.starterAgents ?? true) await seedStarterAgents(tx, org.id, actor.id);
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
      select a.id, a.kind, a.name, a.email, a.avatar_url, m.role, m.skills,
             case when a.runtime_provider_id is not null then 'builtin' when a.routine_url is not null then 'routine'
                  when a.webhook_url is not null then 'webhook' else 'poll' end as delivery,
             a.description,
             (a.runtime_provider_id is not null or a.routine_url is not null or a.webhook_url is not null
               or exists (select 1 from api_keys k where k.account_id = a.id and k.revoked_at is null and k.last_used_at is not null)) as connected,
             case when ${org.role !== 'member'} then a.webhook_url end as webhook_url
      from memberships m join accounts a on a.id = m.account_id
      where m.org_id = ${org.id} order by a.kind desc, a.name`,
    org.role === 'member' ? [] : sql`select email, role, created_at from invites where org_id = ${org.id} order by created_at`,
  ]);
  const skills = [...new Set([...SUGGESTED_SKILLS, ...members.flatMap((m: Row) => m.skills)])].sort();
  return { org, projects, members, invites, skills, agentReady: await agentReady(sql, org.id) };
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
/** Call after the member lost their membership, so routing doesn't hand the work straight back. */
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
    await routeItem(tx, actor, i.id); // someone else with the skill picks it up
  }
  return items.length;
}

async function deactivateAgent(tx: Db, actor: Actor, agent: Row) {
  await tx`delete from memberships where account_id = ${agent.id}`;
  const unassigned = await unassignAll(tx, actor, agent.orgId, agent.id, agent.name);
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
    await tx`delete from memberships where org_id = ${org.id} and account_id = ${target.id}`;
    const unassigned = await unassignAll(tx, actor, org.id, target.id, target.name);
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

/**
 * Add the starter team (PM, Lead, Dev, QA) to an existing org, skipping names already taken. With a runtime, Tasks
 * runs them itself on that provider and model (the developer gets a higher step limit: every file is a step).
 */
export async function addStarterTeam(actor: Actor, slug: string, runtime?: { providerId: string; model: string } | null) {
  const org = await resolveOrg(actor, slug, true);
  const taken = new Set(
    (await sql`select lower(a.name) as n from accounts a join memberships m on m.account_id = a.id and m.org_id = ${org.id} where a.deactivated_at is null`).map((r) => r.n),
  );
  const created: { id: string; name: string }[] = [];
  for (const a of STARTER_AGENTS) {
    if (taken.has(a.name.toLowerCase())) continue;
    const agent = await createAgent(actor, slug, { name: a.name });
    await sql`update accounts set description = ${a.description} where id = ${agent.id}`;
    await sql`update memberships set skills = ${a.skills} where org_id = ${org.id} and account_id = ${agent.id}`;
    if (runtime) await updateAgent(actor, agent.id, { runtime: { ...runtime, maxSteps: a.skills.includes('backend') ? 80 : 40 } });
    created.push({ id: agent.id, name: a.name });
  }
  return { created, agentReady: await agentReady(sql, org.id) };
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
  patch: {
    name?: string;
    description?: string;
    webhookUrl?: string | null;
    routineUrl?: string | null;
    routineToken?: string;
    runtime?: { providerId: string; model: string; maxSteps?: number } | null;
  },
) {
  const agent = await requireAgentAdmin(actor, agentId);
  if (patch.runtime) {
    const [p] = await sql`select id from ai_providers where id = ${patch.runtime.providerId} and org_id = ${agent.orgId}`;
    if (!p) throw badRequest('Choose one of this organization’s AI providers');
    if (!patch.runtime.model.trim()) throw badRequest('Choose a model');
    if (!canUseTools(patch.runtime.model.trim())) throw badRequest(`${patch.runtime.model} can’t call tools, so it can’t work as an agent. Choose a chat model.`);
  }
  // One way to get work at a time: running in Tasks replaces a routine or webhook, and the other way round.
  if (patch.runtime) Object.assign(patch, { routineUrl: patch.routineUrl ?? null, webhookUrl: patch.webhookUrl ?? null });
  const clearRuntime = patch.runtime === null || (patch.runtime === undefined && (!!patch.routineUrl || !!patch.webhookUrl));
  const webhook = patch.webhookUrl === undefined ? undefined : checkWebhook(patch.webhookUrl);
  const routine = patch.routineUrl === undefined ? undefined : patch.routineUrl ? checkRoutineUrl(patch.routineUrl) : null;
  if (routine && !patch.routineToken && !agent.routineTokenEnc) throw badRequest('Paste the routine’s API token too');
  const tokenEnc = routine === null ? null : patch.routineToken ? encrypt(patch.routineToken.trim()) : undefined;
  const [row] = await sql`
    update accounts set
      name = coalesce(${patch.name ?? null}, name),
      description = coalesce(${patch.description ?? null}, description),
      webhook_url = ${webhook === undefined ? sql`webhook_url` : webhook},
      routine_url = ${routine === undefined ? sql`routine_url` : routine},
      routine_token_enc = ${tokenEnc === undefined ? sql`routine_token_enc` : tokenEnc},
      runtime_provider_id = ${patch.runtime ? patch.runtime.providerId : clearRuntime ? null : sql`runtime_provider_id`},
      runtime_model = ${patch.runtime ? patch.runtime.model.trim() : clearRuntime ? null : sql`runtime_model`},
      runtime_max_steps = ${patch.runtime?.maxSteps ?? sql`runtime_max_steps`}
    where id = ${agentId} returning id, name, webhook_url, webhook_secret, routine_url, runtime_provider_id, runtime_model`;
  if ((routine && !agent.routineUrl) || (webhook && !agent.webhookUrl) || (patch.runtime && !agent.runtimeProviderId)) {
    // Newly connected: deliver unread updates on open items it holds (they were inbox-only until now).
    await sql`
      update notifications n set delivery_status = 'pending', next_attempt_at = now(), last_error = null
      from items i
      where n.account_id = ${agentId} and n.item_id = i.id and i.assignee_id = ${agentId} and i.closed_at is null
        and n.read_at is null and n.delivery_status is null`;
    bus.emit('pulse');
  }
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

const RESERVED_KEYS = new Set(['SETTINGS', 'TIMELINE']); // would collide with app routes

export async function updateOrg(actor: Actor, slug: string, patch: { name?: string; guidelines?: string }) {
  const org = await resolveOrg(actor, slug, true);
  return mutate(async (tx) => {
    const [row] = await tx`
      update orgs set name = coalesce(${patch.name?.trim() || null}, name), guidelines = coalesce(${patch.guidelines ?? null}, guidelines)
      where id = ${org.id} returning *`;
    const changed = [patch.name !== undefined && patch.name.trim() !== org.name && 'name', patch.guidelines !== undefined && patch.guidelines !== org.guidelines && 'guidelines'].filter(Boolean);
    if (changed.length) await emit(tx, { orgId: org.id, actorId: actor.id, type: 'org.updated', data: { changed } });
    return row;
  });
}

type ColumnEdit = { name: string; from?: string | null; skill?: string | null; handoff?: string | null };

/**
 * Admin edits to a project. Columns come as the full new list; `from` names the existing column a row
 * was (renames carry their items along). A removed column must be empty. The last column means done,
 * so items' closed state is recomputed when it changes.
 */
export async function updateProject(
  actor: Actor,
  ref: string,
  patch: { name?: string; description?: string; guidelines?: string; columns?: ColumnEdit[] },
) {
  const project = await resolveProject(actor, ref);
  if ((await orgRole(actor.id, project.orgId)) === 'member') throw forbidden('Requires an org admin');
  const old: string[] = project.columns;
  let columns: string[] | undefined;
  let columnSkills: Record<string, string> | undefined;
  let columnHandoffs: Record<string, string> | undefined;
  const renames: [string, string][] = [];
  if (patch.columns) {
    columns = patch.columns.map((c) => c.name.trim());
    if (columns.length < 2) throw badRequest('A project needs at least two columns');
    if (columns.some((c) => !c)) throw badRequest('Column names can’t be empty');
    if (new Set(columns.map((c) => c.toLowerCase())).size !== columns.length) throw badRequest('Column names must be unique');
    columnSkills = Object.fromEntries(patch.columns.filter((c) => c.skill).map((c) => [c.name.trim(), normalizeSkill(c.skill!)]));
    columnHandoffs = Object.fromEntries(patch.columns.filter((c) => c.handoff).map((c) => [c.name.trim(), normalizeSkill(c.handoff!)]));
    if (columnHandoffs[columns[columns.length - 1]]) throw badRequest('The done column can’t hand off work');
    const kept = new Set(patch.columns.map((c) => c.from).filter(Boolean) as string[]);
    for (const c of patch.columns) {
      if (c.from && !old.includes(c.from)) throw badRequest(`Unknown column "${c.from}"`);
      if (c.from && c.from !== c.name.trim()) renames.push([c.from, c.name.trim()]);
    }
    const removed = old.filter((c) => !kept.has(c));
    if (removed.length) {
      const inUse = await sql`select status, count(*)::int as n from items where project_id = ${project.id} and status in ${sql(removed)} group by status`;
      if (inUse.length) throw badRequest(`Move the items out first: ${inUse.map((r) => `${r.status} has ${r.n}`).join(', ')}`);
    }
  }
  return mutate(async (tx) => {
    if (columns) {
      // Two-step rename so swapping names (A↔B) can't collide.
      for (const [from] of renames) await tx`update items set status = ${'\u0001renaming:' + from} where project_id = ${project.id} and status = ${from}`;
      for (const [from, to] of renames) await tx`update items set status = ${to} where project_id = ${project.id} and status = ${'\u0001renaming:' + from}`;
      // Recurring schedules follow renames; ones targeting a removed column fall back to the first column.
      for (const [from] of renames) await tx`update schedules set status = ${'\u0001renaming:' + from} where project_id = ${project.id} and status = ${from}`;
      for (const [from, to] of renames) await tx`update schedules set status = ${to} where project_id = ${project.id} and status = ${'\u0001renaming:' + from}`;
      await tx`update schedules set status = null where project_id = ${project.id} and status is not null and status <> all(${columns})`;
      const done = columns[columns.length - 1];
      await tx`update items set closed_at = coalesce(closed_at, now()) where project_id = ${project.id} and status = ${done}`;
      await tx`update items set closed_at = null where project_id = ${project.id} and status <> ${done} and closed_at is not null`;
    }
    const [row] = await tx`
      update projects set
        name = coalesce(${patch.name?.trim() || null}, name),
        description = coalesce(${patch.description ?? null}, description),
        guidelines = coalesce(${patch.guidelines ?? null}, guidelines),
        columns = ${columns ? tx`${columns}` : tx`columns`},
        column_skills = ${columnSkills ? tx.json(columnSkills) : tx`column_skills`},
        column_handoffs = ${columnHandoffs ? tx.json(columnHandoffs) : tx`column_handoffs`}
      where id = ${project.id} returning *`;
    const changes: Record<string, unknown> = {};
    if (patch.name !== undefined && patch.name.trim() !== project.name) changes.name = [project.name, patch.name.trim()];
    if (patch.description !== undefined && patch.description !== project.description) changes.description = true;
    if (patch.guidelines !== undefined && patch.guidelines !== project.guidelines) changes.guidelines = true;
    if (columns && columns.join('\n') !== old.join('\n')) changes.columns = [old, columns];
    if (columnSkills && JSON.stringify(columnSkills) !== JSON.stringify(project.columnSkills ?? {})) changes.columnSkills = columnSkills;
    if (columnHandoffs && JSON.stringify(columnHandoffs) !== JSON.stringify(project.columnHandoffs ?? {})) changes.columnHandoffs = columnHandoffs;
    if (columnSkills) await routeUnassigned(tx, actor, { projectId: project.id }); // new defaults may place waiting items
    if (Object.keys(changes).length) {
      await emit(tx, { orgId: project.orgId, projectId: project.id, actorId: actor.id, type: 'project.updated', data: { changes } });
    }
    return { ...row, orgSlug: project.orgSlug };
  });
}

export async function deleteProject(actor: Actor, ref: string, confirm: string) {
  const project = await resolveProject(actor, ref);
  if ((await orgRole(actor.id, project.orgId)) === 'member') throw forbidden('Requires an org admin');
  if (confirm.toUpperCase() !== project.key) throw badRequest(`Type the project key "${project.key}" to confirm`);
  await mutate(async (tx) => {
    await tx`delete from projects where id = ${project.id}`; // items, links, comments and its events cascade
    await emit(tx, { orgId: project.orgId, actorId: actor.id, type: 'project.deleted', data: { key: project.key, name: project.name } });
  });
}

export async function createProject(
  actor: Actor,
  slug: string,
  input: { key?: string; name: string; description?: string; columns?: string[]; setup?: 'agents' | 'blank' },
) {
  const org = await resolveOrg(actor, slug, true);
  // Set up for the agent team (Todo → product, pipeline guidelines) when the org has one, unless asked not to.
  const forAgents = input.setup !== 'blank' && !input.columns && (await agentReady(sql, org.id));
  if (input.setup === 'agents' && !forAgents) throw badRequest('Setting up for agents needs members with product, build (backend/frontend/db) and qa skills');
  let key = input.key?.toUpperCase();
  if (key && RESERVED_KEYS.has(key)) throw badRequest(`"${key}" is reserved; pick another key`);
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
      insert into projects (org_id, key, name, description, guidelines, github_base, column_skills, column_handoffs ${columns ? tx`, columns` : tx``})
      values (${org.id}, ${key}, ${input.name}, ${input.description ?? ''}, ${forAgents ? PIPELINE_TEMPLATE : ''}, ${forAgents ? 'dev' : 'main'},
              ${tx.json(forAgents ? { Todo: 'product' } : {})}, ${tx.json(forAgents ? { Review: 'review' } : {})}
              ${columns ? tx`, ${columns}` : tx``})
      returning *`;
    await emit(tx, { orgId: org.id, projectId: p.id, actorId: actor.id, type: 'project.created', data: { key, name: p.name, setup: forAgents ? 'agents' : 'blank' } });
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

/** True while an agent run on the item is active (fired, not finished, token used recently). */
const workingSql = (itemId: ReturnType<typeof sql>) => sql`exists (
  select 1 from agent_runs r where r.item_id = ${itemId} and r.status = 'fired' and r.finished_at is null)`;
/** Refs of the open items blocking this one. */
const blockersSql = (itemId: ReturnType<typeof sql>) => sql`array(
  select b.ref from links l join item_view b on b.id = l.from_id
  where l.to_id = ${itemId} and l.kind = 'blocks' and l.removed_at is null and b.closed_at is null order by b.number)`;

/** The board's "work is happening" column, if it has one ("In progress", "Doing", "WIP", "Working"). */
export const workingColumn = (columns: string[]) => columns.find((c) => /^(in[ -]?progress|doing|wip|working)$/i.test(c.trim()));

export async function listItems(project: Row, f: { status?: string; type?: ItemType; assigneeId?: string; open?: boolean } = {}) {
  return sql`
    select v.id, v.ref, v.number, v.type, v.title, v.status, v.position, v.assignee_id, v.assignee_name, v.assignee_kind, v.skill,
           ${workingSql(sql`v.id`)} as working, ${blockersSql(sql`v.id`)} as blocked_by,
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
  skill?: string | null;
  /** Set when a recurring schedule created the item; shown in its history. */
  schedule?: string;
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
  // New items start in the first column that isn't Backlog: Backlog is parked work and never wakes agents.
  const status = input.status ?? (project.columns[0].toLowerCase() === 'backlog' && project.columns.length > 2 ? project.columns[1] : project.columns[0]);
  const skill = input.skill ? normalizeSkill(input.skill) : null;
  if (!project.columns.includes(status)) throw badRequest(`Unknown status "${status}". Columns: ${project.columns.join(', ')}`);

  return mutate(async (tx) => {
    const assignee = input.assignee ? await resolveMember(project.orgId, input.assignee, tx) : null;
    const [{ n }] = await tx`update projects set next_number = next_number + 1 where id = ${project.id} returning next_number - 1 as n`;
    const [{ pos }] = await tx`select coalesce(max(position), 0) + 1 as pos from items where project_id = ${project.id} and status = ${status}`;
    const [item] = await tx`
      insert into items (project_id, number, type, parent_id, title, body, status, position, assignee_id, created_by, closed_at, skill)
      values (${project.id}, ${n}, ${input.type}, ${parent?.id ?? null}, ${title}, ${input.body ?? ''}, ${status}, ${pos},
              ${assignee?.id ?? null}, ${actor.id}, ${status === doneColumn(project) ? tx`now()` : null}, ${skill})
      returning id`;
    const ref = `${project.orgSlug}/${project.key}-${n}`;
    const ev = await emit(tx, {
      orgId: project.orgId, projectId: project.id, itemId: item.id, actorId: actor.id, type: 'item.created',
      data: { ref, type: input.type, title, status, parentRef: parent?.ref, assignee: assignee?.name, triggeredBy: trigger?.ref, schedule: input.schedule, skill: skill ?? undefined },
    });
    if (assignee) await notify(tx, assignee.id, ev, item.id, 'assigned', actor);
    if (parent) {
      const pev = await emit(tx, {
        orgId: project.orgId, projectId: project.id, itemId: parent.id, actorId: actor.id, type: 'task.added', data: { ref, title },
      });
      await notify(tx, parent.assigneeId, pev, parent.id, 'task_added', actor);
    }
    if (trigger) await insertLink(tx, actor, trigger, { id: item.id, ref, projectId: project.id, orgId: project.orgId }, 'triggered');
    if (!assignee) await routeItem(tx, actor, item.id);
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
    if (link.kind === 'blocks' && !to.closedAt) {
      const [still] = await tx`
        select 1 from links l join items b on b.id = l.from_id
        where l.to_id = ${to.id} and l.kind = 'blocks' and l.removed_at is null and b.closed_at is null`;
      if (!still) await notify(tx, to.assigneeId, e2, to.id, 'unblocked', actor); // last blocker gone
    }
  });
}

export type ItemPatch = { title?: string; body?: string; status?: string; assignee?: string | null; position?: number; skill?: string | null };

export async function updateItem(actor: Actor, ref: string, patch: ItemPatch) {
  const item = await resolveItem(actor, ref);
  const [project] = await sql`select * from projects where id = ${item.projectId}`;
  if (patch.status !== undefined && !project.columns.includes(patch.status)) {
    throw badRequest(`Unknown status "${patch.status}". Columns: ${project.columns.join(', ')}`);
  }
  if (patch.title !== undefined && !patch.title.trim()) throw badRequest('Title cannot be empty');
  if (actor.kind === 'agent' && item.type === 'issue' && patch.status === doneColumn(project) && item.status !== patch.status) {
    const open = await sql`select ref from item_view where parent_id = ${item.id} and closed_at is null order by number`;
    if (open.length) {
      throw badRequest(`${item.ref} still has open tasks (${open.map((o) => o.ref).join(', ')}). Close the issue after they’re done: Tasks tells you when the last one is, for the definition-of-done check.`);
    }
  }

  await mutate(async (tx) => {
    const assignee = patch.assignee ? await resolveMember(item.orgId, patch.assignee, tx) : patch.assignee === null ? null : undefined;
    const changes: Record<string, [unknown, unknown]> = {};
    if (patch.title !== undefined && patch.title.trim() !== item.title) changes.title = [item.title, patch.title.trim()];
    // Full before/after, so a routine run can be shown what changed. Stripped from history/timeline responses.
    if (patch.body !== undefined && patch.body !== item.body) changes.body = [item.body, patch.body];
    if (patch.status !== undefined && patch.status !== item.status) changes.status = [item.status, patch.status];
    if (assignee !== undefined && (assignee?.id ?? null) !== item.assigneeId) changes.assignee = [item.assigneeName, assignee?.name ?? null];
    const skill = patch.skill === undefined ? undefined : patch.skill ? normalizeSkill(patch.skill) : null;
    if (skill !== undefined && skill !== item.skill) changes.skill = [item.skill, skill];
    const moved = patch.position !== undefined && patch.position !== item.position;
    if (Object.keys(changes).length === 0 && !moved) {
      // A run "setting" the status the task already has (e.g. Done again) still means it's finished.
      if (patch.status && actor.keyId && patch.status !== workingColumn(project.columns)) await finishRun(tx, actor.id, actor.keyId, item.id);
      return;
    }

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
        skill = ${skill === undefined ? item.skill : skill},
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
    // Moving into the working column is "started", not "finished", so it doesn't end the run.
    if (changes.status && actor.keyId && status !== workingColumn(project.columns)) await finishRun(tx, actor.id, actor.keyId, item.id);

    // Any change by someone else reaches the assignee (for a routine agent, that fires a run).
    await notify(tx, item.assigneeId, ev, item.id, changes.status ? 'status_changed' : 'updated', actor);

    // A new column or skill may place an unassigned item; an explicit unassign is respected.
    if ((changes.status || changes.skill) && patch.assignee === undefined) await routeItem(tx, actor, item.id);
    // Review hand-off (and hand-back); an explicit assignment in the same change wins.
    if (changes.status && patch.assignee === undefined) await handOff(tx, actor, item.id, item.status, status, project.columnHandoffs ?? {}, done);
    // A run whose task now belongs to someone else is finished (e.g. a reviewer sending it back to its author).
    if (actor.keyId) {
      const [now] = await tx`select assignee_id from items where id = ${item.id}`;
      if (now.assigneeId !== actor.id) await finishRun(tx, actor.id, actor.keyId, item.id);
    }

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
      await notify(tx, item.createdBy, ev, item.id, 'done', actor); // last, so a more specific reason for the same item wins
    }
  });
  return resolveItem(actor, item.id);
}

/** A run says it's done without changing its task's status (e.g. an issue that now waits on its tasks). */
export async function endRun(actor: Actor) {
  if (!actor.keyId) throw badRequest('Only a routine run (its run token) can end a run');
  const [run] = await sql`select item_id from agent_runs where key_id = ${actor.keyId} and finished_at is null`;
  if (!run) return { ended: false };
  await mutate((tx) => finishRun(tx, actor.id, actor.keyId!, run.itemId));
  return { ended: true };
}

/**
 * The agent is free again: make its queue due now, except updates still inside their item's quiet
 * period (a human may still be editing that item).
 */
export async function requeueAgent(tx: Db, agentId: string) {
  await tx`
    update notifications n set next_attempt_at = greatest(now(), (
      select max(m.created_at) from notifications m
      where m.account_id = n.account_id and m.item_id is not distinct from n.item_id and m.delivery_status = 'pending'
    ) + ${config.agentQuietSeconds + ' seconds'}::interval)
    where n.account_id = ${agentId} and n.delivery_status = 'pending'`;
}

async function finishRun(tx: Db, agentId: string, keyId: string, itemId: string) {
  // clock_timestamp, not now(): the queue compares against it to avoid a stale deferral winning a race.
  const [run] = await tx`
    update agent_runs set finished_at = clock_timestamp()
    where key_id = ${keyId} and item_id = ${itemId} and finished_at is null
    returning id`;
  if (!run) return;
  // Leave the run a few minutes for a closing comment, then the token dies.
  await tx`update api_keys set expires_at = least(expires_at, now() + interval '10 minutes') where id = ${keyId}`;
  await requeueAgent(tx, agentId);
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
    // A person who replies on an unassigned item takes it (agents don't: they comment on items they don't own).
    if (!item.assigneeId && actor.kind === 'human') {
      const [took] = await tx`update items set assignee_id = ${actor.id} where id = ${item.id} and assignee_id is null returning id`;
      if (took) {
        await emit(tx, {
          orgId: item.orgId, projectId: item.projectId, itemId: item.id, actorId: actor.id, type: 'item.updated',
          data: { ref: item.ref, title: item.title, changes: { assignee: [null, actor.name] }, byReply: true },
        });
      }
    }
    return c;
  });
}

// Description edits store the full before/after text; history and timelines only need to know it changed.
const eventCols = sql`
  e.id, e.type, e.created_at, e.item_id,
  case when e.data->'changes' ? 'body' then jsonb_set(e.data, '{changes,body}', '[null, null]') else e.data end as data,
  a.id as actor_id, a.name as actor_name, a.kind as actor_kind, a.avatar_url as actor_avatar`;

export async function itemDetail(actor: Actor, ref: string) {
  const item = await resolveItem(actor, ref);
  const [project, parent, tasks, links, comments, history] = await Promise.all([
    sql`select p.id, p.key, p.name, p.columns, p.column_skills, p.guidelines, o.guidelines as org_guidelines
        from projects p join orgs o on o.id = p.org_id where p.id = ${item.projectId}`.then((r) => r[0]),
    item.parentId ? sql`select ref, title, status, done from item_view where id = ${item.parentId}`.then((r) => r[0]) : null,
    sql`
      select v.ref, v.title, v.status, v.done, v.assignee_name, v.assignee_kind, v.skill,
             ${workingSql(sql`v.id`)} as working, ${blockersSql(sql`v.id`)} as blocked_by
      from item_view v where v.parent_id = ${item.id} order by v.number`,
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

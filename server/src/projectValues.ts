import { sql } from './db.js';
import type { Actor } from './auth.js';
import { badRequest, notFound } from './errors.js';
import { recordEvent, resolveProject } from './domain.js';

/**
 * Project values: shared key/value notes any member (human or agent) can read, set and delete, such as the
 * staging and production URLs. Every run gets them in its assignment. Not for secrets: everyone reads them.
 */
const KEY = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const MAX_VALUE = 2000;
const MAX_KEYS = 100;

export async function projectValues(projectId: string) {
  return sql`
    select v.key, v.value, v.updated_at, a.name as updated_by from project_values v
    left join accounts a on a.id = v.updated_by where v.project_id = ${projectId} order by v.key`;
}

export async function listValues(actor: Actor, projectRef: string) {
  const project = await resolveProject(actor, projectRef);
  return projectValues(project.id);
}

export async function setValue(actor: Actor, projectRef: string, key: string, value: string) {
  const project = await resolveProject(actor, projectRef);
  key = key.trim();
  if (!KEY.test(key)) throw badRequest('Keys: letters, digits, _ . - (up to 64), e.g. staging_url');
  value = value.trim();
  if (!value) throw badRequest('Give a value (delete the key to remove it)');
  if (value.length > MAX_VALUE) throw badRequest(`Values are at most ${MAX_VALUE} characters`);
  const [{ n }] = await sql`select count(*)::int as n from project_values where project_id = ${project.id} and key <> ${key}`;
  if (n >= MAX_KEYS) throw badRequest(`A project holds at most ${MAX_KEYS} values`);
  const [before] = await sql`select value from project_values where project_id = ${project.id} and key = ${key}`;
  await sql`
    insert into project_values (project_id, key, value, updated_by) values (${project.id}, ${key}, ${value}, ${actor.id})
    on conflict (project_id, key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`;
  if (before?.value !== value) {
    await recordEvent({ orgId: project.orgId, projectId: project.id, actorId: actor.id, type: 'project.value_set', data: { key, value, before: before?.value ?? null } });
  }
  return { key, value };
}

export async function deleteValue(actor: Actor, projectRef: string, key: string) {
  const project = await resolveProject(actor, projectRef);
  const [row] = await sql`delete from project_values where project_id = ${project.id} and key = ${key} returning value`;
  if (!row) throw notFound('Value');
  await recordEvent({ orgId: project.orgId, projectId: project.id, actorId: actor.id, type: 'project.value_deleted', data: { key, before: row.value } });
  return { ok: true };
}

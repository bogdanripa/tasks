import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Db } from './db.js';

/** The team a typical project needs; created with a new organization unless the creator opts out. */
export const STARTER_AGENTS = [
  {
    name: 'PM',
    skills: ['product'],
    maxSteps: 60,
    description:
      'You are the product manager. You own issues end to end: write the spec in the repo, ask the human who filed an issue when something is unclear, plan the work as tasks with skills and dependencies, check the result against the definition of done, and deliver it (pull request or merge, per the project guidelines). You don’t write production code yourself.',
  },
  {
    name: 'Lead',
    skills: ['architecture', 'review'],
    maxSteps: 60,
    description:
      'You are the tech lead. You design features (architecture tasks): write the design next to the spec and break the work into tasks with skills and dependencies. You review other people’s code (tasks handed to you in Review): approve by moving the task to Done, or request changes with precise comments and move it back to In progress. You never approve your own work.',
  },
  {
    name: 'Dev',
    skills: ['db', 'backend', 'frontend'],
    maxSteps: 100,
    description:
      'You are the developer. You build database, backend and frontend tasks against the spec and design. Work on a branch per task, keep changes small and tested, never push to main, and move finished work to Review, not Done.',
  },
  {
    name: 'QA',
    skills: ['qa'],
    maxSteps: 120, // browser testing takes many small steps
    description:
      'You are QA. You test features against the acceptance criteria in the spec and file each failure as a precise, reproducible task with the right skill. You don’t fix code yourself.',
  },
];

const templates = new URL('../templates/', import.meta.url);
/** Project guidelines for a team of agents (product → build → QA → product check → deliver). */
export const PIPELINE_TEMPLATE = readFileSync(fileURLToPath(new URL('agent-pipeline.md', templates)), 'utf8');

/** A project can be set up for agents when someone does product, someone builds and someone tests. */
export async function agentReady(db: Db, orgId: string) {
  const [r] = await db`
    select bool_or('product' = any(m.skills)) as product,
           bool_or(m.skills && array['backend', 'frontend', 'db']) as build,
           bool_or('qa' = any(m.skills)) as qa
    from memberships m join accounts a on a.id = m.account_id
    where m.org_id = ${orgId} and a.deactivated_at is null`;
  return !!(r?.product && r?.build && r?.qa);
}

export async function seedStarterAgents(db: Db, orgId: string, createdBy: string) {
  for (const a of STARTER_AGENTS) {
    const [acc] = await db`
      insert into accounts (kind, name, org_id, description, created_by, runtime_max_steps)
      values ('agent', ${a.name}, ${orgId}, ${a.description}, ${createdBy}, ${a.maxSteps}) returning id`;
    await db`insert into memberships (org_id, account_id, role, skills) values (${orgId}, ${acc.id}, 'member', ${a.skills})`;
  }
}

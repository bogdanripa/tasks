import { createHmac, createPrivateKey, randomBytes, timingSafeEqual } from 'node:crypto';
import { SignJWT } from 'jose';
import { sql } from './db.js';
import { config } from './config.js';
import type { Actor } from './auth.js';
import { badRequest, fetchError, HttpError } from './errors.js';
import { orgRole, recordEvent, resolveOrg, resolveProject } from './domain.js';

/**
 * GitHub via the Tasks GitHub App: an org installs it once (choosing repos on GitHub), each project names
 * one repository, and every agent run gets a token limited to that repository, valid for an hour.
 */
const gh = config.github;
export const githubConfigured = () => !!(gh.appId && gh.privateKey && gh.clientId && gh.clientSecret);

async function appJwt() {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ iss: gh.appId })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuedAt(now - 60)
    .setExpirationTime(now + 9 * 60)
    .sign(createPrivateKey(gh.privateKey));
}

export async function ghFetch(path: string, init: RequestInit & { token: string }) {
  let res: Response;
  try {
    res = await fetch(path.startsWith('http') ? path : `${gh.apiBase}${path}`, {
      ...init,
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        authorization: `Bearer ${init.token}`,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new HttpError(502, `GitHub unreachable: ${fetchError(e)}`);
  }
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new HttpError(res.status === 404 ? 404 : 400, `GitHub: ${(body as any)?.message ?? `HTTP ${res.status}`}`);
  return body as any;
}

/** An installation token, optionally limited to one repository (by name). */
export async function installationToken(installationId: number | string, repo?: string) {
  const body = repo ? { repositories: [repo.split('/')[1]], permissions: { contents: 'write', pull_requests: 'write', pages: 'write', metadata: 'read' } } : undefined;
  const t = await ghFetch(`/app/installations/${installationId}/access_tokens`, { method: 'POST', token: await appJwt(), body: body ? JSON.stringify(body) : undefined });
  return { token: t.token as string, expiresAt: new Date(t.expires_at) };
}

// ---------- installing the app for an org ----------

const STATE_COOKIE = 'gh_install';
const sign = (v: string) => createHmac('sha256', config.secretsKey).update(v).digest('base64url');

/** Where to send an admin to install the app; the cookie ties the callback back to this org and person. */
export async function installStart(actor: Actor, slug: string) {
  if (!githubConfigured()) throw badRequest('GitHub isn’t configured on this server');
  const org = await resolveOrg(actor, slug, true);
  const payload = `${org.id}.${actor.id}.${Date.now() + 15 * 60_000}.${randomBytes(8).toString('hex')}`;
  return { url: `${gh.webBase}/apps/${gh.appSlug}/installations/new`, cookie: { name: STATE_COOKIE, value: `${payload}.${sign(payload)}` } };
}

/**
 * GitHub sends the admin back with an installation id and an OAuth code. The installation is only linked
 * after checking, with the admin's own GitHub token, that they can access it; ids alone prove nothing.
 */
export async function installCallback(actor: Actor, q: { code?: string; installation_id?: string; setup_action?: string }, cookie?: string) {
  const parts = cookie?.split('.') ?? [];
  const [orgId, actorId, exp] = parts;
  const payload = parts.slice(0, 4).join('.');
  if (parts.length !== 5 || sign(payload) !== parts[4] || actorId !== actor.id || Number(exp) < Date.now()) {
    throw badRequest('This GitHub installation link expired or was started by someone else. Start again from Settings → GitHub.');
  }
  if ((await orgRole(actor.id, orgId)) === 'member' || !(await orgRole(actor.id, orgId))) throw badRequest('Only an admin can connect GitHub');
  if (!q.code || !q.installation_id) throw badRequest('GitHub didn’t return an installation (was it cancelled?)');
  const tokenRes = await fetch(`${gh.webBase}/login/oauth/access_token`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: gh.clientId, client_secret: gh.clientSecret, code: q.code }),
  }).then((r) => r.json() as any);
  if (!tokenRes.access_token) throw badRequest(`GitHub sign-in failed: ${tokenRes.error_description ?? tokenRes.error ?? 'no token'}`);
  const mine = await ghFetch('/user/installations?per_page=100', { token: tokenRes.access_token });
  const inst = mine.installations.find((i: any) => String(i.id) === String(q.installation_id));
  if (!inst) throw badRequest('That GitHub installation isn’t one your GitHub account can access');
  await sql`
    insert into org_github (org_id, installation_id, account_login, account_type, installed_by)
    values (${orgId}, ${inst.id}, ${inst.account.login}, ${inst.account.type}, ${actor.id})
    on conflict (org_id) do update set installation_id = excluded.installation_id, account_login = excluded.account_login,
      account_type = excluded.account_type, installed_by = excluded.installed_by, created_at = now()`;
  const [org] = await sql`select slug from orgs where id = ${orgId}`;
  await recordEvent({ orgId, actorId: actor.id, type: 'github.connected', data: { account: inst.account.login } });
  return org.slug as string;
}

export async function orgGithub(actor: Actor, slug: string) {
  const org = await resolveOrg(actor, slug);
  const [row] = await sql`select installation_id, account_login, account_type, created_at from org_github where org_id = ${org.id}`;
  if (!row) return { configured: githubConfigured(), connected: false };
  let repos: string[] = [];
  let error: string | null = null;
  try {
    const { token } = await installationToken(row.installationId);
    repos = (await ghFetch('/installation/repositories?per_page=100', { token })).repositories.map((r: any) => r.full_name).sort();
  } catch (e) {
    error = (e as Error).message;
  }
  return {
    configured: true, connected: true, account: row.accountLogin, accountType: row.accountType, since: row.createdAt, repos, error,
    manageUrl: row.accountType === 'Organization'
      ? `${gh.webBase}/organizations/${row.accountLogin}/settings/installations/${row.installationId}`
      : `${gh.webBase}/settings/installations/${row.installationId}`,
  };
}

export async function disconnectGithub(actor: Actor, slug: string) {
  const org = await resolveOrg(actor, slug, true);
  await sql`delete from org_github where org_id = ${org.id}`;
}

/** Point a project at a repository the org's installation can reach (null to unlink). */
export async function setProjectRepo(actor: Actor, projectRef: string, input: { repo: string | null; base?: string; delivery?: 'pr' | 'merge' }) {
  const project = await resolveProject(actor, projectRef);
  if ((await orgRole(actor.id, project.orgId)) === 'member') throw new HttpError(403, 'Requires an org admin');
  if (input.repo) {
    const [inst] = await sql`select installation_id from org_github where org_id = ${project.orgId}`;
    if (!inst) throw badRequest('Connect GitHub for this organization first (Settings → GitHub)');
    const { token } = await installationToken(inst.installationId);
    const repos: string[] = (await ghFetch('/installation/repositories?per_page=100', { token })).repositories.map((r: any) => r.full_name);
    if (!repos.some((r) => r.toLowerCase() === input.repo!.toLowerCase())) throw badRequest(`The GitHub App can’t access ${input.repo}. Add it to the installation on GitHub first.`);
  }
  const [row] = await sql`
    update projects set github_repo = ${input.repo},
      github_base = ${input.base?.trim() || sql`github_base`}, github_delivery = ${input.delivery ?? sql`github_delivery`}
    where id = ${project.id} returning github_repo, github_base, github_delivery`;
  await recordEvent({ orgId: project.orgId, projectId: project.id, actorId: actor.id, type: 'project.updated', data: { changes: { repository: row.githubRepo } } });
  return row;
}

/** For a run: the project's repository and a token limited to it, or null when the project has none. */
export async function runRepo(projectId: string) {
  const [p] = await sql`
    select p.github_repo, p.github_base, p.github_delivery, g.installation_id
    from projects p join org_github g on g.org_id = p.org_id where p.id = ${projectId} and p.github_repo is not null`;
  if (!p || !githubConfigured()) return null;
  const { token, expiresAt } = await installationToken(p.installationId, p.githubRepo);
  return { repo: p.githubRepo as string, base: p.githubBase as string, delivery: p.githubDelivery as 'pr' | 'merge', token, expiresAt };
}

export type RunRepo = NonNullable<Awaited<ReturnType<typeof runRepo>>>;

// ---------- repository operations for in-house agents ----------

const enc = (p: string) => p.split('/').map(encodeURIComponent).join('/');

export function repoOps(r: RunRepo) {
  const api = (path: string, init: Omit<RequestInit, 'body'> & { body?: unknown } = {}) =>
    ghFetch(`/repos/${r.repo}${path}`, { ...init, body: init.body === undefined ? undefined : JSON.stringify(init.body), token: r.token });
  const branchSha = async (branch: string) => (await api(`/git/ref/heads/${enc(branch)}`)).object.sha as string;
  const ensureBranch = async (branch: string) => {
    if (branch === r.base) return;
    try {
      await branchSha(branch);
    } catch (e) {
      if ((e as HttpError).status !== 404) throw e;
      await api('/git/refs', { method: 'POST', body: { ref: `refs/heads/${branch}`, sha: await branchSha(r.base) } });
    }
  };
  return {
    async listFiles(ref?: string) {
      const tree = await api(`/git/trees/${enc(ref ?? r.base)}?recursive=1`);
      return tree.tree.filter((t: any) => t.type === 'blob').map((t: any) => t.path);
    },
    async readFile(path: string, ref?: string) {
      const f = await api(`/contents/${enc(path)}?ref=${encodeURIComponent(ref ?? r.base)}`);
      return Buffer.from(f.content, 'base64').toString('utf8');
    },
    /** Commit files to a branch (created from the base branch if needed), one commit per file. */
    async writeFiles(branch: string, message: string, files: { path: string; content: string }[]) {
      if (branch === r.base && r.delivery === 'pr') throw badRequest(`This project delivers by pull request: commit to a branch, not ${r.base}`);
      await ensureBranch(branch);
      const out: string[] = [];
      for (const f of files) {
        let sha: string | undefined;
        try {
          sha = (await api(`/contents/${enc(f.path)}?ref=${encodeURIComponent(branch)}`)).sha;
        } catch (e) {
          if ((e as HttpError).status !== 404) throw e;
        }
        const res = await api(`/contents/${enc(f.path)}`, {
          method: 'PUT',
          body: { message: files.length > 1 ? `${message} (${f.path})` : message, content: Buffer.from(f.content).toString('base64'), branch, sha },
        });
        out.push(res.commit.sha);
      }
      return { branch, commits: out };
    },
    async openPullRequest(branch: string, title: string, body: string) {
      const pr = await api('/pulls', { method: 'POST', body: { head: branch, base: r.base, title, body } });
      return { number: pr.number, url: pr.html_url };
    },
    async mergePullRequest(number: number) {
      await api(`/pulls/${number}/merge`, { method: 'PUT', body: { merge_method: 'squash' } });
      return { merged: true };
    },
    /** Publish the base branch with GitHub Pages and return the site URL. */
    async publishPages(path: '/' | '/docs' = '/') {
      try {
        await api('/pages', { method: 'POST', body: { source: { branch: r.base, path } } });
      } catch (e) {
        if (!/already/i.test((e as Error).message)) throw e;
      }
      const pages = await api('/pages');
      return { url: pages.html_url as string, status: pages.status as string };
    },
  };
}

// ---------- webhooks: PRs and pushes in item history ----------

export function verifyWebhook(raw: string, signature?: string) {
  if (!gh.webhookSecret || !signature) return false;
  const expected = `sha256=${createHmac('sha256', gh.webhookSecret).update(raw).digest('hex')}`;
  return expected.length === signature.length && timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

/** Link PRs and commits that mention an item (KEY-12) to it, for every org project on that repository. */
export async function handleWebhook(event: string, body: any) {
  const repo: string | undefined = body.repository?.full_name;
  if (!repo || (event !== 'pull_request' && event !== 'push')) return { ignored: true };
  const projects = await sql`
    select p.id, p.key, p.org_id, o.slug from projects p join orgs o on o.id = p.org_id
    join org_github g on g.org_id = p.org_id
    where lower(p.github_repo) = ${repo.toLowerCase()} and g.installation_id = ${body.installation?.id ?? -1}`;
  let recorded = 0;
  for (const p of projects) {
    const mentioned = (text: string) => [...new Set([...text.matchAll(new RegExp(`\\b${p.key}-(\\d+)\\b`, 'gi'))].map((m) => Number(m[1])))];
    const record = async (numbers: number[], type: string, data: Record<string, unknown>) => {
      for (const n of numbers) {
        const [item] = await sql`select id from items where project_id = ${p.id} and number = ${n}`;
        if (!item) continue;
        const [actor] = await sql`select installed_by from org_github where org_id = ${p.orgId}`;
        if (!actor?.installedBy) continue;
        await recordEvent({ orgId: p.orgId, projectId: p.id, itemId: item.id, actorId: actor.installedBy, type, data });
        recorded++;
      }
    };
    if (event === 'pull_request' && ['opened', 'closed', 'reopened'].includes(body.action)) {
      const pr = body.pull_request;
      const action = body.action === 'closed' ? (pr.merged ? 'merged' : 'closed') : body.action;
      await record(mentioned(`${pr.title} ${pr.body ?? ''} ${pr.head?.ref ?? ''}`), 'github.pull_request', {
        action, number: pr.number, title: pr.title, url: pr.html_url, author: pr.user?.login,
      });
    }
    if (event === 'push') {
      for (const c of body.commits ?? []) {
        await record(mentioned(c.message), 'github.commit', {
          sha: String(c.id).slice(0, 7), message: String(c.message).split('\n')[0].slice(0, 200), url: c.url,
          branch: String(body.ref ?? '').replace('refs/heads/', ''), author: c.author?.username ?? c.author?.name,
        });
      }
    }
  }
  return { recorded };
}


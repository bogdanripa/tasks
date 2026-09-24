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
  if (!res.ok) throw new HttpError(res.status === 404 || res.status === 409 ? res.status : 400, `GitHub: ${(body as any)?.message ?? `HTTP ${res.status}`}`);
  return body as any;
}

/** What the installation granted the app (e.g. whether workflows may be written), cached for a few minutes. */
const granted = new Map<string, { at: number; permissions: Record<string, string> }>();
async function installationPermissions(installationId: number | string) {
  const hit = granted.get(String(installationId));
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.permissions;
  const inst = await ghFetch(`/app/installations/${installationId}`, { token: await appJwt() });
  const permissions = (inst?.permissions ?? {}) as Record<string, string>;
  granted.set(String(installationId), { at: Date.now(), permissions });
  return permissions;
}

/**
 * An installation token, optionally limited to one repository (by name). Run tokens can also write GitHub
 * Actions workflows when the installation grants that, so agents can set up CI deploys.
 */
export async function installationToken(installationId: number | string, repo?: string) {
  let body: unknown;
  if (repo) {
    const permissions: Record<string, string> = { contents: 'write', pull_requests: 'write', pages: 'write', metadata: 'read' };
    const has = await installationPermissions(installationId).catch(() => ({}) as Record<string, string>);
    if (has.workflows === 'write') permissions.workflows = 'write';
    body = { repositories: [repo.split('/')[1]], permissions };
  }
  const t = await ghFetch(`/app/installations/${installationId}/access_tokens`, { method: 'POST', token: await appJwt(), body: body ? JSON.stringify(body) : undefined });
  return { token: t.token as string, expiresAt: new Date(t.expires_at) };
}

/** Every repository an installation can reach (GitHub pages them 100 at a time). */
async function installationRepos(installationId: number | string): Promise<string[]> {
  const { token } = await installationToken(installationId);
  const out: string[] = [];
  for (let page = 1; page <= 20; page++) {
    const res = await ghFetch(`/installation/repositories?per_page=100&page=${page}`, { token });
    out.push(...res.repositories.map((r: any) => r.full_name as string));
    if (res.repositories.length < 100 || out.length >= (res.total_count ?? Infinity)) break;
  }
  return out.sort((a, b) => a.localeCompare(b));
}

// ---------- installing the app for an org ----------

const STATE_COOKIE = 'gh_install';
const sign = (v: string) => createHmac('sha256', config.secretsKey).update(v).digest('base64url');

/**
 * Where to send an admin: GitHub's install page, or (existing) GitHub sign-in to pick an installation the app
 * already has, since an account can install an app only once (e.g. it's already used by another Tasks org).
 * The cookie ties the callback back to this org and person.
 */
export async function installStart(actor: Actor, slug: string, existing = false) {
  if (!githubConfigured()) throw badRequest('GitHub isn’t configured on this server');
  const org = await resolveOrg(actor, slug, true);
  const nonce = randomBytes(8).toString('hex');
  const payload = `${org.id}.${actor.id}.${Date.now() + 15 * 60_000}.${nonce}`;
  const url = existing
    ? `${gh.webBase}/login/oauth/authorize?client_id=${encodeURIComponent(gh.clientId)}&redirect_uri=${encodeURIComponent(`${config.publicUrl}/api/github/callback`)}&state=${nonce}`
    : `${gh.webBase}/apps/${gh.appSlug}/installations/new?state=${nonce}`;
  return { url, cookie: { name: STATE_COOKIE, value: `${payload}.${sign(payload)}` } };
}

type Installation = { id: number; account: { login: string; type: string } };

async function linkInstallation(orgId: string, actor: Actor, inst: Installation) {
  await sql`
    insert into org_github (org_id, installation_id, account_login, account_type, installed_by)
    values (${orgId}, ${inst.id}, ${inst.account.login}, ${inst.account.type}, ${actor.id})
    on conflict (org_id) do update set installation_id = excluded.installation_id, account_login = excluded.account_login,
      account_type = excluded.account_type, installed_by = excluded.installed_by, created_at = now()`;
  await recordEvent({ orgId, actorId: actor.id, type: 'github.connected', data: { account: inst.account.login } });
}

/** A signed, short-lived link that links one installation (already checked for this person) to one org. */
const pickSig = (orgId: string, actorId: string, inst: Installation, exp: number) =>
  sign(`pick.${orgId}.${actorId}.${inst.id}.${inst.account.login}.${inst.account.type}.${exp}`);

/**
 * GitHub sends the admin back with an OAuth code (and, after installing, an installation id). An installation
 * is only linked after checking, with the admin's own GitHub token, that they can access it; ids alone prove
 * nothing. Without an installation id, the admin picks one of theirs (linked directly when there's one).
 */
export async function installCallback(
  actor: Actor,
  q: { code?: string; installation_id?: string; setup_action?: string; state?: string },
  cookie?: string,
): Promise<{ slug: string; choices?: { login: string; type: string; link: string }[] }> {
  const parts = cookie?.split('.') ?? [];
  const [orgId, actorId, exp, nonce] = parts;
  const payload = parts.slice(0, 4).join('.');
  if (parts.length !== 5 || sign(payload) !== parts[4] || actorId !== actor.id || Number(exp) < Date.now() || (q.state && q.state !== nonce)) {
    throw badRequest('This GitHub link expired or was started by someone else. Start again from Settings → GitHub.');
  }
  if ((await orgRole(actor.id, orgId)) === 'member' || !(await orgRole(actor.id, orgId))) throw badRequest('Only an admin can connect GitHub');
  if (!q.code) throw badRequest('GitHub didn’t return a sign-in (was it cancelled?)');
  const tokenRes = await fetch(`${gh.webBase}/login/oauth/access_token`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: gh.clientId, client_secret: gh.clientSecret, code: q.code }),
  }).then((r) => r.json() as any);
  if (!tokenRes.access_token) throw badRequest(`GitHub sign-in failed: ${tokenRes.error_description ?? tokenRes.error ?? 'no token'}`);
  const mine: Installation[] = (await ghFetch('/user/installations?per_page=100', { token: tokenRes.access_token })).installations;
  const [org] = await sql`select slug from orgs where id = ${orgId}`;
  if (q.installation_id) {
    const inst = mine.find((i) => String(i.id) === String(q.installation_id));
    if (!inst) throw badRequest('That GitHub installation isn’t one your GitHub account can access');
    await linkInstallation(orgId, actor, inst);
    return { slug: org.slug };
  }
  if (!mine.length) throw badRequest('Your GitHub account can’t access any installation of the Tasks app yet. Use “Install on GitHub” instead.');
  if (mine.length === 1) {
    await linkInstallation(orgId, actor, mine[0]);
    return { slug: org.slug };
  }
  const until = Date.now() + 15 * 60_000;
  return {
    slug: org.slug,
    choices: mine.map((i) => ({
      login: i.account.login,
      type: i.account.type,
      link: `/api/github/pick?${new URLSearchParams({ org: orgId, inst: String(i.id), login: i.account.login, type: i.account.type, exp: String(until), sig: pickSig(orgId, actor.id, i, until) })}`,
    })),
  };
}

/** Follow a signed choice from installCallback. */
export async function pickInstallation(actor: Actor, q: { org: string; inst: string; login: string; type: string; exp: string; sig: string }) {
  const inst = { id: Number(q.inst), account: { login: q.login, type: q.type } };
  if (!['owner', 'admin'].includes((await orgRole(actor.id, q.org)) ?? '')) throw badRequest('Only an admin can connect GitHub');
  if (Number(q.exp) < Date.now() || pickSig(q.org, actor.id, inst, Number(q.exp)) !== q.sig) {
    throw badRequest('This GitHub link expired or was started by someone else. Start again from Settings → GitHub.');
  }
  await linkInstallation(q.org, actor, inst);
  const [org] = await sql`select slug from orgs where id = ${q.org}`;
  return org.slug as string;
}

export async function orgGithub(actor: Actor, slug: string) {
  const org = await resolveOrg(actor, slug);
  const [row] = await sql`select installation_id, account_login, account_type, created_at from org_github where org_id = ${org.id}`;
  if (!row) return { configured: githubConfigured(), connected: false };
  let repos: string[] = [];
  let error: string | null = null;
  try {
    repos = await installationRepos(row.installationId);
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
export async function setProjectRepo(actor: Actor, projectRef: string, input: { repo: string | null; base?: string; prod?: string }) {
  const project = await resolveProject(actor, projectRef);
  if ((await orgRole(actor.id, project.orgId)) === 'member') throw new HttpError(403, 'Requires an org admin');
  if (input.repo) {
    const [inst] = await sql`select installation_id from org_github where org_id = ${project.orgId}`;
    if (!inst) throw badRequest('Connect GitHub for this organization first (Settings → GitHub)');
    const repos = await installationRepos(inst.installationId);
    if (!repos.some((r) => r.toLowerCase() === input.repo!.toLowerCase())) throw badRequest(`The GitHub App can’t access ${input.repo}. Add it to the installation on GitHub first.`);
  }
  const [row] = await sql`
    update projects set github_repo = ${input.repo}, github_base = ${input.base?.trim() || sql`github_base`},
      github_prod = ${input.prod?.trim() || sql`github_prod`}
    where id = ${project.id} returning github_repo, github_base, github_prod`;
  await recordEvent({ orgId: project.orgId, projectId: project.id, actorId: actor.id, type: 'project.updated', data: { changes: { repository: row.githubRepo } } });
  return row;
}

/** For a run: the project's repository and a token limited to it, or null when the project has none. */
export async function runRepo(projectId: string) {
  const [p] = await sql`
    select p.github_repo, p.github_base, p.github_prod, g.installation_id
    from projects p join org_github g on g.org_id = p.org_id where p.id = ${projectId} and p.github_repo is not null`;
  if (!p || !githubConfigured()) return null;
  const { token, expiresAt } = await installationToken(p.installationId, p.githubRepo);
  return { repo: p.githubRepo as string, base: p.githubBase as string, prod: p.githubProd as string, token, expiresAt };
}

export type RunRepo = NonNullable<Awaited<ReturnType<typeof runRepo>>>;

// ---------- repository operations for in-house agents ----------

const enc = (p: string) => p.split('/').map(encodeURIComponent).join('/');

export function repoOps(r: RunRepo) {
  const api = (path: string, init: Omit<RequestInit, 'body'> & { body?: unknown } = {}) =>
    ghFetch(`/repos/${r.repo}${path}`, { ...init, body: init.body === undefined ? undefined : JSON.stringify(init.body), token: r.token });
  const branchSha = async (branch: string) => (await api(`/git/ref/heads/${enc(branch)}`)).object.sha as string;
  const exists = async (branch: string) => {
    try {
      await branchSha(branch);
      return true;
    } catch (e) {
      if ((e as HttpError).status === 404 || (e as HttpError).status === 409) return false; // 409: an empty repository
      throw e;
    }
  };
  /**
   * Make sure a branch exists, creating it from another. A missing source (e.g. dev, not created yet) starts
   * from the repository's default branch, and a brand-new empty repository gets a first commit.
   */
  const ensureBranch = async (branch: string, from: string) => {
    if (await exists(branch)) return;
    const def: string = (await api('')).default_branch;
    if (!(await exists(def))) {
      await api('/contents/README.md', { method: 'PUT', body: { message: 'Initial commit', content: Buffer.from(`# ${r.repo.split('/')[1]}\n`).toString('base64') } });
    }
    if (branch === def) return;
    const source = (await exists(from)) ? from : def;
    await api('/git/refs', { method: 'POST', body: { ref: `refs/heads/${branch}`, sha: await branchSha(source) } });
  };
  return {
    /** Create a branch (from another, default the base branch) if it doesn't exist. */
    async createBranch(branch: string, from = r.prod) {
      await ensureBranch(branch, from);
      return { branch, created: true };
    },
    async listFiles(ref?: string) {
      if (!(await exists(ref ?? r.base))) return { files: [], note: `branch ${ref ?? r.base} doesn't exist yet (it's created on the first write)` };
      const tree = await api(`/git/trees/${enc(ref ?? r.base)}?recursive=1`);
      return tree.tree.filter((t: any) => t.type === 'blob').map((t: any) => t.path);
    },
    async readFile(path: string, ref?: string) {
      const f = await api(`/contents/${enc(path)}?ref=${encodeURIComponent(ref ?? r.base)}`);
      return Buffer.from(f.content, 'base64').toString('utf8');
    },
    /** Commit files to a branch (created from `from`, default the base branch, if needed), one commit per file. */
    async writeFiles(branch: string, message: string, files: { path: string; content: string }[], from = r.base) {
      await ensureBranch(branch, from);
      const out: string[] = [];
      for (const f of files) {
        let sha: string | undefined;
        try {
          sha = (await api(`/contents/${enc(f.path)}?ref=${encodeURIComponent(branch)}`)).sha;
        } catch (e) {
          if ((e as HttpError).status !== 404) throw e;
        }
        let res;
        try {
          res = await api(`/contents/${enc(f.path)}`, {
            method: 'PUT',
            body: { message: files.length > 1 ? `${message} (${f.path})` : message, content: Buffer.from(f.content).toString('base64'), branch, sha },
          });
        } catch (e) {
          if (f.path.startsWith('.github/workflows/')) {
            throw badRequest(`Couldn't write ${f.path}: writing GitHub Actions workflows needs the Workflows permission. An org admin enables "Workflows: Read and write" in the Tasks GitHub App's permissions and accepts it on the installation; ask a human. (${(e as Error).message})`);
          }
          throw e;
        }
        out.push(res.commit.sha);
      }
      return { branch, commits: out };
    },
    async openPullRequest(branch: string, title: string, body: string, into = r.base) {
      await ensureBranch(into, r.base);
      const pr = await api('/pulls', { method: 'POST', body: { head: branch, base: into, title, body } });
      return { number: pr.number, url: pr.html_url };
    },
    async mergePullRequest(number: number) {
      await api(`/pulls/${number}/merge`, { method: 'PUT', body: { merge_method: 'squash' } });
      return { merged: true };
    },
    /** Publish a branch (default the base branch) with GitHub Pages and return the site URL. */
    async publishPages(branch = r.base, path: '/' | '/docs' = '/') {
      try {
        await api('/pages', { method: 'POST', body: { source: { branch, path } } });
      } catch (e) {
        if (!/already/i.test((e as Error).message)) throw e;
        await api('/pages', { method: 'PUT', body: { source: { branch, path } } });
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


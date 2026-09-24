import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { ErrorNote, Time, useFetch } from '../ui';

type OrgGithub = {
  configured: boolean;
  connected: boolean;
  account?: string;
  accountType?: string;
  since?: string;
  repos?: string[];
  error?: string | null;
  manageUrl?: string;
};

/** Org settings tab: install the Tasks GitHub App and see which repositories it reaches. */
export function GithubSection({ org }: { org: string }) {
  const { data, error, reload } = useFetch<OrgGithub>(`/api/orgs/${org}/github`);
  if (error) return <ErrorNote error={error} />;
  if (!data) return <p className="muted">Loading…</p>;
  if (!data.configured) return <p className="muted">GitHub isn’t configured on this server (the GitHub App’s credentials are missing).</p>;

  const install = `/api/orgs/${org}/github/install`;
  const picks: { login: string; type: string; link: string }[] = (() => {
    try {
      const raw = new URLSearchParams(location.search).get('gh_pick');
      return raw ? JSON.parse(atob(raw.replace(/-/g, '+').replace(/_/g, '/'))) : [];
    } catch {
      return [];
    }
  })();
  if (!data.connected) {
    return (
      <div className="stack">
        <p className="muted small">
          Connect the Tasks GitHub App and choose the repositories agents may work on. Then pick a repository in each project’s settings.
          Every agent run gets a token limited to that one repository, valid for an hour.
        </p>
        {picks.length > 0 ? (
          <div className="stack">
            <b>Which installation should this organization use?</b>
            <ul className="rows">
              {picks.map((p) => (
                <li key={p.link}>
                  <b>{p.login}</b> <span className="muted small grow">{p.type === 'Organization' ? 'GitHub organization' : 'GitHub account'}</span>
                  <a className="button small primary" href={p.link}>Use this one</a>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <div className="github-connect">
            <div>
              <a className="button primary" href={install}>Install on GitHub</a>
              <p className="muted small">For a GitHub account or organization that doesn’t have the Tasks app yet.</p>
            </div>
            <div>
              <a className="button" href={`${install}?existing=1`}>Use an existing installation</a>
              <p className="muted small">
                The app is already installed (for example, for another Tasks organization). GitHub allows one installation per account, so
                sign in with GitHub and use it here too.
              </p>
            </div>
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="stack">
      <p>
        Connected to <b>{data.account}</b> <span className="muted small">({data.accountType === 'Organization' ? 'organization' : 'user'} · since <Time iso={data.since!} />)</span>
      </p>
      <ErrorNote error={data.error ?? null} />
      <RepoSummary repos={data.repos ?? []} />
      <div className="row-gap" style={{ alignItems: "center" }}>
        <a className="button" href={data.manageUrl} target="_blank" rel="noreferrer">Choose repositories on GitHub</a>
        <button className="ghost small" onClick={reload}>Refresh</button>
        <span className="grow" />
        <button
          className="ghost small danger"
          onClick={async () => {
            if (!confirm('Disconnect GitHub? Agents lose repository access. Uninstall the app on GitHub too if you no longer need it.')) return;
            await api('DELETE', `/api/orgs/${org}/github`);
            reload();
          }}
        >
          Disconnect
        </button>
      </div>
    </div>
  );
}

/** "a, b, c and 139 more", expandable into a searchable list. */
function RepoSummary({ repos }: { repos: string[] }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  if (!repos.length) return <p className="muted small">The app can’t reach any repositories yet. Add some to the installation on GitHub.</p>;
  const shown = repos.slice(0, 3);
  const matches = repos.filter((r) => r.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <div className="stack">
      <p>
        The app can reach{' '}
        {shown.map((r, i) => (
          <span key={r}>
            {i > 0 && (i === shown.length - 1 && repos.length === shown.length ? ' and ' : ', ')}
            <a href={`https://github.com/${r}`} target="_blank" rel="noreferrer">{r}</a>
          </span>
        ))}
        {repos.length > shown.length && <> and {repos.length - shown.length} more</>}.{' '}
        {repos.length > shown.length && (
          <button className="link small" onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Show all'}</button>
        )}
      </p>
      {open && (
        <div className="stack">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${repos.length} repositories…`} autoFocus />
          <ul className="rows repo-list">
            {matches.slice(0, 50).map((r) => (
              <li key={r}><a href={`https://github.com/${r}`} target="_blank" rel="noreferrer">{r}</a></li>
            ))}
          </ul>
          {matches.length > 50 && <p className="muted small">{matches.length - 50} more; narrow the search.</p>}
          {!matches.length && <p className="muted small">No repository matches.</p>}
        </div>
      )}
    </div>
  );
}

/** Project settings tab: the repository agents work in, and its production and development branches. */
export function RepositorySection({ org, projectKey, project, onSaved }: { org: string; projectKey: string; project: any; onSaved: () => void }) {
  const gh = useFetch<OrgGithub>(`/api/orgs/${org}/github`);
  const [repo, setRepo] = useState<string>(project.githubRepo ?? '');
  const [prod, setProd] = useState<string>(project.githubProd ?? 'main');
  const [dev, setDev] = useState<string>(project.githubBase ?? 'main');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => setSaved(false), [repo, prod, dev]);

  if (!gh.data) return <p className="muted">Loading…</p>;
  if (!gh.data.connected) {
    return (
      <p className="muted">
        Connect GitHub for this organization first: <Link to={`/${org}/settings?tab=github`}>Organization settings → GitHub</Link>.
      </p>
    );
  }
  const repos = [...new Set([...(gh.data.repos ?? []), ...(project.githubRepo ? [project.githubRepo] : [])])];
  const known = !repo.trim() || repos.some((r) => r.toLowerCase() === repo.trim().toLowerCase());
  return (
    <form
      className="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        try {
          await api('PATCH', `/api/projects/${org}/${projectKey}/github`, { repo: repo.trim() || null, base: dev.trim() || prod.trim(), prod });
          setSaved(true);
          onSaved();
        } catch (err) {
          setError((err as Error).message);
        }
      }}
    >
      <p className="muted small">
        The repository agents work in for this project. Agents that Tasks runs get repository tools; Claude Code routines get a clone URL
        with a token limited to this repository. Reviews, who merges, and the staging and production URLs belong in the project’s{' '}
        <b>Guidelines</b>.
      </p>
      <label>
        Repository
        <input
          list="gh-repos"
          value={repo}
          onChange={(e) => setRepo(e.target.value)}
          placeholder={repos.length ? `Search ${repos.length} repositories…` : 'owner/name'}
          autoComplete="off"
        />
        <datalist id="gh-repos">
          {repos.map((r) => <option key={r} value={r} />)}
        </datalist>
        {!known && <span className="small error-text">The GitHub App can’t reach this repository. Add it to the installation on GitHub.</span>}
        {!repo && <span className="muted small">Empty: no repository.</span>}
      </label>
      {repo && (
        <div className="branch-fields">
          <label>
            Production branch
            <input value={prod} onChange={(e) => setProd(e.target.value)} placeholder="main" />
            <span className="muted small">Released work, deployed to production.</span>
          </label>
          <label>
            Development branch
            <input value={dev} onChange={(e) => setDev(e.target.value)} placeholder="dev" />
            <span className="muted small">
              {dev.trim() && dev.trim() !== prod.trim()
                ? 'Where work starts and lands, deployed to staging. Created from the production branch if missing.'
                : 'Same as production: agents work directly on it, with no staging and no release step.'}
            </span>
          </label>
        </div>
      )}
      <ErrorNote error={error} />
      <div className="row-gap" style={{ alignItems: 'center' }}>
        <button className="primary" type="submit" disabled={!known}>Save</button>
        {saved && <span className="muted small">Saved</span>}
      </div>
    </form>
  );
}

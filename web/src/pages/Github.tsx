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
  if (!data.connected) {
    return (
      <div className="stack">
        <p className="muted small">
          Install the Tasks GitHub App on your GitHub account or organization and choose the repositories agents may work on. Then pick a
          repository in each project’s settings. Every agent run gets a token limited to that one repository, valid for an hour.
        </p>
        <div>
          <a className="button primary" href={install}>Connect GitHub</a>
        </div>
      </div>
    );
  }
  return (
    <div className="stack">
      <p>
        Connected to <b>{data.account}</b> <span className="muted small">({data.accountType === 'Organization' ? 'organization' : 'user'} · since <Time iso={data.since!} />)</span>
      </p>
      <ErrorNote error={data.error ?? null} />
      <div>
        <h3>Repositories the app can reach</h3>
        {data.repos?.length ? (
          <ul className="rows">
            {data.repos.map((r) => (
              <li key={r}><a href={`https://github.com/${r}`} target="_blank" rel="noreferrer">{r}</a></li>
            ))}
          </ul>
        ) : (
          <p className="muted small">None yet. Add repositories to the installation on GitHub.</p>
        )}
      </div>
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

/** Project settings tab: the repository agents work in, its base branch, and how work is delivered. */
export function RepositorySection({ org, projectKey, project, onSaved }: { org: string; projectKey: string; project: any; onSaved: () => void }) {
  const gh = useFetch<OrgGithub>(`/api/orgs/${org}/github`);
  const [repo, setRepo] = useState<string>(project.githubRepo ?? '');
  const [base, setBase] = useState<string>(project.githubBase ?? 'main');
  const [delivery, setDelivery] = useState<string>(project.githubDelivery ?? 'pr');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => setSaved(false), [repo, base, delivery]);

  if (!gh.data) return <p className="muted">Loading…</p>;
  if (!gh.data.connected) {
    return (
      <p className="muted">
        Connect GitHub for this organization first: <Link to={`/${org}/settings?tab=github`}>Organization settings → GitHub</Link>.
      </p>
    );
  }
  const repos = [...new Set([...(gh.data.repos ?? []), ...(project.githubRepo ? [project.githubRepo] : [])])];
  return (
    <form
      className="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        try {
          await api('PATCH', `/api/projects/${org}/${projectKey}/github`, { repo: repo || null, base, delivery });
          setSaved(true);
          onSaved();
        } catch (err) {
          setError((err as Error).message);
        }
      }}
    >
      <p className="muted small">
        The repository agents work in for this project. Agents that Tasks runs get repository tools; Claude Code routines get a clone URL
        with a token limited to this repository.
      </p>
      <label>
        Repository
        <select value={repo} onChange={(e) => setRepo(e.target.value)}>
          <option value="">None</option>
          {repos.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
      </label>
      {repo && (
        <>
          <label>
            Base branch
            <input value={base} onChange={(e) => setBase(e.target.value)} placeholder="main" />
          </label>
          <fieldset className="stack">
            <legend>Delivery</legend>
            <label className="row-gap" style={{ alignItems: "center", fontWeight: 400 }}><input type="radio" checked={delivery === 'pr'} onChange={() => setDelivery('pr')} /> Open a pull request for a human to merge</label>
            <label className="row-gap" style={{ alignItems: "center", fontWeight: 400 }}><input type="radio" checked={delivery === 'merge'} onChange={() => setDelivery('merge')} /> Agents merge into {base || 'main'} themselves</label>
          </fieldset>
        </>
      )}
      <ErrorNote error={error} />
      <div className="row-gap" style={{ alignItems: "center" }}>
        <button className="primary" type="submit">Save</button>
        {saved && <span className="muted small">Saved</span>}
      </div>
    </form>
  );
}

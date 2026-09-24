import { Toaster } from './toast';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { api, get, type Me } from './api';
import { Avatar, useFetch } from './ui';
import Login from './pages/Login';
import Home from './pages/Home';
import OrgPage from './pages/Org';
import Board from './pages/Board';
import ItemPage from './pages/Item';
import Timeline from './pages/Timeline';
import Inbox from './pages/Inbox';
import Settings from './pages/Settings';
import AgentPage from './pages/Agent';
import OrgSettings from './pages/OrgSettings';
import ProjectSettings from './pages/ProjectSettings';
import RunPage from './pages/Run';

type Session = { me: Me; refreshMe: () => Promise<void> };
const SessionContext = createContext<Session>(null!);
export const useSession = () => useContext(SessionContext);
/** Display name for an org slug the user belongs to (falls back to the slug). */
export const useOrgName = (slug?: string) => useSession().me.orgs.find((o) => o.slug === slug)?.name ?? slug ?? '';

export default function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const refreshMe = async () => {
    try {
      setMe(await get<Me>('/api/me'));
    } catch {
      setMe(null);
    }
  };
  useEffect(() => {
    refreshMe();
    const t = setInterval(refreshMe, 30_000); // keeps the unread badge fresh
    return () => clearInterval(t);
  }, []);

  if (me === undefined) return <div className="center muted">Loading…</div>;
  if (me === null) return <Login onSignedIn={refreshMe} />;

  return (
    <SessionContext.Provider value={{ me, refreshMe }}>
      <TopBar me={me} />
      <Toaster />
      <main>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/inbox" element={<Inbox />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/agents/:id" element={<AgentPage />} />
          <Route path="/runs/:id" element={<RunPage />} />
          <Route path="/i/:org/:ref" element={<ItemPage />} />
          <Route path="/:org" element={<OrgPage />} />
          <Route path="/:org/settings" element={<OrgSettings />} />
          <Route path="/:org/:key/settings" element={<ProjectSettings />} />
          <Route path="/:org/:key" element={<Board />} />
          <Route path="/:org/:key/timeline" element={<Timeline />} />
          <Route path="*" element={<div className="center muted">Not found</div>} />
        </Routes>
      </main>
    </SessionContext.Provider>
  );
}

const RESERVED = new Set(['inbox', 'settings', 'agents', 'i', 'runs']);
const LAST_ORG = 'tasks.lastOrg';
const LAST_PROJECT = 'tasks.lastProject'; // "org/KEY"
const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {}
  },
};

/** The org (and project) the current page is about, if any: /:org, /:org/:key, /i/:org/:KEY-N. */
function useCurrent(me: Me) {
  const { pathname } = useLocation();
  const parts = pathname.split('/').filter(Boolean);
  let org: string | undefined;
  let key: string | undefined;
  if (parts[0] === 'i') [org, key] = [parts[1], parts[2]?.replace(/-\d+$/, '')];
  else if (parts[0] && !RESERVED.has(parts[0])) [org, key] = [parts[0], parts[1] && parts[1] !== 'settings' ? parts[1] : undefined];
  if (org && !me.orgs.some((o) => o.slug === org)) org = key = undefined;
  return { org, key: key?.toUpperCase() };
}

/** On first load of the app's home, go back to the last project (or org) the user was in. */
function useResumeLastPlace(me: Me, projects: any[] | null) {
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (done || !projects) return;
    setDone(true);
    if (pathname !== '/' || search) return;
    const lastProject = store.get(LAST_PROJECT);
    const lastOrg = store.get(LAST_ORG);
    if (lastProject && projects.some((p) => p.ref === lastProject)) navigate(`/${lastProject}`, { replace: true });
    else if (lastOrg && me.orgs.some((o) => o.slug === lastOrg)) navigate(`/${lastOrg}`, { replace: true });
  }, [projects, done]);
}

function Dropdown({ label, children, placeholder }: { label: string | null; placeholder: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  return (
    <div className="dropdown" ref={ref}>
      <button className={`dropdown-toggle ${label ? '' : 'placeholder'}`} onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="dropdown-label">{label ?? placeholder}</span>
        <span aria-hidden className="caret">▾</span>
      </button>
      {open && <div className="dropdown-menu" onClick={() => setOpen(false)}>{children}</div>}
    </div>
  );
}

function TopBar({ me }: { me: Me }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [q, setQ] = useState('');
  const projectsFetch = useFetch<any[]>('/api/projects');
  const projects = projectsFetch.data;
  const current = useCurrent(me);
  useResumeLastPlace(me, projects);

  // Remember where the user is; refresh the project list as they move (new projects appear).
  useEffect(() => {
    if (current.org) store.set(LAST_ORG, current.org);
    if (current.org && current.key) store.set(LAST_PROJECT, `${current.org}/${current.key}`);
  }, [current.org, current.key]);
  useEffect(() => {
    projectsFetch.reload();
  }, [pathname]);

  const orgSlug = current.org ?? store.get(LAST_ORG) ?? undefined;
  const org = me.orgs.find((o) => o.slug === orgSlug);
  const orgProjects = (projects ?? []).filter((p) => p.orgSlug === org?.slug);
  const project = current.key ? orgProjects.find((p) => p.key === current.key) : undefined;

  return (
    <header className="topbar">
      <Link to="/" className="logo">
        <svg width="20" height="20" viewBox="0 0 32 32" aria-hidden>
          <rect x="3" y="5" width="8" height="22" rx="2" fill="currentColor" />
          <rect x="13" y="5" width="8" height="14" rx="2" fill="currentColor" opacity=".7" />
          <rect x="23" y="5" width="6" height="9" rx="2" fill="currentColor" opacity=".45" />
        </svg>
        Tasks
      </Link>
      <div className="pickers">
        <Dropdown label={org?.name ?? null} placeholder="Organization">
          {me.orgs.map((o) => (
            <Link key={o.id} to={`/${o.slug}`} className={o.slug === org?.slug ? 'on' : ''}>{o.name}</Link>
          ))}
          <hr />
          <Link to="/">+ New organization</Link>
        </Dropdown>
        {org && (
          <>
            <span className="sep" aria-hidden>/</span>
            <Dropdown label={project?.name ?? null} placeholder="Projects">
              {orgProjects.map((p) => (
                <Link key={p.ref} to={`/${p.ref}`} className={p.key === project?.key ? 'on' : ''}>{p.name}</Link>
              ))}
              {orgProjects.length > 0 && <hr />}
              <Link to={`/${org.slug}`}>All projects</Link>
            </Dropdown>
          </>
        )}
      </div>
      <form
        className="search"
        onSubmit={(e) => {
          e.preventDefault();
          if (q.trim().length >= 2) navigate(`/?q=${encodeURIComponent(q.trim())}`);
        }}
      >
        <input placeholder="Search items or jump to WEB-12…" value={q} onChange={(e) => setQ(e.target.value)} />
      </form>
      <NavLink to="/inbox" className="inbox-link">
        Inbox{me.unread > 0 && <span className="count">{me.unread}</span>}
      </NavLink>
      <NavLink to="/settings" className="me" title={me.email ?? ''}>
        <Avatar name={me.name} url={me.avatarUrl} size={26} />
      </NavLink>
      <button
        className="ghost small"
        onClick={async () => {
          await api('POST', '/auth/logout');
          window.location.href = '/';
        }}
      >
        Sign out
      </button>
    </header>
  );
}

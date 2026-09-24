import { createContext, useContext, useEffect, useState } from 'react';
import { Link, NavLink, Route, Routes, useNavigate } from 'react-router-dom';
import { api, get, type Me } from './api';
import { Avatar } from './ui';
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
      <main>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/inbox" element={<Inbox />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/agents/:id" element={<AgentPage />} />
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

function TopBar({ me }: { me: Me }) {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
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
      <nav className="orgs">
        {me.orgs.map((o) => (
          <NavLink key={o.id} to={`/${o.slug}`}>
            {o.name}
          </NavLink>
        ))}
      </nav>
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
          location.href = '/';
        }}
      >
        Sign out
      </button>
    </header>
  );
}

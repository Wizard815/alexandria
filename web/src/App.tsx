import { Navigate, Route, Routes, Link } from 'react-router-dom';
import { useAuth } from './lib/auth.tsx';
import { WorldProvider } from './lib/world.tsx';
import { AdminLayout } from './layouts/AdminLayout.tsx';
import { DMLayout } from './layouts/DMLayout.tsx';
import { PlayerLayout } from './layouts/PlayerLayout.tsx';
import { Setup, Login, Join, Reset } from './pages/auth/Auth.tsx';
import AdminOverview from './pages/admin/Overview.tsx';
import AdminAccounts from './pages/admin/Accounts.tsx';
import AdminWorlds from './pages/admin/Worlds.tsx';
import AdminSources from './pages/admin/Sources.tsx';
import AdminAudit from './pages/admin/Audit.tsx';
import DMTable from './pages/dm/Table.tsx';
import DMRequests from './pages/dm/Requests.tsx';
import DMCombat from './pages/dm/Combat.tsx';
import DMQuickEvents from './pages/dm/QuickEvents.tsx';
import DMParty from './pages/dm/Party.tsx';
import DMPeople from './pages/dm/People.tsx';
import DMRelations from './pages/dm/Relations.tsx';
import DMSettings from './pages/dm/Settings.tsx';
import PlayerHome from './pages/player/Home.tsx';
import PlayerLive from './pages/player/Live.tsx';
import LibraryPage from './pages/library/LibraryPage.tsx';
import PlayerBroker from './pages/broker/PlayerBroker.tsx';
import DMBroker from './pages/broker/DMBroker.tsx';
import DMApprovals from './pages/broker/DMApprovals.tsx';
import PlayerPeople from './pages/player/People.tsx';
import PlayerMe from './pages/player/Me.tsx';
import PlayerInventory from './pages/player/Inventory.tsx';
import PlayerAskDM from './pages/player/AskDM.tsx';
import Messages from './pages/shared/Messages.tsx';
import Calendar from './pages/shared/Calendar.tsx';
import Whiteboard from './pages/shared/Whiteboard.tsx';
import ConnectAI from './pages/shared/ConnectAI.tsx';
import MapBoard from './pages/shared/MapBoard.tsx';

export function App() {
  const { ready } = useAuth();
  if (!ready) return <div className="t-fantasy"><div className="page"><p className="muted">Opening the library…</p></div></div>;
  return (
    <Routes>
      <Route path="/setup" element={<Setup />} />
      <Route path="/login" element={<Login />} />
      <Route path="/join" element={<Join />} />
      <Route path="/reset" element={<Reset />} />
      <Route path="/" element={<Worlds />} />
      <Route path="/admin" element={<AdminLayout />}>
        <Route index element={<AdminOverview />} />
        <Route path="accounts" element={<AdminAccounts />} />
        <Route path="worlds" element={<AdminWorlds />} />
        <Route path="sources" element={<AdminSources />} />
        <Route path="keys" element={<div className="page"><ConnectAI /></div>} />
        <Route path="audit" element={<AdminAudit />} />
      </Route>
      <Route path="/w/:world" element={<WorldProvider><WorldOutlet /></WorldProvider>}>
        <Route path="dm" element={<DMLayout />}>
          <Route index element={<DMTable />} />
          <Route path="library" element={<LibraryPage />} />
          <Route path="broker" element={<DMBroker />} />
          <Route path="approvals" element={<DMApprovals />} />
          <Route path="requests" element={<DMRequests />} />
          <Route path="combat" element={<DMCombat />} />
          <Route path="quick" element={<DMQuickEvents />} />
          <Route path="party" element={<DMParty />} />
          <Route path="people" element={<DMPeople />} />
          <Route path="relations" element={<DMRelations />} />
          <Route path="map" element={<MapBoard />} />
          <Route path="messages" element={<Messages />} />
          <Route path="calendar" element={<Calendar />} />
          <Route path="whiteboard" element={<Whiteboard />} />
          <Route path="settings" element={<DMSettings />} />
          <Route path="connect" element={<ConnectAI />} />
        </Route>
        <Route element={<PlayerLayout />}>
          <Route index element={<PlayerHome />} />
          <Route path="live" element={<PlayerLive />} />
          <Route path="library" element={<LibraryPage />} />
          <Route path="lore" element={<Navigate to="../library" replace />} />
          <Route path="broker" element={<PlayerBroker />} />
          <Route path="people" element={<PlayerPeople />} />
          <Route path="me" element={<PlayerMe />} />
          <Route path="inventory" element={<PlayerInventory />} />
          <Route path="map" element={<MapBoard />} />
          <Route path="messages" element={<Messages />} />
          <Route path="calendar" element={<Calendar />} />
          <Route path="ask" element={<PlayerAskDM />} />
          <Route path="whiteboard" element={<Whiteboard />} />
          <Route path="connect" element={<ConnectAI />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

import { Outlet } from 'react-router-dom';
function WorldOutlet() {
  return <Outlet />;
}

/** Home: pick a world, or go to setup / sign in. */
function Worlds() {
  const { me, needsSetup, signOut } = useAuth();
  if (needsSetup) return <Navigate to="/setup" replace />;
  if (!me) return <Navigate to="/login" replace />;
  if (me.worlds.length === 1 && !me.account.is_admin) {
    const w = me.worlds[0];
    return <Navigate to={w.role === 'dm' ? `/w/${w.slug}/dm` : `/w/${w.slug}`} replace />;
  }
  return (
    <div className="t-fantasy">
      <div className="page" style={{ maxWidth: 720 }}>
        <div className="row between"><h1>Alexandria</h1><button type="button" className="btn small" onClick={() => void signOut()}>Sign out</button></div>
        <p className="muted">Welcome, {me.account.display_name}. Pick a world.</p>
        <div className="card flush">
          <div className="list">
            {me.worlds.map((w) => (
              <Link key={w.id} className="list-item" to={w.role === 'dm' ? `/w/${w.slug}/dm` : `/w/${w.slug}`}>
                <span className="grow"><strong>{w.name}</strong>{w.character_name && <span className="muted"> · {w.character_name}</span>}</span>
                <span className={`chip ${w.role === 'dm' ? 'red' : 'teal'}`}>{w.role === 'dm' ? 'Dungeon Master' : w.role === 'player' ? 'Player' : 'Guest'}</span>
              </Link>
            ))}
            {!me.worlds.length && <div className="empty">You are not in a world yet. Ask your DM for an invite code{me.account.is_admin ? ', or make a world in Library admin' : ''}.</div>}
          </div>
        </div>
        <div className="row">
          <Link className="btn" to="/join">Join with an invite code</Link>
          {me.account.is_admin && <Link className="btn primary" to="/admin">Library admin</Link>}
        </div>
      </div>
    </div>
  );
}

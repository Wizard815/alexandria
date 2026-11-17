// The library inside the gateway admin: pick a world, browse its pages and files, upload files.
// It reuses LibraryPage. The librarian answers with the DM view only when this admin is the world's DM;
// otherwise it is the party copy (being an admin does not open a world's secrets) and nothing can be changed.
import { useEffect, useMemo } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { WorldClient, type AlexandriaClient, type LiveEvent } from '@alx/client';
import { useAuth } from '../../lib/auth.tsx';
import { StaticWorldProvider, useLoad, type WorldInfo, type WorldState } from '../../lib/world.tsx';
import { ErrorBox, Loading, PageHead } from '../../ui/index.tsx';
import LibraryPage from '../../pages/library/LibraryPage.tsx';
import { Callout, Pill } from '../../pages/admin/kit.tsx';

/** A world client that talks to /api/admin/library/worlds/:id instead of /api/worlds/:id, and has no live stream. */
class AdminWorldClient extends WorldClient {
  constructor(c: AlexandriaClient, id: string) { super(c, id); }
  path(p: string) { return `/api/admin/library/worlds/${encodeURIComponent(this.id)}${p}`; }
  subscribe(_on: (e: LiveEvent) => void) { return () => {}; }
}

interface AdminWorld { id: string; name: string; slug: string; pages: number; role: string | null; view: 'dm' | 'party' }

export default function AdminLibrary() {
  const { client, me } = useAuth();
  const { world } = useParams();
  const nav = useNavigate();
  const worlds = useLoad<AdminWorld[]>(() => client.request('GET', '/api/admin/library/worlds'), [client]);
  const list = worlds.data ?? [];
  const cur = list.find((w) => w.id === world || w.slug === world) ?? null;

  // With no world in the address, open the first one this admin is the DM of, else the first.
  if (!world && list.length) return <Navigate to={`/admin/library/${(list.find((w) => w.view === 'dm') ?? list[0]).id}`} replace />;

  return (
    <div className="page wide adm-lib">
      <PageHead title="Library" lead="Browse a world's pages and files, and add files to its library.">
        {list.length > 0 && (
          <label className="adm-lib-pick"><span className="sr-only">World</span>
            <select value={cur?.id ?? ''} onChange={(e) => nav(`/admin/library/${e.target.value}`)} aria-label="World">
              {!cur && <option value="">Pick a world…</option>}
              {list.map((w) => <option key={w.id} value={w.id}>{w.name}{w.view === 'dm' ? ' (you are the DM)' : ''}</option>)}
            </select>
          </label>
        )}
      </PageHead>
      <ErrorBox error={worlds.error} />
      {worlds.loading && !worlds.data && <Loading what="worlds" />}
      {worlds.data && !list.length && <div className="empty">There are no worlds yet. Make one under Worlds.</div>}
      {cur && (
        <>
          {cur.view === 'dm'
            ? <div className="adm-lib-who"><Pill tone="teal">DM view</Pill> <span className="small muted">You are the DM of {cur.name}, so you see every level and can upload files.</span></div>
            : <Callout tone="warn">You are not the DM of {cur.name}. Being an admin does not open a world's secrets, so this shows only the party copy: pages and files shared with the players. Uploads are off.</Callout>}
          <AdminWorldView key={cur.id} w={cur} client={client} accountId={me?.account.id ?? ''} />
        </>
      )}
    </div>
  );
}

function AdminWorldView({ w, client, accountId }: { w: AdminWorld; client: AlexandriaClient; accountId: string }) {
  const wc = useMemo(() => new AdminWorldClient(client, w.id), [client, w.id]);
  const value = useMemo<WorldState>(() => {
    const info: WorldInfo = { id: w.id, slug: w.slug, name: w.name, role: w.view === 'dm' ? 'dm' : 'player', settings: {} as any };
    return { w: wc, info, members: [], me: accountId, isDM: w.view === 'dm', readOnly: true, nameOf: () => '', on: () => () => {}, reloadInfo: async () => {}, connected: false };
  }, [wc, w, accountId]);
  useEffect(() => { document.title = `Library · ${w.name}`; }, [w.name]);
  return <StaticWorldProvider value={value}><LibraryPage embedded /></StaticWorldProvider>;
}

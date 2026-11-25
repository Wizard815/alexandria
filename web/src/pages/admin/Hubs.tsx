// Admin pages that are one job split over several screens: each is now one page with tabs (?tab=). The old routes
// redirect here (lib/adminnames.ts). A tab keeps its own screen; its big heading is hidden because the page has one.
import type { ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PageHead, Tabs } from '../../ui/index.tsx';
import { ADMIN_NAMES } from '../../lib/adminnames.ts';
import ConnectionsPage from '../../features/connections/ConnectionsPage.tsx';
import AdminSources from './Sources.tsx';
import SourceKeysAdmin from '../../features/gateway/SourceKeysAdmin.tsx';
import SourceFilesPage from '../../features/gwstatus/SourceFilesPage.tsx';
import Access from '../../features/gateway/Access.tsx';
import Permissions from '../../features/gateway/Permissions.tsx';
import Security from '../../features/adminauth/Security.tsx';
import AdminSearch from '../../features/gateway/Search.tsx';
import MirrorPage from '../../features/gwstatus/MirrorPage.tsx';

type TabDef = [id: string, label: string, body: ReactNode];

function Hub({ route, lead, tabs }: { route: string; lead: string; tabs: TabDef[] }) {
  const [params, setParams] = useSearchParams();
  const asked = params.get('tab');
  const tab = tabs.find(([id]) => id === asked) ?? tabs[0];
  const pick = (id: string) => { const next = new URLSearchParams(params); next.set('tab', id); setParams(next, { replace: true }); };
  return (
    <div className="page hub" data-hub={route}>
      <PageHead title={ADMIN_NAMES[route]?.label ?? route} lead={lead} />
      <Tabs label={`${ADMIN_NAMES[route]?.label ?? route} sections`} value={tab[0]} onChange={pick} items={tabs.map(([id, label]) => [id, label])} />
      <div className="in-tab" role="tabpanel" aria-label={tab[1]} key={tab[0]}>{tab[2]}</div>
    </div>
  );
}

export const SourcesHub = () => (
  <Hub route="sources" lead="Where each world’s pages come from." tabs={[
    ['connections', 'Connections', <ConnectionsPage />],
    ['worlds', 'World sources', <AdminSources />],
    ['keys', 'Source keys', <SourceKeysAdmin />],
    ['files', 'Source files', <SourceFilesPage />],
  ]} />
);

export const AccessHub = () => (
  <Hub route="access" lead="Who and what can reach the library." tabs={[
    ['mcp', 'MCP access', <Access />],
    ['permissions', 'Permissions', <Permissions />],
    ['security', 'Admin sign-in', <Security />],
  ]} />
);

export const SearchHub = () => (
  <Hub route="search" lead="Search across every world, and the mirror folders it reads from." tabs={[
    ['search', 'Search', <AdminSearch />],
    ['mirror', 'World mirror', <MirrorPage />],
  ]} />
);

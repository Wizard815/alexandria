// Every GM page a workspace pane can show. The core pages mirror the GM routes in App.tsx; the rest come from the feature
// registry, so a new feature page is available in a pane as soon as it is in the menu (e2e/workspace.mjs opens every menu page).
import { Navigate } from 'react-router-dom';
import type { ReactNode } from 'react';
import * as F from '../registry.ts';
import { PANELS, panelById, type PanelDef } from '../screens/panels.tsx';
import { DM_NAMES } from '../../lib/dmnames.ts';
import { menuEntries } from '../../layouts/DMMenu.tsx';
import { routeOfPage } from '../../lib/workspace.ts';
import DMTable from '../../pages/dm/Table.tsx';
import DMInbox from '../../pages/dm/Inbox.tsx';
import DMCombat from '../../pages/dm/Combat.tsx';
import DMQuickEvents from '../../pages/dm/QuickEvents.tsx';
import DMParty from '../../pages/dm/Party.tsx';
import DMPeople from '../../pages/dm/People.tsx';
import DMRelations from '../../pages/dm/Relations.tsx';
import DMSharing from '../../pages/dm/Sharing.tsx';
import DMSettings from '../../pages/dm/Settings.tsx';
import LibraryPage from '../../pages/library/LibraryPage.tsx';
import DMBroker from '../../pages/broker/DMBroker.tsx';
import Messages from '../../pages/shared/Messages.tsx';
import Calendar from '../../pages/shared/Calendar.tsx';
import Whiteboard from '../../pages/shared/Whiteboard.tsx';
import ConnectAI from '../../pages/shared/ConnectAI.tsx';
import MapBoard from '../../pages/shared/MapBoard.tsx';

/** Panels that are not a menu page: they have no route, so a pane renders them directly. */
export const PANEL_ONLY = ['assistant', 'transcript', 'fog'];

export interface PaneRoute { path: string; element: ReactNode }

export function paneRoutes(): PaneRoute[] {
  const core: PaneRoute[] = [
    { path: 'library', element: <LibraryPage /> },
    { path: 'broker', element: <DMBroker /> },
    { path: 'inbox', element: <DMInbox /> },
    { path: 'approvals', element: <Navigate to="../inbox?tab=approvals" replace /> },
    { path: 'requests', element: <Navigate to="../inbox?tab=requests" replace /> },
    { path: 'combat', element: <DMCombat /> },
    { path: 'quick', element: <DMQuickEvents /> },
    { path: 'party', element: <DMParty /> },
    { path: 'people', element: <DMPeople /> },
    { path: 'relations', element: <DMRelations /> },
    { path: 'map', element: <MapBoard /> },
    { path: 'messages', element: <Messages /> },
    { path: 'calendar', element: <Calendar /> },
    { path: 'whiteboard', element: <Whiteboard /> },
    { path: 'settings', element: <DMSettings /> },
    { path: 'sharing', element: <DMSharing /> },
    { path: 'connect', element: <ConnectAI /> },
  ];
  return [...core, ...F.dmRoutes.filter((r) => r.path !== 'ws')];
}
export const tablePage = <DMTable />;

export interface PageMeta { id: string; title: string; icon: string; desc: string; /** The menu group, for the picker. */ group: string }

/** Name, icon and description for a page id (the menu's words). */
export function pageMeta(id: string): PageMeta | null {
  const panel = PANEL_ONLY.includes(id) ? panelById(id) : undefined;
  if (panel) return { id, title: panel.title, icon: panel.icon, desc: panel.desc, group: 'panels' };
  const route = routeOfPage(id);
  const e = menuEntries().find((m) => m.to === route);
  if (e) return { id, title: e.label, icon: e.icon, desc: e.desc, group: e.group };
  const n = DM_NAMES[route];
  return n ? { id, title: n.label, icon: n.icon, desc: n.desc, group: n.group } : null;
}

/** Everything the page picker offers, menu order, then the panel-only ones. */
export function pageChoices(): PageMeta[] {
  const out: PageMeta[] = menuEntries().map((e) => ({ id: e.to || 'table', title: e.label, icon: e.icon, desc: e.desc, group: e.group }));
  for (const id of PANEL_ONLY) { const p = pageMeta(id); if (p) out.push(p); }
  return out;
}

export const panelOnly = (id: string): PanelDef | undefined => (PANEL_ONLY.includes(id) ? PANELS.find((p) => p.id === id) : undefined);

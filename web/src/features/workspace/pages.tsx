// Every GM page a workspace pane can show. The core pages mirror the GM routes in App.tsx; the rest come from the feature
// registry, so a new feature page is available in a pane as soon as it is in the menu (e2e/workspace.mjs opens every menu page).
import { Navigate } from 'react-router-dom';
import type { ReactNode } from 'react';
import * as F from '../registry.ts';
import { PANELS, panelById, type PanelDef } from '../screens/panels.tsx';
import { GM_NAMES } from '../../lib/gmnames.ts';
import { menuEntries } from '../../layouts/GMMenu.tsx';
import { routeOfPage } from '../../lib/workspace.ts';
import GMTable from '../../pages/gm/Table.tsx';
import GMInbox from '../../pages/gm/Inbox.tsx';
import GMCombat from '../../pages/gm/Combat.tsx';
import GMQuickEvents from '../../pages/gm/QuickEvents.tsx';
import GMParty from '../../pages/gm/Party.tsx';
import GMPeople from '../../pages/gm/People.tsx';
import GMRelations from '../../pages/gm/Relations.tsx';
import GMSharing from '../../pages/gm/Sharing.tsx';
import GMSettings from '../../pages/gm/Settings.tsx';
import LibraryPage from '../../pages/library/LibraryPage.tsx';
import GMBroker from '../../pages/broker/GMBroker.tsx';
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
    { path: 'broker', element: <GMBroker /> },
    { path: 'inbox', element: <GMInbox /> },
    { path: 'approvals', element: <Navigate to="../inbox?tab=approvals" replace /> },
    { path: 'requests', element: <Navigate to="../inbox?tab=requests" replace /> },
    { path: 'combat', element: <GMCombat /> },
    { path: 'quick', element: <GMQuickEvents /> },
    { path: 'party', element: <GMParty /> },
    { path: 'people', element: <GMPeople /> },
    { path: 'relations', element: <GMRelations /> },
    { path: 'map', element: <MapBoard /> },
    { path: 'messages', element: <Messages /> },
    { path: 'calendar', element: <Calendar /> },
    { path: 'whiteboard', element: <Whiteboard /> },
    { path: 'settings', element: <GMSettings /> },
    { path: 'sharing', element: <GMSharing /> },
    { path: 'connect', element: <ConnectAI /> },
  ];
  return [...core, ...F.gmRoutes.filter((r) => r.path !== 'ws')];
}
export const tablePage = <GMTable />;

export interface PageMeta { id: string; title: string; icon: string; desc: string; /** The menu group, for the picker. */ group: string }

/** Name, icon and description for a page id (the menu's words). */
export function pageMeta(id: string): PageMeta | null {
  const panel = PANEL_ONLY.includes(id) ? panelById(id) : undefined;
  if (panel) return { id, title: panel.title, icon: panel.icon, desc: panel.desc, group: 'panels' };
  const route = routeOfPage(id);
  const e = menuEntries().find((m) => m.to === route);
  if (e) return { id, title: e.label, icon: e.icon, desc: e.desc, group: e.group };
  const n = GM_NAMES[route];
  return n ? { id, title: n.label, icon: n.icon, desc: n.desc, group: n.group } : null;
}

/** Everything the page picker offers, menu order, then the panel-only ones. */
export function pageChoices(): PageMeta[] {
  const out: PageMeta[] = menuEntries().map((e) => ({ id: e.to || 'table', title: e.label, icon: e.icon, desc: e.desc, group: e.group }));
  for (const id of PANEL_ONLY) { const p = pageMeta(id); if (p) out.push(p); }
  return out;
}

export const panelOnly = (id: string): PanelDef | undefined => (PANEL_ONLY.includes(id) ? PANELS.find((p) => p.id === id) : undefined);

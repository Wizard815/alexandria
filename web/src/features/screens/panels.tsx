// The DM panels that can stand alone: in their own window (/w/:world/panel/:name) or stacked on the side screen. Each one is
// the same component the DM page uses, so nothing is duplicated and both stay in step with live updates.
import type { ReactNode } from 'react';
import DMCombat from '../../pages/dm/Combat.tsx';
import DMApprovals from '../../pages/broker/DMApprovals.tsx';
import DMQuickEvents from '../../pages/dm/QuickEvents.tsx';
import DMParty from '../../pages/dm/Party.tsx';
import SoundBoard from '../sound/SoundBoard.tsx';
import ClockPage from '../clock/ClockPage.tsx';
import ChatPage from '../sessionchat/Page.tsx';
import { AssistantBody } from '../agent/AssistantWindow.tsx';
import FogPanel from './FogPanel.tsx';
import ScenePanel from '../scenes/ScenePanel.tsx';
import { TranscriptPanel } from '../audio/TranscriptView.tsx';
import { DM_NAMES } from '../../lib/dmnames.ts';
import '../agent/agent.css';

export interface PanelDef {
  id: string;
  title: string;
  icon: string;
  /** One line, for the picker's tooltip. */
  desc: string;
  /** A page (padded, scrolls) rather than something that fills its box itself. */
  page: boolean;
  render: () => ReactNode;
}

// Names, icons and descriptions are the menu's (lib/dmnames.ts); only the panels that are not a menu page name themselves.
const named = (id: string, route: string, page: boolean, render: () => ReactNode, title = DM_NAMES[route].label): PanelDef =>
  ({ id, title, icon: DM_NAMES[route].icon, desc: DM_NAMES[route].desc, page, render });

export const PANELS: PanelDef[] = [
  { id: 'assistant', title: 'Assistant', icon: 'fa-robot', desc: 'Ask the AI about the table; it can act on your say-so.', page: false, render: () => <div className="sc-fill"><AssistantBody /></div> },
  { id: 'transcript', title: 'Transcript', icon: 'fa-closed-captioning', desc: 'What the table is saying, live.', page: false, render: () => <TranscriptPanel /> },
  named('combat', 'combat', true, () => <DMCombat />),
  named('approvals', 'inbox', true, () => <DMApprovals />, 'Approvals'),
  named('sound', 'sound', true, () => <SoundBoard />),
  named('scenes', 'scenes', true, () => <ScenePanel />),
  { id: 'fog', title: 'Map & fog', icon: 'fa-cloud', desc: 'Reveal or hide parts of the map for the players.', page: true, render: () => <FogPanel /> },
  named('chat', 'chat', true, () => <ChatPage />),
  named('clock', 'clock', true, () => <ClockPage />),
  named('quick', 'quick', true, () => <DMQuickEvents />),
  named('party', 'party', true, () => <DMParty />),
];
export const panelById = (id: string) => PANELS.find((p) => p.id === id);

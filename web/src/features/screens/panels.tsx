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
import '../agent/agent.css';

export interface PanelDef {
  id: string;
  title: string;
  icon: string;
  /** A page (padded, scrolls) rather than something that fills its box itself. */
  page: boolean;
  render: () => ReactNode;
}

export const PANELS: PanelDef[] = [
  { id: 'assistant', title: 'Assistant', icon: 'fa-comments', page: false, render: () => <div className="sc-fill"><AssistantBody /></div> },
  { id: 'transcript', title: 'Transcript', icon: 'fa-closed-captioning', page: false, render: () => <TranscriptPanel /> },
  { id: 'combat', title: 'Combat', icon: 'fa-khanda', page: true, render: () => <DMCombat /> },
  { id: 'approvals', title: 'Approvals', icon: 'fa-check-double', page: true, render: () => <DMApprovals /> },
  { id: 'sound', title: 'Sound board', icon: 'fa-music', page: true, render: () => <SoundBoard /> },
  { id: 'scenes', title: 'Scenes', icon: 'fa-clapperboard', page: true, render: () => <ScenePanel /> },
  { id: 'fog', title: 'Map & fog', icon: 'fa-cloud', page: true, render: () => <FogPanel /> },
  { id: 'chat', title: 'Session chat', icon: 'fa-comment-dots', page: true, render: () => <ChatPage /> },
  { id: 'clock', title: 'World clock', icon: 'fa-moon', page: true, render: () => <ClockPage /> },
  { id: 'quick', title: 'Quick events', icon: 'fa-bolt', page: true, render: () => <DMQuickEvents /> },
  { id: 'party', title: 'Party & inventory', icon: 'fa-users', page: true, render: () => <DMParty /> },
];
export const panelById = (id: string) => PANELS.find((p) => p.id === id);

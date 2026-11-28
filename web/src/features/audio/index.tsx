import type { WebFeature } from '../registry.ts';
import AudioSetup from './AudioSetup.tsx';
import PlayerAudio from './PlayerAudio.tsx';
import { MyRecordings, RecordingsGM } from './Recordings.tsx';
import TranscriptOverlay from './TranscriptIsland.tsx';
import './audio.css';

const feature: WebFeature = {
  id: 'audio',
  gmRoutes: [{ path: 'audio', element: <AudioSetup /> }, { path: 'recordings', element: <RecordingsGM /> }],
  playerRoutes: [{ path: 'audio', element: <PlayerAudio /> }, { path: 'recordings', element: <MyRecordings /> }],
  gmNav: [{ to: 'audio' }, { to: 'recordings' }],
  playerNav: [{ to: 'audio', label: 'My microphone', icon: 'fa-microphone' }, { to: 'recordings', label: 'My recordings', icon: 'fa-record-vinyl' }],
  overlay: TranscriptOverlay,
};
export default feature;

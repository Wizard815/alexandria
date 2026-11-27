import type { WebFeature } from '../registry.ts';
import SoundBoard from './SoundBoard.tsx';
import SoundOverlay from './Overlay.tsx';
import SoundCard from './PlayerCard.tsx';

const feature: WebFeature = {
  id: 'sound',
  gmRoutes: [{ path: 'sound', element: <SoundBoard /> }],
  gmNav: [{ to: 'sound' }],
  playerHome: [SoundCard],
  overlay: SoundOverlay,
};
export default feature;

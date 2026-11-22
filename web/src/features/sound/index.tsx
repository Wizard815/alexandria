import type { WebFeature } from '../registry.ts';
import SoundBoard from './SoundBoard.tsx';
import SoundOverlay from './Overlay.tsx';
import SoundCard from './PlayerCard.tsx';

const feature: WebFeature = {
  id: 'sound',
  dmRoutes: [{ path: 'sound', element: <SoundBoard /> }],
  dmNav: [{ to: 'sound' }],
  playerHome: [SoundCard],
  overlay: SoundOverlay,
};
export default feature;

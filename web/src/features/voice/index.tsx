import type { WebFeature } from '../registry.ts';
import VoiceSettings from './VoiceSettings.tsx';
import SpeakOverlay from './SpeakOverlay.tsx';

const feature: WebFeature = {
  id: 'voice',
  settings: { title: 'Voice', component: VoiceSettings },
  overlay: SpeakOverlay,
};
export default feature;

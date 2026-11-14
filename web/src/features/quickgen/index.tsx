import type { WebFeature } from '../registry.ts';
import QuickGenOverlay from './QuickGen.tsx';

const feature: WebFeature = {
  id: 'quickgen',
  overlay: QuickGenOverlay,
};
export default feature;

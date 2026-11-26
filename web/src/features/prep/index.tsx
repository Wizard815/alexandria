import type { WebFeature } from '../registry.ts';
import { PrepCard } from './PrepCard.tsx';

const feature: WebFeature = {
  id: 'prep',
  dmHome: [PrepCard],
};
export default feature;

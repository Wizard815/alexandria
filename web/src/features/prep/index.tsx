import type { WebFeature } from '../registry.ts';
import { PrepCard } from './PrepCard.tsx';

const feature: WebFeature = {
  id: 'prep',
  gmHome: [PrepCard],
};
export default feature;

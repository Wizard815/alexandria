import type { WebFeature } from '../registry.ts';
import PhonePage from './PhonePage.tsx';
import PhoneBanner from './Banner.tsx';

const feature: WebFeature = {
  id: 'dmphone',
  dmRoutes: [{ path: 'phone', element: <PhonePage /> }],
  dmNav: [{ to: 'phone' }],
  dmHome: [PhoneBanner],
};
export default feature;

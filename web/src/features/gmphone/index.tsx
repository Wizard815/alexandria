import type { WebFeature } from '../registry.ts';
import PhonePage from './PhonePage.tsx';
import PhoneBanner from './Banner.tsx';

const feature: WebFeature = {
  id: 'gmphone',
  gmRoutes: [{ path: 'phone', element: <PhonePage /> }],
  gmNav: [{ to: 'phone' }],
  gmHome: [PhoneBanner],
};
export default feature;

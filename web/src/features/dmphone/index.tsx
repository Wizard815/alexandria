import type { WebFeature } from '../registry.ts';
import PhonePage from './PhonePage.tsx';
import PhoneBanner from './Banner.tsx';

const feature: WebFeature = {
  id: 'dmphone',
  dmRoutes: [{ path: 'phone', element: <PhonePage /> }],
  dmNav: [{ group: 'At the table', to: 'phone', label: '☎ Phone assistant' }],
  dmHome: [PhoneBanner],
};
export default feature;

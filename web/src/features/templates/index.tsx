import type { WebFeature } from '../registry.ts';
import TemplatesPage from './TemplatesPage.tsx';

// Templates & guides (GM only): guides the assistant follows, and templates for generators, macros, panels, shops and pages.
const feature: WebFeature = {
  id: 'templates',
  gmRoutes: [{ path: 'templates', element: <TemplatesPage /> }],
  gmNav: [{ to: 'templates' }],
};
export default feature;

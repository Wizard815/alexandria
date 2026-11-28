import type { WebFeature } from '../registry.ts';
import MacrosPage from './MacrosPage.tsx';
import MacroBar from './MacroBar.tsx';

const feature: WebFeature = {
  id: 'actions',
  gmRoutes: [{ path: 'macros', element: <MacrosPage /> }],
  gmNav: [{ to: 'macros' }],
  overlay: MacroBar,
};
export default feature;

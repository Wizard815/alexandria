import type { WebFeature } from '../registry.ts';
import MacrosPage from './MacrosPage.tsx';
import MacroBar from './MacroBar.tsx';

const feature: WebFeature = {
  id: 'actions',
  dmRoutes: [{ path: 'macros', element: <MacrosPage /> }],
  dmNav: [{ group: 'Tools', to: 'macros', label: '⚡ Macros' }],
  overlay: MacroBar,
};
export default feature;

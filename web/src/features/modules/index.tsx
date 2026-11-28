import type { WebFeature } from '../registry.ts';
import RulesPage from './Rules.tsx';
import ModuleSettings from './Settings.tsx';

const feature: WebFeature = {
  id: 'modules',
  gmRoutes: [{ path: 'rules', element: <RulesPage /> }],
  playerRoutes: [{ path: 'rules', element: <RulesPage /> }],
  gmNav: [{ to: 'rules' }],
  playerNav: [{ to: 'rules', label: 'Rules', icon: 'fa-book' }],
  settings: { title: 'Game module', component: ModuleSettings },
};
export default feature;

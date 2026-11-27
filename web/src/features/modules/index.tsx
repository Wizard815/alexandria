import type { WebFeature } from '../registry.ts';
import RulesPage from './Rules.tsx';
import ModuleSettings from './Settings.tsx';
import ContentLibrary from './ContentLibrary.tsx';

const feature: WebFeature = {
  id: 'modules',
  dmRoutes: [{ path: 'rules', element: <RulesPage /> }],
  playerRoutes: [{ path: 'rules', element: <RulesPage /> }],
  dmNav: [{ to: 'rules' }],
  playerNav: [{ to: 'rules', label: 'Rules', icon: 'fa-book' }],
  settings: { title: 'Game module', component: ModuleSettings },
  adminRoutes: [{ path: 'content', element: <ContentLibrary /> }],
};
export default feature;

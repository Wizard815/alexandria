import type { WebFeature } from '../registry.ts';
import AgentPanel from './Panel.tsx';
import AskPage from './AskPage.tsx';

const feature: WebFeature = {
  id: 'agent',
  playerRoutes: [{ path: 'assistant', element: <AskPage /> }],
  playerNav: [{ to: 'assistant', label: 'Ask', icon: 'fa-comments' }],
  overlay: AgentPanel,
};
export default feature;

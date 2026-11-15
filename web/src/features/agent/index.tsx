import type { WebFeature } from '../registry.ts';
import AgentPanel from './Panel.tsx';
import AskPage from './AskPage.tsx';

const feature: WebFeature = {
  id: 'agent',
  playerRoutes: [{ path: 'assistant', element: <AskPage /> }],
  playerNav: [{ to: 'assistant', label: 'Assistant', icon: 'fa-wand-magic-sparkles' }],
  overlay: AgentPanel,
};
export default feature;

// House rules (mods): World settings → House rules, the DM's grants page, the
// player's page and home card, and Reroll under chat rolls. See docs/MODS.md.
import type { WebFeature } from '../registry.ts';
import { DMHouseRules, MyHouseRulesCard, PlayerHouseRules } from './Pages.tsx';
import HouseRulesSettings from './Settings.tsx';
import { RerollAction } from './shared.tsx';
import { PromptOverlay, ViewsFor } from './System.tsx';

const SheetViews = () => <ViewsFor place="sheet" />;

const feature: WebFeature = {
  id: 'mods',
  dmRoutes: [{ path: 'house-rules', element: <DMHouseRules /> }],
  playerRoutes: [{ path: 'house-rules', element: <PlayerHouseRules /> }],
  dmNav: [{ to: 'house-rules' }],
  playerNav: [{ to: 'house-rules', label: 'House rules', icon: 'fa-dice' }],
  settings: { title: 'House rules', component: HouseRulesSettings },
  playerHome: [MyHouseRulesCard, SheetViews],
  overlay: PromptOverlay,
  chatActions: [RerollAction],
};
export default feature;

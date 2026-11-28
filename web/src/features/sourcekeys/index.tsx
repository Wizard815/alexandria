import type { WebFeature } from '../registry.ts';
import KeysAdmin from './KeysAdmin.tsx';
import MyKeys from './MyKeys.tsx';

// Players: "My keys" (and their questions to the broker). The GM: a "Source keys" tab in World settings.
// ShareButton.tsx is used by the library page.
const feature: WebFeature = {
  id: 'sourcekeys',
  playerRoutes: [{ path: 'my-keys', element: <MyKeys /> }],
  playerNav: [{ to: 'my-keys', label: 'My keys', icon: 'fa-key' }],
  settings: { title: 'Source keys', component: KeysAdmin },
};
export default feature;

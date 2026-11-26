// Open5e and the 5e SRD API as a server mod (mods/open5e.alxmod.json): the admin's Content library page. While the
// admin has it off under Admin → Mods, the page and its menu entry hide, and the Game module settings drop the
// Open5e and 5e SRD API import tabs. The page itself lives with the modules feature.
import type { WebFeature } from '../registry.ts';
import ContentLibrary from '../modules/ContentLibrary.tsx';

const feature: WebFeature = {
  id: 'open5e',
  serverMod: 'open5e',
  adminRoutes: [{ path: 'content', element: <ContentLibrary /> }],
  adminNav: [{ to: 'content', label: 'Content library', group: 'sources', icon: 'fa-book-skull', desc: 'Rules books pulled once from Open5e and the 5e SRD API, for every world.' }],
};
export default feature;

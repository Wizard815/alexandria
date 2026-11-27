import type { WebFeature } from '../registry.ts';
import OwlbearPage from './OwlbearPage.tsx';

// GM → Setup → Owlbear Rodeo: link an Owlbear Rodeo room to this world (see librarian/src/features/owlbear).
const feature: WebFeature = {
  id: 'owlbear',
  dmRoutes: [{ path: 'owlbear', element: <OwlbearPage /> }],
  dmNav: [{ to: 'owlbear' }],
};
export default feature;

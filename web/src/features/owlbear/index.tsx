import type { WebFeature } from '../registry.ts';
import OwlbearPage from './OwlbearPage.tsx';

// GM → Setup → Owlbear Rodeo: link an Owlbear Rodeo room to this world (see librarian/src/features/owlbear).
const feature: WebFeature = {
  id: 'owlbear',
  gmRoutes: [{ path: 'owlbear', element: <OwlbearPage /> }],
  gmNav: [{ to: 'owlbear' }],
};
export default feature;

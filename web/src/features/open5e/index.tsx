// Admin → Content library: rules books the server pulls once from Open5e and the 5e SRD API and offers to every
// world. Not a mod: each world turns Open5e on as a house rule (World → House rules) to pull books itself, and turns a
// library book on in World settings → Game module. The page lives with the modules feature.
import type { WebFeature } from '../registry.ts';
import ContentLibrary from '../modules/ContentLibrary.tsx';

const feature: WebFeature = {
  id: 'open5e',
  adminRoutes: [{ path: 'content', element: <ContentLibrary /> }],
};
export default feature;

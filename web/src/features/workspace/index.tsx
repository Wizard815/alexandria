import type { WebFeature } from '../registry.ts';
import WorkspacePage from './WorkspacePage.tsx';

// The DM's multi-pane workspace at /w/:world/dm/ws. It is opened from its own entry at the top of the DM menu, so it has no
// dmNav item of its own.
const feature: WebFeature = {
  id: 'workspace',
  dmRoutes: [{ path: 'ws', element: <WorkspacePage /> }],
};
export default feature;

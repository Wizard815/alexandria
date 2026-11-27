import type { WebFeature } from '../registry.ts';
import WorkspacePage from './WorkspacePage.tsx';

// The GM's multi-pane workspace at /w/:world/gm/ws. It is opened from its own entry at the top of the GM menu, so it has no
// gmNav item of its own.
const feature: WebFeature = {
  id: 'workspace',
  gmRoutes: [{ path: 'ws', element: <WorkspacePage /> }],
};
export default feature;

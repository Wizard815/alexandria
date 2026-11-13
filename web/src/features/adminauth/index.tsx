import type { WebFeature } from '../registry.ts';
import AdminLogin from './Login.tsx';
import Security from './Security.tsx';

const feature: WebFeature = {
  id: 'adminauth',
  // 'login' is rendered by AdminLayout itself (outside the signed-in shell); the route only has to exist.
  adminRoutes: [{ path: 'login', element: <AdminLogin /> }, { path: 'security', element: <Security /> }],
  adminNav: [{ to: 'security', label: 'Security' }],
};
export default feature;

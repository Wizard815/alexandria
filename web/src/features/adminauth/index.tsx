import type { WebFeature } from '../registry.ts';
import AdminLogin from './Login.tsx';

const feature: WebFeature = {
  id: 'adminauth',
  // 'login' is rendered by AdminLayout itself (outside the signed-in shell); the route only has to exist.
  adminRoutes: [{ path: 'login', element: <AdminLogin /> }],
};
export default feature;

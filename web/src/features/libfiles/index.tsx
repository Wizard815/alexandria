import type { WebFeature } from '../registry.ts';
import AdminLibrary from './AdminLibrary.tsx';

// Files in the library (see Files.tsx, used by the Library page) and the Library page of the gateway admin.
// The admin menu entry is in lib/adminnames.ts (People & worlds group).
const feature: WebFeature = {
  id: 'libfiles',
  adminRoutes: [
    { path: 'library', element: <AdminLibrary /> },
    { path: 'library/:world', element: <AdminLibrary /> },
  ],
};
export default feature;

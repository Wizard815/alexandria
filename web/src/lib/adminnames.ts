// What every admin page is called, in one place: the menu, the find-a-page filter and the page headers read these, so a
// page has one short name, one icon and one line of description. A leaf module (no imports), like gmnames.ts.

export type AdminGroupId = 'worlds' | 'sources' | 'ai' | 'access' | 'server';

export interface AdminName { label: string; icon: string; desc: string; group: AdminGroupId | 'top' }

export const ADMIN_GROUPS: { id: AdminGroupId; label: string; icon: string }[] = [
  { id: 'worlds', label: 'People & worlds', icon: 'fa-globe' },
  { id: 'sources', label: 'Sources', icon: 'fa-cloud-arrow-down' },
  { id: 'ai', label: 'AI & models', icon: 'fa-microchip' },
  { id: 'access', label: 'Access & security', icon: 'fa-shield-halved' },
  { id: 'server', label: 'Server', icon: 'fa-server' },
];

/** Keyed by the route under /admin/ ('' is the overview). The key order is the menu order inside a group. */
export const ADMIN_NAMES: Record<string, AdminName> = {
  '': { group: 'top', label: 'Overview', icon: 'fa-gauge', desc: 'Worlds, connections, models and who is waiting on a GM.' },

  worlds: { group: 'worlds', label: 'Worlds', icon: 'fa-globe', desc: 'Make worlds and choose each one’s GM.' },
  accounts: { group: 'worlds', label: 'People', icon: 'fa-users', desc: 'Accounts, roles and password resets.' },
  library: { group: 'worlds', label: 'Library', icon: 'fa-book', desc: 'The pages and files of every world.' },

  sources: { group: 'sources', label: 'Sources', icon: 'fa-cloud-arrow-down', desc: 'Where pages come from: connections, world sources, keys and held files.' },
  content: { group: 'sources', label: 'Content library', icon: 'fa-book-skull', desc: 'Rules books pulled once from Open5e and the 5e SRD API, for every world.' },

  models: { group: 'ai', label: 'Models', icon: 'fa-microchip', desc: 'Which model does each job, and loading them for game night.' },
  keys: { group: 'ai', label: 'Connect AI', icon: 'fa-key', desc: 'Link an AI app to the library.' },

  access: { group: 'access', label: 'Access', icon: 'fa-lock', desc: 'Permissions and the leak check, MCP access, admin sign-in.' },
  audit: { group: 'access', label: 'Audit log', icon: 'fa-clipboard-list', desc: 'Who changed what, and when.' },

  search: { group: 'server', label: 'Search', icon: 'fa-magnifying-glass', desc: 'Search every world; the world mirror folders.' },
  integrations: { group: 'server', label: 'Devices', icon: 'fa-plug-circle-bolt', desc: 'Lights, speakers and microphones hosted here.' },
};

export const adminLabel = (route: string): string => ADMIN_NAMES[route]?.label ?? route;

/** Pages that became a tab of another page: the old address opens the new one. */
export const ADMIN_REDIRECTS: Record<string, string> = {
  connections: 'sources?tab=connections',
  'source-keys': 'sources?tab=keys',
  'source-files': 'sources?tab=files',
  permissions: 'access?tab=permissions',
  security: 'access?tab=security',
  mirror: 'search?tab=mirror',
};

// Which GM pages can be popped out. Kept free of component imports: PageHead (in ui/) uses it, and the panels themselves
// import the pages, so the other way round would be a cycle.
import { openDisplay } from './open.ts';

/** GM page path (under /w/:world/dm/) -> panel name (under /w/:world/panel/). */
export const POPOUT_OF_PAGE: Record<string, string> = {
  combat: 'combat', inbox: 'approvals', sound: 'sound', scenes: 'scenes', chat: 'chat', clock: 'clock', quick: 'quick', party: 'party',
};

/** The panel for the GM page at this pathname, if that page can be popped out. */
export function panelForPath(pathname: string): { world: string; name: string } | null {
  const m = /^\/w\/([^/]+)\/dm\/([^/]+)\/?$/.exec(pathname);
  const name = m && POPOUT_OF_PAGE[m[2]];
  return m && name ? { world: decodeURIComponent(m[1]), name } : null;
}

export const panelUrl = (world: string, name: string) => `/w/${encodeURIComponent(world)}/panel/${encodeURIComponent(name)}`;

/** A panel in its own named window: a second click brings the same one forward. */
export const popOutPanel = (world: string, name: string) => openDisplay(panelUrl(world, name), `alx-panel-${name}`, 'panels', 'width=520,height=820');

// Opening a display on a physical monitor. The Window Management API (Chrome and Edge, with the person's permission) lists the
// monitors and their rectangles; elsewhere a window just opens and the GM drags it over and presses F11.

export interface Monitor { key: string; label: string; left: number; top: number; width: number; height: number; primary: boolean }

export const canManageWindows = () => typeof (window as any).getScreenDetails === 'function';

let cache: Monitor[] = [];
const ASSIGN_KEY = 'alx.screens.assign';

/** Asks the browser for the monitors (this is where the permission prompt shows). Rejects if the GM says no. */
export async function detectMonitors(): Promise<Monitor[]> {
  const d = await (window as any).getScreenDetails();
  const seen = new Map<string, number>();
  cache = (d.screens as any[]).map((s) => {
    const base = String(s.label || (s.isPrimary ? 'Main display' : 'Display'));
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    // Two identical monitors share a label: number them so each can be told apart.
    const label = n > 1 ? `${base} #${n}` : base;
    return { key: label, label, left: s.availLeft ?? s.left, top: s.availTop ?? s.top, width: s.availWidth ?? s.width, height: s.availHeight ?? s.height, primary: !!s.isPrimary };
  });
  return cache;
}

export function getAssigned(id: string): string | undefined {
  try { return JSON.parse(localStorage.getItem(ASSIGN_KEY) ?? '{}')[id]; } catch { return undefined; }
}

/**
 * Opens a display in its own named window (a second open focuses the same one), filling the monitor the GM assigned to it
 * when the browser can place windows and the permission was given before. Otherwise it opens normally.
 */
export async function openDisplay(url: string, name: string, id: string, size = 'width=1200,height=800'): Promise<boolean> {
  let features = `popup,${size}`;
  const key = getAssigned(id);
  if (key && canManageWindows()) {
    try {
      const m = (cache.length ? cache : await detectMonitors()).find((x) => x.key === key);
      if (m) features = `popup,left=${m.left},top=${m.top},width=${m.width},height=${m.height}`;
    } catch { /* permission refused or gone: open normally */ }
  }
  const w = window.open(url, name, features);
  w?.focus?.();
  return !!w;
}

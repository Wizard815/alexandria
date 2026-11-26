// The extension's side of /api/owlbear (librarian/src/features/owlbear). The extension is served by Alexandria, so these
// are same-origin calls. The link key lives only in the GM's browser (this origin's storage inside Owlbear Rodeo),
// never in the Owlbear room, where players could read it.

export const NS = 'com.alexandria.owlbear';
const KEY = 'alx.obr.key';
const CHANNEL = 'alx-obr';

export const getKey = (): string => { try { return localStorage.getItem(KEY) ?? ''; } catch { return ''; } };
export function setKey(k: string) {
  try { if (k) localStorage.setItem(KEY, k); else localStorage.removeItem(KEY); } catch { /* storage off: the key lasts this page only */ }
  tell({ type: 'key' });
}

export interface Picture { value: string; label: string; group: 'source' | 'library' }
export interface Status {
  link: { follow: boolean; mapId: string | null; pic: string | null; lead: 'alexandria' | 'owlbear'; cells: number };
  target: { mapId: string; pic: string | null; label: string | null; mime: string | null; url: string | null; hidden: boolean };
  fog: { enabled: boolean; version: number } | null;
}
export interface Hello extends Status { world: { id: string; slug: string; name: string }; version: string; pictures: Picture[] }
export interface FogCells { enabled: boolean; version: number; cols: number; rows: number; rects: [number, number, number, number][]; pic: string }

export class ApiError extends Error { constructor(public status: number, msg: string) { super(msg); } }

export async function api<T>(method: string, path: string, body?: unknown, key = getKey()): Promise<T> {
  const r = await fetch(`/api/owlbear${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(r.status, j?.error || `Alexandria answered ${r.status}`);
  return j as T;
}

/** What the GM's background worker says it is doing, for the popover. */
export interface WorkerNote {
  state: 'idle' | 'player' | 'no-key' | 'no-scene' | 'error' | 'ok' | 'nothing';
  text: string;
  world?: string;
  picture?: string | null;
  lead?: 'alexandria' | 'owlbear';
  at: number;
}

type Msg = { type: 'key' } | { type: 'note'; note: WorkerNote } | { type: 'ask' } | { type: 'kick' };
let bc: BroadcastChannel | null = null;
const channel = () => { try { return (bc ??= new BroadcastChannel(CHANNEL)); } catch { return null; } };
export const tell = (m: Msg) => channel()?.postMessage(m);
export function listen(fn: (m: Msg) => void): () => void {
  const c = channel();
  if (!c) return () => {};
  const h = (e: MessageEvent) => fn(e.data as Msg);
  c.addEventListener('message', h);
  return () => c.removeEventListener('message', h);
}

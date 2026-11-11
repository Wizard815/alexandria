// Pages saved for offline reading ("local downloaded versions"). Each entry
// is exactly the page JSON the server returned for this viewer, so a player
// only ever stores their player copy. Uses IndexedDB; every call fails soft
// (returns empty / false) when storage is blocked, e.g. in a private window.

export interface SavedPage {
  key: string; // `${world}|${pageId}|${accountId}`
  world: string;
  account: string;
  pageId: string;
  title: string;
  folder: string[];
  source: string | null;
  savedAt: string;
  size: number;
  page: any;
}

const DB_NAME = 'alexandria-offline';
const STORE = 'pages';
/** Every GET answer the app received, for reading while offline. */
const RESP = 'responses';
export interface CachedResponse { key: string; account: string; savedAt: string; value: unknown }
let dbp: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
  if (dbp) return dbp;
  dbp = new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(DB_NAME, 2);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const s = db.createObjectStore(STORE, { keyPath: 'key' });
          s.createIndex('byWorld', ['world', 'account']);
        }
        if (!db.objectStoreNames.contains(RESP)) {
          const r = db.createObjectStore(RESP, { keyPath: 'key' });
          r.createIndex('byAccount', 'account');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbp;
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void, store = STORE): Promise<T | null> {
  return open().then((db) => new Promise<T | null>((resolve) => {
    if (!db) return resolve(null);
    try {
      const t = db.transaction(store, mode);
      const s = t.objectStore(store);
      const req = fn(s);
      t.oncomplete = () => resolve(req ? (req.result as T) : null);
      t.onerror = () => resolve(null);
      t.onabort = () => resolve(null);
    } catch {
      resolve(null);
    }
  }));
}

export const keyOf = (world: string, pageId: string, account: string) => `${world}|${pageId}|${account}`;

export async function available(): Promise<boolean> {
  return (await open()) !== null;
}

export async function savePage(world: string, account: string, page: any): Promise<boolean> {
  const json = JSON.stringify(page);
  const rec: SavedPage = {
    key: keyOf(world, page.id, account), world, account, pageId: page.id, title: page.title, folder: page.folder ?? [],
    source: page.source ?? null, savedAt: new Date().toISOString(), size: json.length, page,
  };
  return (await tx('readwrite', (s) => s.put(rec))) !== null || (await available());
}

export async function getSaved(world: string, account: string, pageId: string): Promise<SavedPage | null> {
  return (await tx<SavedPage>('readonly', (s) => s.get(keyOf(world, pageId, account)))) ?? null;
}

export async function listSaved(world: string, account: string): Promise<SavedPage[]> {
  const rows = await tx<SavedPage[]>('readonly', (s) => s.index('byWorld').getAll([world, account]));
  return (rows ?? []).sort((a, b) => a.title.localeCompare(b.title));
}

export async function removeSaved(world: string, account: string, pageId: string): Promise<void> {
  await tx('readwrite', (s) => s.delete(keyOf(world, pageId, account)));
}

// ---- Response cache (every GET, per account) ----

/** The account a cache key belongs to: keys are `<account>|<path>`. */
const accountOf = (key: string) => key.slice(0, key.indexOf('|'));

export const responseCache = {
  async get(key: string): Promise<{ value: unknown; savedAt: string } | null> {
    const r = await tx<CachedResponse>('readonly', (s) => s.get(key), RESP);
    return r ? { value: r.value, savedAt: r.savedAt } : null;
  },
  async put(key: string, value: unknown): Promise<void> {
    await tx('readwrite', (s) => s.put({ key, account: accountOf(key), savedAt: new Date().toISOString(), value } satisfies CachedResponse), RESP);
  },
  /** Many at once (prefetch), in one transaction. */
  async putMany(rows: [string, unknown][]): Promise<void> {
    if (!rows.length) return;
    const at = new Date().toISOString();
    await tx('readwrite', (s) => { for (const [key, value] of rows) s.put({ key, account: accountOf(key), savedAt: at, value } satisfies CachedResponse); }, RESP);
  },
  async savedAt(key: string): Promise<string | null> {
    return (await tx<CachedResponse>('readonly', (s) => s.get(key), RESP))?.savedAt ?? null;
  },
};

/** Forget everything stored for an account: cached answers and saved pages. */
export async function clearAccount(account: string): Promise<void> {
  await tx('readwrite', (s) => {
    const req = s.index('byAccount').openCursor(IDBKeyRange.only(account));
    req.onsuccess = () => { const c = req.result; if (c) { c.delete(); c.continue(); } };
  }, RESP);
  await tx('readwrite', (s) => {
    const req = s.openCursor();
    req.onsuccess = () => { const c = req.result; if (c) { if ((c.value as SavedPage).account === account) c.delete(); c.continue(); } };
  });
}

export function formatSize(n: number) {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** The page as a Markdown file with a small header. */
export function pageMarkdown(page: any, savedAt?: string) {
  const esc = (s: string) => (/^[\w .,'()/-]*$/.test(s) && s.trim() === s ? s : JSON.stringify(s));
  const lines = ['---', `title: ${esc(String(page.title))}`];
  if (page.tags?.length) lines.push(`tags: [${page.tags.map((t: string) => esc(t)).join(', ')}]`);
  if (page.source) lines.push(`source: ${esc(page.source)}`);
  lines.push(`saved: ${(savedAt ?? new Date().toISOString()).slice(0, 10)}`, '---', '');
  return lines.join('\n') + (page.body ?? '');
}

export function fileName(title: string) {
  return (String(title).replace(/[\\/:*?"<>|\x00-\x1f]+/g, ' ').trim().slice(0, 80) || 'page') + '.md';
}

export function download(name: string, data: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

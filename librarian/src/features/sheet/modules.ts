// The sheet is a list of modules the player arranges: built-in ones that show
// live data (health, mana, inventory, recently seen people and places) and
// ones the player fills in (people they know as allies or enemies, quick
// notes, free text, counters, checklists). "From the DM" holds the DM's secret
// notes and goals for this player; it can be moved but not removed. A module the player marks private
// is hidden from everyone else, the DM included.
import { HttpError } from '../../core/util.ts';

export const TYPES = ['vitals', 'mana', 'rerolls', 'inventory', 'dm', 'contacts', 'notes', 'recent', 'text', 'counters', 'list'] as const;
export type ModuleType = (typeof TYPES)[number];
/** Modules that show the player's own live data once; the DM always sees them. */
const SINGLE: ModuleType[] = ['vitals', 'mana', 'rerolls', 'inventory', 'dm', 'recent'];
const CAN_BE_PRIVATE: ModuleType[] = ['contacts', 'notes', 'text', 'counters', 'list'];
const MAX_MODULES = 24;
const MAX_JSON = 64_000;

export interface Module { id: string; type: ModuleType; title: string; wide: boolean; private: boolean; collapsed: boolean; data?: any }

const TITLES: Record<ModuleType, string> = { vitals: 'Health', mana: 'Mana', inventory: 'Inventory', rerolls: 'Re-rolls', dm: 'From the DM', contacts: 'People', notes: 'Quick notes', recent: 'Recently', text: 'Notes', counters: 'Counters', list: 'Checklist' };

// Most used at the top: health and mana side by side, then what a player
// reaches for during play, then what they read between scenes.
export const DEFAULT_MODULES: Module[] = [
  { id: 'vitals', type: 'vitals', title: TITLES.vitals, wide: false, private: false, collapsed: false },
  { id: 'mana', type: 'mana', title: TITLES.mana, wide: false, private: false, collapsed: false },
  { id: 'counters', type: 'counters', title: TITLES.counters, wide: false, private: false, collapsed: false, data: { entries: [] } },
  { id: 'dm', type: 'dm', title: TITLES.dm, wide: false, private: false, collapsed: false },
  { id: 'notes', type: 'notes', title: TITLES.notes, wide: false, private: false, collapsed: false, data: { text: '' } },
  { id: 'inventory', type: 'inventory', title: TITLES.inventory, wide: false, private: false, collapsed: false },
  { id: 'contacts', type: 'contacts', title: 'People I know', wide: false, private: false, collapsed: false, data: { entries: [] } },
  { id: 'recent', type: 'recent', title: TITLES.recent, wide: false, private: false, collapsed: false },
];

const txt = (v: unknown, what: string, max: number): string => {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw new HttpError(400, `${what} must be text`);
  if (v.length > max) throw new HttpError(400, `${what} is longer than ${max} characters`);
  return v;
};
const whole = (v: unknown, what: string, min: number, max: number, nullable = false): number | null => {
  if ((v === null || v === undefined || v === '') && nullable) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${what} must be a whole number from ${min} to ${max}`);
  return n;
};
const list = (v: unknown, what: string, max: number): any[] => {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new HttpError(400, `${what} must be a list`);
  if (v.length > max) throw new HttpError(400, `${what} holds at most ${max} entries`);
  return v;
};
const eid = (v: unknown, i: number) => (typeof v === 'string' && /^[\w-]{1,40}$/.test(v) ? v : `e${i}`);

function cleanData(type: ModuleType, data: any, at: string): any {
  const d = data && typeof data === 'object' ? data : {};
  switch (type) {
    case 'notes': case 'text': return { text: txt(d.text, `${at}.text`, 10_000) };
    case 'contacts': return {
      entries: list(d.entries, `${at}.entries`, 100).map((e: any, i: number) => {
        const kind = e?.kind ?? 'ally';
        if (!['ally', 'enemy', 'neutral'].includes(kind)) throw new HttpError(400, `${at}.entries[${i}].kind must be ally, enemy or neutral`);
        const name = txt(e?.name, `${at}.entries[${i}].name`, 80).trim();
        if (!name) throw new HttpError(400, `${at}.entries[${i}] needs a name`);
        const link = (v: unknown) => (typeof v === 'string' && /^[\w-]{1,60}$/.test(v) ? v : undefined);
        const pageId = link(e?.pageId), personId = link(e?.personId);
        return { id: eid(e?.id, i), name, kind, note: txt(e?.note, `${at}.entries[${i}].note`, 300), ...(personId ? { personId } : {}), ...(pageId ? { pageId } : {}) };
      }),
    };
    case 'counters': return {
      entries: list(d.entries, `${at}.entries`, 30).map((e: any, i: number) => {
        const label = txt(e?.label, `${at}.entries[${i}].label`, 40).trim();
        if (!label) throw new HttpError(400, `${at}.entries[${i}] needs a label`);
        return { id: eid(e?.id, i), label, value: whole(e?.value ?? 0, `${at}.entries[${i}].value`, -9999, 99999), max: whole(e?.max, `${at}.entries[${i}].max`, 0, 99999, true) };
      }),
    };
    case 'list': return {
      entries: list(d.entries, `${at}.entries`, 100).map((e: any, i: number) => ({ id: eid(e?.id, i), text: txt(e?.text, `${at}.entries[${i}].text`, 200), done: e?.done === true })),
    };
    default: return undefined;
  }
}

/** Checks and normalises the module list a player saves. */
export function cleanModules(raw: unknown): Module[] {
  if (!Array.isArray(raw)) throw new HttpError(400, 'modules must be a list');
  if (raw.length > MAX_MODULES) throw new HttpError(400, `A sheet holds at most ${MAX_MODULES} modules`);
  const ids = new Set<string>();
  const seen = new Set<ModuleType>();
  const out = raw.map((m: any, i: number): Module => {
    const at = `modules[${i}]`;
    if (!m || typeof m !== 'object') throw new HttpError(400, `${at} must be an object`);
    if (!(TYPES as readonly string[]).includes(m.type)) throw new HttpError(400, `${at}.type must be one of ${TYPES.join(', ')}`);
    const type = m.type as ModuleType;
    if (SINGLE.includes(type)) { if (seen.has(type)) throw new HttpError(400, `Only one ${TITLES[type]} module`); seen.add(type); }
    const mid = typeof m.id === 'string' && /^[\w-]{1,40}$/.test(m.id) ? m.id : `${type}-${i}`;
    if (ids.has(mid)) throw new HttpError(400, `Two modules share the id ${mid}`);
    ids.add(mid);
    const title = txt(m.title, `${at}.title`, 60).trim() || TITLES[type];
    const data = cleanData(type, m.data, at);
    return { id: mid, type, title, wide: m.wide === true, private: CAN_BE_PRIVATE.includes(type) && m.private === true, collapsed: m.collapsed === true, ...(data !== undefined ? { data } : {}) };
  });
  if (JSON.stringify(out).length > MAX_JSON) throw new HttpError(400, 'The sheet is too large; shorten some notes');
  return out;
}

/** What someone other than the owner sees: private modules are left out. */
export const shownTo = (mods: Module[], owner: boolean) => (owner ? mods : mods.filter((m) => !m.private));

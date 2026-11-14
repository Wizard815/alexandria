// The sculpting engine: deterministic generators first (names, stock, coins,
// the clock), then ONE chat call for the text that is still blank. Rendering
// turns {{key}} and {{#dm}}...{{/dm}} into Markdown with secret blocks.
import type { Deps } from '../../app.ts';
import { chatJson, hasJob, type ChatMessage } from '../../core/ai.ts';
import { one } from '../../core/db.ts';
import type { Viewer } from '../../core/policy.ts';
import { dmOnlyGrams, grams } from '../agent/leak.ts';
import { normalizeStatblock, statblockMarkdown } from '../agent/statblock.ts';
import type { Field, TemplateDef } from './templates.ts';

export type Values = Record<string, string>;
export interface Tpl extends Omit<TemplateDef, 'key'> { id: string }
export interface Part { dm: boolean; md: string }
export interface SculptResult { values: Values; md: string; parts: Part[]; notes: string[]; filled: string[]; model: boolean; usedModel: boolean; leaks: { key: string; match: string }[] }

const PLAYER: Viewer = { accountId: 'sculpt-player-view', role: 'player' };

// ---- optional neighbours (built in parallel, so imported defensively) ----
const cache = new Map<string, Promise<any>>();
const soft = (spec: string): Promise<any> => {
  if (!cache.has(spec)) cache.set(spec, import(spec).catch(() => null));
  return cache.get(spec)!;
};
async function softFn(name: string, specs: string[]): Promise<((...a: any[]) => any) | null> {
  for (const s of specs) { const m = await soft(s); if (m && typeof m[name] === 'function') return m[name]; }
  return null;
}
const QUICKGEN = ['../quickgen/index.ts', '../quickgen/api.ts'];

// ---- local generators ----
const pick = <T,>(a: readonly T[]): T => a[Math.floor(Math.random() * a.length)];
const A = ['Bra', 'Cal', 'Dor', 'El', 'Fen', 'Gar', 'Hal', 'Ira', 'Jor', 'Kes', 'Lir', 'Mar', 'Nel', 'Or', 'Per', 'Quin', 'Rhe', 'Sel', 'Tam', 'Ul', 'Ves', 'Wyn'];
const B = ['a', 'e', 'i', 'o', 'u', 'ia', 'ei', 'or', 'an', 'el'];
const C = ['dric', 'wen', 'ra', 'mund', 'thas', 'lin', 'na', 'ric', 'vik', 'sa', 'dan', 'bel', 'mar', 'tor'];
const SURN = ['Ashby', 'Brightwater', 'Cobb', 'Dunmere', 'Fairweather', 'Greyfield', 'Hollis', 'Marsh', 'Thorne', 'Whitlock'];
const localName = (): string => `${pick(A)}${pick(B)}${pick(C)} ${pick(SURN)}`;

async function genName(): Promise<{ name: string; race?: string } | null> {
  const f = await softFn('genNames', QUICKGEN);
  if (f) {
    try {
      let r = await f({ count: 1 });
      if (Array.isArray(r)) r = r[0];
      if (typeof r === 'string' && r.trim()) return { name: r.trim() };
      if (r && typeof r.name === 'string' && r.name.trim()) return { name: r.name.trim(), race: typeof r.race === 'string' ? r.race : undefined };
    } catch { /* use the local names */ }
  }
  return { name: localName() };
}

const STOCK: Record<string, [string, number][]> = {
  smith: [['Dagger', 200], ['Shortsword', 1000], ['Longsword', 1500], ['Handaxe', 500], ['Shield', 1000], ['Chain shirt', 5000], ['Iron spikes (10)', 100], ['Warhammer', 1500], ['Crossbow bolts (20)', 100]],
  alchemist: [["Potion of healing", 5000], ['Antitoxin', 5000], ["Alchemist's fire", 5000], ['Acid vial', 2500], ['Ink and quill', 1000], ['Herbal salve', 1000], ['Smoke pellet', 500], ['Empty flask', 2]],
  general: [['Rope, 50 ft', 100], ['Torch', 1], ['Rations (1 day)', 50], ['Backpack', 200], ['Bedroll', 100], ['Lantern', 500], ['Oil flask', 10], ['Waterskin', 20], ['Tinderbox', 50], ['Crowbar', 200]],
  magic: [['Spell scroll (cantrip)', 5000], ['Wand of light', 25000], ['Cloak of billowing', 12000], ['Bag of tricks (grey)', 40000], ['Potion of climbing', 18000], ['Driftglobe', 30000], ['Lantern of rumours', 15000]],
};
const MULT: Record<string, number> = { cheap: 0.8, fair: 1, dear: 1.35 };
export function fmtCp(cp: number): string {
  if (cp >= 100 && cp % 100 === 0) return `${cp / 100} gp`;
  if (cp >= 100) return `${Math.round(cp / 10) / 10} gp`.replace(/\.0 gp/, ' gp');
  if (cp >= 10 && cp % 10 === 0) return `${cp / 10} sp`;
  return `${Math.max(1, Math.round(cp))} cp`;
}
async function genStock(kind: string, price: string): Promise<string> {
  const k = kind.toLowerCase();
  const f = await softFn('genItems', QUICKGEN);
  if (f) {
    try {
      const r = await f({ kind: k, count: 7 });
      if (Array.isArray(r) && r.length) {
        const lines = r.map((x: any) => (typeof x === 'string' ? x : x?.name ? `${x.name}${x.price ? ` — ${x.price}` : ''}` : '')).filter(Boolean);
        if (lines.length) return lines.map((l: string) => `- ${l}`).join('\n');
      }
    } catch { /* use the local lists */ }
  }
  const table = STOCK[k] ?? STOCK.general;
  const m = MULT[price.toLowerCase()] ?? 1;
  const chosen = [...table].sort(() => Math.random() - 0.5).slice(0, 7);
  return chosen.map(([n, cp]) => `- ${n} — ${fmtCp(cp * m)}`).join('\n');
}
const genItem = (kind: string): string => pick(STOCK[kind.toLowerCase()] ?? STOCK.general)[0];
const genCoins = (): string => `${pick([5, 10, 25, 50, 75, 100, 250, 500])} gp`;

// ---- rendering ----
const keysIn = (s: string): string[] => [...s.matchAll(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g)].map((m) => m[1]);

function valueMd(f: Field | undefined, v: string): string {
  const t = (v ?? '').trim();
  if (!t) return '';
  if (f?.type === 'statblock') {
    try { return statblockMarkdown(normalizeStatblock(JSON.parse(t))).trim(); } catch { return ''; }
  }
  if (f?.type === 'list') return t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => (/^([-*+]|\d+\.)\s/.test(l) ? l : `- ${l}`)).join('\n');
  return t;
}

export function renderParts(tpl: Pick<Tpl, 'fields' | 'body' | 'perspective'>, values: Values): Part[] {
  const fields = new Map(tpl.fields.map((f) => [f.key, f]));
  const player = tpl.perspective === 'player';
  const parts: Part[] = [];
  let inDm = false;
  let fence = false;
  const push = (dm: boolean, line: string) => {
    const last = parts.at(-1);
    if (last && last.dm === dm) last.md += `\n${line}`; else parts.push({ dm, md: line });
  };
  for (const raw of tpl.body.split(/\r?\n/)) {
    let line = raw;
    let lineDm = inDm;
    if (/^\s*\{\{#dm\}\}\s*$/.test(line)) { inDm = true; continue; }
    if (/^\s*\{\{\/dm\}\}\s*$/.test(line)) { inDm = false; continue; }
    if (/\{\{#dm\}\}/.test(line) && /\{\{\/dm\}\}/.test(line)) { line = line.replace(/\{\{#dm\}\}|\{\{\/dm\}\}/g, ''); lineDm = true; }
    const ks = keysIn(line);
    if (ks.some((k) => fields.get(k)?.dmOnly)) lineDm = true;
    if (lineDm && player) continue;
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (ks.length) {
      const vals = ks.map((k) => valueMd(fields.get(k), values[k] ?? ''));
      if (vals.every((v) => !v)) continue;
      line = line.replace(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g, (_m, k) => valueMd(fields.get(k), values[k] ?? '') || '…');
    }
    void fence;
    push(lineDm, line);
  }
  return parts.map((p) => ({ dm: p.dm, md: p.md.replace(/^\n+|\n+$/g, '') })).filter((p) => p.md.trim());
}

/** Secret blocks are `> [!secret]` callouts: players' copies drop them. */
export const secretBlock = (md: string): string => ['> [!secret] DM', ...md.split('\n').map((l) => (l.trim() ? `> ${l}` : '>'))].join('\n');

export function renderMd(parts: Part[]): string {
  return `${parts.map((p) => (p.dm ? secretBlock(p.md) : p.md)).join('\n\n')}\n`;
}

// ---- the leak check for player-perspective templates ----
export function cleanForPlayer(d: Deps, worldId: string, tpl: Tpl, values: Values): { values: Values; leaks: { key: string; match: string }[] } {
  if (tpl.perspective !== 'player') return { values, leaks: [] };
  const dm = dmOnlyGrams(d.db, worldId);
  const out: Values = {};
  const leaks: { key: string; match: string }[] = [];
  const dmKeys = new Set(tpl.fields.filter((f) => f.dmOnly).map((f) => f.key));
  for (const [k, v] of Object.entries(values)) {
    if (dmKeys.has(k)) continue; // never part of a player copy
    const hit = [...grams(v)].find((g) => dm.has(g));
    if (hit) { leaks.push({ key: k, match: hit }); out[k] = ''; } else out[k] = v;
  }
  return { values: out, leaks };
}

// ---- context for the model ----
const excerpt = (s: string, n: number) => s.replace(/\s+/g, ' ').trim().slice(0, n);

function pageByRef(d: Deps, worldId: string, ref: string): string | null {
  const r = ref.trim();
  if (!r) return null;
  return one<any>(d.db, `SELECT id FROM pages WHERE world_id = ? AND (id = ? OR title = ? COLLATE NOCASE OR path = ? OR path = ?)`, worldId, r, r, r, `${r}.md`)?.id ?? null;
}

function notesFor(d: Deps, worldId: string, tpl: Tpl, values: Values, viewer: Viewer): string[] {
  const out: string[] = [];
  for (const f of tpl.fields) {
    if (f.type !== 'page' || !values[f.key]) continue;
    const id = pageByRef(d, worldId, values[f.key]);
    if (!id) continue;
    try {
      const pg: any = d.library.get(worldId, id, viewer);
      out.push(`${pg.title}: ${excerpt(String(pg.body ?? ''), 700)}`);
    } catch { /* not visible to this viewer */ }
  }
  const q = [tpl.name, ...Object.entries(values).filter(([k, v]) => v && !tpl.fields.find((f) => f.key === k)?.dmOnly && tpl.fields.find((f) => f.key === k)?.type !== 'statblock').map(([, v]) => v.slice(0, 60))].join(' ');
  try {
    for (const h of d.library.search(worldId, q, viewer, 5) as any[]) {
      if (out.length >= 5) break;
      const line = `${h.title}: ${excerpt(String(h.snippet ?? ''), 240)}`;
      if (!out.some((o) => o.startsWith(`${h.title}:`))) out.push(line);
    }
  } catch { /* search found nothing */ }
  return out.slice(0, 5);
}

const SHAPE = '{"name":"","size":"Medium","type":"","alignment":"","cr":1,"xp":200,"ac":13,"acType":"","hp":27,"hitDice":"5d8+5","speed":{"walk":"30 ft."},"abilities":{"str":10,"dex":14,"con":12,"int":10,"wis":10,"cha":10},"skills":{},"senses":{"passive_perception":10},"languages":"","traits":[{"name":"","text":""}],"actions":[{"name":"","text":"Melee Attack Roll: +4, reach 5 ft. Hit: 5 (1d6 + 2) Slashing damage."}],"bonusActions":[],"reactions":[]}';

const MODEL_TYPES = new Set(['text', 'longtext', 'number', 'select', 'list', 'statblock', 'name']);

export interface RunOpts { lock?: string[]; only?: string[] }

/** Fill the blanks. At most one model call. */
export async function sculpt(d: Deps, worldId: string, worldName: string, tpl: Tpl, input: Values, opts: RunOpts = {}): Promise<SculptResult> {
  const fieldKeys = new Set(tpl.fields.map((f) => f.key));
  const values: Values = {};
  for (const f of tpl.fields) values[f.key] = typeof input[f.key] === 'string' ? input[f.key] : input[f.key] == null ? '' : String(input[f.key]);
  const locked = new Set((opts.lock ?? []).filter((k) => fieldKeys.has(k)));
  const only = opts.only?.length ? new Set(opts.only.filter((k) => fieldKeys.has(k))) : null;
  const wanted = (f: Field) => (only ? only.has(f.key) : !locked.has(f.key) && !values[f.key].trim());
  const notes: string[] = [];
  const filled: string[] = [];
  const player = tpl.perspective === 'player';

  // 1. Deterministic generators.
  const todo = tpl.fields.filter(wanted);
  if (only) for (const f of todo) values[f.key] = '';
  for (const f of todo) {
    let v = '';
    if (f.gen === 'clock') {
      const c = await softFn('getClock', ['../clock/api.ts']);
      try { v = c ? String(c(d.db, worldId)?.label ?? '') : ''; } catch { v = ''; }
    } else if (f.gen === 'stock') v = await genStock(values.kind || (tpl.fields.find((x) => x.key === 'kind')?.options?.[0] ?? 'general'), values.price || 'fair');
    else if (f.type === 'name') {
      const g = await genName();
      v = g?.name ?? '';
      if (g?.race && tpl.fields.some((x) => x.key === 'race') && !values.race.trim() && !locked.has('race') && !only) { values.race = g.race; filled.push('race'); }
    } else if (f.type === 'item') v = genItem(values.kind || '');
    else if (f.type === 'coins') v = genCoins();
    if (v) { values[f.key] = v; filled.push(f.key); }
  }

  // 2. One model call for what is still blank.
  const blank = tpl.fields.filter((f) => wanted(f) && !values[f.key].trim() && MODEL_TYPES.has(f.type));
  const missingPages = tpl.fields.filter((f) => f.type === 'page' && f.required && !values[f.key].trim());
  for (const f of missingPages) notes.push(`${f.label} needs a library page: pick one yourself.`);
  const model = hasJob(d, 'chat');
  let usedModel = false;
  if (blank.length) {
    if (!model) notes.push(`No chat model is set (Admin → Models), so ${blank.map((f) => f.label).join(', ')} stay empty. Fill them by hand.`);
    else {
      const viewer: Viewer = player ? PLAYER : { accountId: 'sculpt-dm-view', role: 'dm' };
      const context = Object.fromEntries(tpl.fields.filter((f) => values[f.key].trim() && !blank.includes(f) && f.type !== 'statblock' && !(player && f.dmOnly)).map((f) => [f.key, values[f.key].slice(0, 400)]));
      const snippets = notesFor(d, worldId, tpl, values, viewer);
      const sys = [
        `You fill blank fields of the template "${tpl.name}" for a D&D game master. World: ${worldName}.`,
        'Reply with one JSON object whose keys are exactly the blank field keys.',
        'Be short, concrete and ready to use at the table. Plain text, no Markdown headings. A "list" is an array of short strings. A "select" is one of its options. A "number" is a number.',
        blank.some((f) => f.type === 'statblock') ? `A "statblock" is an object like ${SHAPE}. Keep numbers consistent with the CR.` : '',
        player ? 'This is for the players: use only the player-visible notes given. Never invent or hint at secrets, hidden causes or hidden identities.' : 'Stay consistent with the world notes.',
      ].filter(Boolean).join(' ');
      const user = JSON.stringify({ blank: blank.map((f) => ({ key: f.key, label: f.label, type: f.type, ...(f.options ? { options: f.options } : {}), ...(f.hint ? { hint: f.hint } : {}) })), filled: context, worldNotes: snippets });
      const messages: ChatMessage[] = [{ role: 'system', content: sys }, { role: 'user', content: user }];
      let raw: any = null;
      try { raw = await chatJson<any>(d, 'chat', messages); usedModel = true; } catch { raw = null; }
      if (raw && typeof raw === 'object' && !blank.some((f) => raw[f.key] != null && raw[f.key] !== '')) notes.push('The chat model answered without any of the blank fields. Try again.');
      if (!raw || typeof raw !== 'object') notes.push('The chat model did not return usable text. Try again, or fill the blanks by hand.');
      else {
        for (const f of blank) {
          let v: unknown = raw[f.key];
          if (v == null || v === '') continue;
          if (f.type === 'statblock') {
            try { values[f.key] = JSON.stringify(normalizeStatblock(typeof v === 'string' ? JSON.parse(v) : v, values.name)); filled.push(f.key); } catch (e: any) { notes.push(`${f.label}: ${e?.message ?? 'not valid'}`); }
            continue;
          }
          if (Array.isArray(v)) v = v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n');
          else if (typeof v === 'object') v = Object.values(v as object).join('\n');
          let s = String(v).trim();
          if (f.type === 'select' && f.options?.length) {
            const hit = f.options.find((o) => o.toLowerCase() === s.toLowerCase());
            if (!hit) { notes.push(`${f.label}: the model chose "${s.slice(0, 30)}", which is not an option.`); continue; }
            s = hit;
          }
          values[f.key] = s;
          filled.push(f.key);
        }
      }
    }
  }

  // 3. The players' copy must never carry DM-only words.
  const cleaned = cleanForPlayer(d, worldId, tpl, values);
  for (const l of cleaned.leaks) {
    notes.push(`Blocked "${tpl.fields.find((f) => f.key === l.key)?.label ?? l.key}": it repeats words from DM-only notes.`);
    const i = filled.indexOf(l.key);
    if (i >= 0) filled.splice(i, 1);
  }
  const parts = renderParts(tpl, cleaned.values);
  return { values: cleaned.values, md: renderMd(parts), parts, notes, filled: [...new Set(filled)], model, usedModel, leaks: cleaned.leaks };
}

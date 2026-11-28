// Items and the assistant: an item the GM added to the item database yesterday has a name no model has seen and no
// word in the tool picker. When a message to the GM's assistant names an item in the database, the harness adds the
// item's entry to the context (with the GM's notes) and offers the item tools. A player's helper gets the database
// entry (never the GM's notes) for each item the player or the party holds, so "what does my lantern do?" has the answer.
import type { DB } from '../../core/db.ts';
import { all } from '../../core/db.ts';
import { nameKey } from './items.ts';
import { names as accountNames } from '../../routes/_shared.ts';

export interface ItemHints { tools: string[]; text: string; items: string[] }

interface Row { id: string; name: string; name_key: string; type: string; rarity: string; cost_cp: number | null; description: string; properties: string; attunement: number; source: string; source_label: string; gm_notes: string }

const MIN_KEY = 6;
const gp = (cp: number | null) => (cp === null ? 'no price' : cp % 100 === 0 ? `${cp / 100} gp` : cp % 10 === 0 ? `${cp / 10} sp` : `${cp} cp`);
const clip = (s: string, n: number) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

/** One item in a few lines; the GM's notes only for the GM. */
export function itemLine(r: Row, gm: boolean): string {
  const head = `${r.name} (${[r.rarity, r.type].filter(Boolean).join(' ')}${r.attunement ? ', needs attunement' : ''}${gm ? `; ${gp(r.cost_cp)}; id ${r.id}; from ${r.source_label}` : ''})`;
  return [head, r.properties && `Properties: ${clip(r.properties, 200)}`, r.description && clip(r.description, 400), gm && r.gm_notes && `GM notes: ${clip(r.gm_notes, 200)}`].filter(Boolean).join('. ');
}

/** The GM's message names these database items (whole names of six letters or more, longest first, at most three). */
export function namedItems(db: DB, worldId: string, text: string, limit = 3): Row[] {
  const t = ` ${nameKey(text)} `;
  if (t.trim().length < MIN_KEY) return [];
  const rows = all<Row>(db, 'SELECT id, name, name_key, type, rarity, cost_cp, description, properties, attunement, source, source_label, gm_notes FROM shop_items WHERE world_id = ? AND length(name_key) >= ?', worldId, MIN_KEY);
  const hit = rows.filter((r) => t.includes(` ${r.name_key} `)).sort((a, b) => b.name_key.length - a.name_key.length);
  // A longer name wins over a shorter one inside it ("Emberglass Lantern" over "Lantern").
  const out: Row[] = [];
  for (const r of hit) if (!out.some((o) => o.name_key.includes(r.name_key))) out.push(r);
  return out.slice(0, limit);
}

/** The note and tools for a GM's message that names items in the database. */
export function itemHints(db: DB, worldId: string, text: string): ItemHints {
  let rows: Row[] = [];
  try { rows = namedItems(db, worldId, text); } catch { return { tools: [], text: '', items: [] }; }
  if (!rows.length) return { tools: [], text: '', items: [] };
  // The players' account ids ride along: without them a model asked to give "Jessamine" an item puts it in the party pouch.
  const players = all<{ id: string }>(db, "SELECT account_id AS id FROM members WHERE world_id = ? AND role = 'player'", worldId);
  const nm = accountNames(db, worldId);
  const who = players.length ? `\nadd_item owner: 'party', or a player's account id: ${players.slice(0, 12).map((p) => `${nm[p.id] ?? p.id} = ${p.id}`).join(', ')}.` : '';
  return {
    tools: ['search_items', 'edit_item', 'add_item', 'get_inventory', 'list_members'],
    text: `Items in this world's item database that this message names (give one with add_item using the same name):\n${rows.map((r) => `- ${itemLine(r, true)}`).join('\n')}${who}`,
    items: rows.map((r) => r.name),
  };
}

/** Database entries for items a player holds, by inventory name (no GM notes). Unknown names are left out. */
export function heldItemFacts(db: DB, worldId: string, names: string[]): Map<string, string> {
  const keys = [...new Set(names.map(nameKey).filter(Boolean))].slice(0, 60);
  const out = new Map<string, string>();
  if (!keys.length) return out;
  let rows: Row[] = [];
  try { rows = all<Row>(db, `SELECT id, name, name_key, type, rarity, cost_cp, description, properties, attunement, source, source_label, gm_notes FROM shop_items WHERE world_id = ? AND name_key IN (${keys.map(() => '?').join(',')})`, worldId, ...keys); } catch { return out; }
  for (const r of rows) if (!out.has(r.name_key)) out.set(r.name_key, itemLine(r, false));
  return out;
}

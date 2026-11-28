// The GM's short commands for Active mode: typed in the Minerva chat, spoken
// after the wake word, or run by a macro action. One parser, one executor.
//   /takeover                switch everything to auto (again: put the old settings back)
//   /takeover-<n>            apply saved preset n (1 Mood only, 2 Combat helper, 3 Full takeover)
//   /takeover-save <n> [name]  save the current settings as preset n
//   /auto <category> on|off|ask   (on = auto)
//   /active on|off | /assistant
import type { Deps } from '../../app.ts';
import { CATEGORIES, type Category } from './cues.ts';
import { DEFAULT_CATS, cleanCats, getState, saveState, type Cats } from './store.ts';

export type Command =
  | { cmd: 'takeover' } | { cmd: 'preset'; n: string } | { cmd: 'save'; n: string; name: string }
  | { cmd: 'auto'; category: Category; setting: 'auto' | 'ask' | 'off' } | { cmd: 'mode'; mode: 'active' | 'assistant' };

const ALIAS: Record<string, Category> = { music: 'music', ambience: 'music', sound: 'sfx', sounds: 'sfx', sfx: 'sfx', effects: 'sfx', stage: 'stage', screen: 'stage', events: 'events', quick: 'events', checks: 'events', combat: 'combat', tracker: 'combat', monsters: 'combatAdd', creatures: 'combatAdd', items: 'items', coins: 'items', loot: 'items', clock: 'clock', time: 'clock', rests: 'clock', notes: 'notes' };
const NUM: Record<string, string> = { one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9' };

/** A command in chat ("/takeover-2") or speech ("takeover two", "set music to auto"). Null: not one. */
export function parseCommand(text: string): Command | null {
  const t = text.trim().replace(/\s+/g, ' ');
  let m: RegExpMatchArray | null;
  if ((m = t.match(/^\/takeover[- ]save\s+(\d{1,2})(?:\s+(.{1,40}))?$/i))) return { cmd: 'save', n: m[1], name: (m[2] ?? `Preset ${m[1]}`).trim() };
  if ((m = t.match(/^\/takeover[- ](\d{1,2})$/i))) return { cmd: 'preset', n: m[1] };
  if (/^\/takeover$/i.test(t)) return { cmd: 'takeover' };
  if ((m = t.match(/^\/auto\s+([a-z]+)\s+(on|off|ask|auto)$/i))) { const c = ALIAS[m[1].toLowerCase()] ?? ((CATEGORIES as string[]).includes(m[1]) ? (m[1] as Category) : null); if (c) return { cmd: 'auto', category: c, setting: m[2].toLowerCase() === 'on' ? 'auto' : (m[2].toLowerCase() as any) }; }
  if (/^\/(active|takeover-on)$/i.test(t) || /^\/active on$/i.test(t)) return { cmd: 'mode', mode: 'active' };
  if (/^\/(assistant|active off)$/i.test(t)) return { cmd: 'mode', mode: 'assistant' };
  // Spoken forms (after the wake word).
  const s = t.toLowerCase().replace(/[.!?,]+$/g, '');
  if ((m = s.match(/^(?:go to |switch to |use |apply )?(?:take ?over|take-over)(?: preset)?\s+(\d|one|two|three|four|five)$/))) return { cmd: 'preset', n: NUM[m[1]] ?? m[1] };
  if (/^(?:full |total )?(?:take ?over|take-over)(?: mode)?(?: on| off)?$/.test(s) || /^take over the table$/.test(s)) return { cmd: 'takeover' };
  if ((m = s.match(/^(?:set |turn )?(music|ambience|sound effects?|sfx|stage|screen|quick events?|combat|tracker|monsters|items|coins|loot|clock|time|notes)\s+(?:to |is )?(auto|automatic|on|off|ask)$/))) { const k = m[1].replace(/ effects?$/, '').replace(/quick events?/, 'events'); const c = ALIAS[k]; if (c) return { cmd: 'auto', category: c, setting: m[2] === 'off' ? 'off' : m[2] === 'ask' ? 'ask' : 'auto' }; }
  if (/^(?:go |switch |turn )?(?:to )?active(?: mode)?(?: on)?$/.test(s)) return { cmd: 'mode', mode: 'active' };
  if (/^(?:go |switch |turn )?(?:to )?assistant(?: mode)?$|^active(?: mode)? off$/.test(s)) return { cmd: 'mode', mode: 'assistant' };
  return null;
}

const same = (a: Cats, b: Cats) => CATEGORIES.every((c) => a[c] === b[c]);

/** Run a command. Returns a sentence for the GM. */
export function runCommand(d: Deps, worldId: string, c: Command): string {
  const st = getState(d, worldId);
  switch (c.cmd) {
    case 'takeover': {
      const full = st.presets['3'].cats;
      if (st.prev && same(st.cats, full)) { saveState(d, worldId, { cats: st.prev, prev: null }); return 'Takeover off: your earlier settings are back.'; }
      saveState(d, worldId, { cats: full, prev: same(st.cats, full) ? st.prev : st.cats, mode: 'active' });
      return 'Takeover on: every category is on auto, in Active mode. Say /takeover again to put your settings back. Players still only ever see party-level content.';
    }
    case 'preset': {
      const p = st.presets[c.n];
      if (!p) return `There is no preset ${c.n}. Presets: ${Object.entries(st.presets).map(([k, v]) => `${k} ${v.name}`).join(', ')}.`;
      saveState(d, worldId, { cats: p.cats, prev: null, mode: 'active' });
      return `Preset ${c.n} (${p.name}) applied, Active mode on.`;
    }
    case 'save': {
      const presets = { ...st.presets, [c.n]: { name: c.name, cats: st.cats } };
      saveState(d, worldId, { presets });
      return `Saved the current settings as preset ${c.n} (${c.name}). Apply it with /takeover-${c.n}.`;
    }
    case 'auto': {
      if (c.category === 'notes' && c.setting === 'auto') return 'Notes, clues and NPCs are always drafted to Review; they are never applied by themselves.';
      saveState(d, worldId, { cats: cleanCats({ ...st.cats, [c.category]: c.setting }, DEFAULT_CATS), prev: null });
      return `${c.category} is now ${c.setting}.`;
    }
    case 'mode':
      saveState(d, worldId, { mode: c.mode });
      return c.mode === 'active' ? 'Active mode on: I listen to the table while recording.' : 'Assistant mode: I act only when you ask.';
  }
}

/** For a chat message: the reply if it was a command, else null. */
export function tryChatCommand(d: Deps, worldId: string, text: string): string | null {
  if (!text.trim().startsWith('/')) return null;
  const c = parseCommand(text);
  if (!c) return /^\/(takeover|auto|active|assistant)/i.test(text.trim()) ? 'I did not understand that. Try /takeover, /takeover-1 to /takeover-3, /takeover-save <n> [name], /auto <music|sfx|stage|events|combat|monsters|items|clock> on|off|ask, /active, /assistant.' : null;
  return runCommand(d, worldId, c);
}

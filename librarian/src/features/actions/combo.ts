// Key combinations for bindings: "Ctrl+Alt+Shift+1", "F13". Stored in one
// canonical spelling so the same keys always compare equal, whichever way the
// person typed them or a keyboard reports them.
import { HttpError } from '../../core/util.ts';

const MODS = ['Ctrl', 'Alt', 'Shift', 'Meta'] as const;
const MOD_ALIASES: Record<string, (typeof MODS)[number]> = { ctrl: 'Ctrl', control: 'Ctrl', alt: 'Alt', option: 'Alt', opt: 'Alt', shift: 'Shift', meta: 'Meta', cmd: 'Meta', command: 'Meta', win: 'Meta', super: 'Meta' };
const NAMED = ['Space', 'Enter', 'Escape', 'Tab', 'Backspace', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Pause', 'PrintScreen', 'ScrollLock', 'NumLock', 'ContextMenu'];
const KEY_ALIASES: Record<string, string> = { esc: 'Escape', return: 'Enter', ' ': 'Space', spacebar: 'Space', del: 'Delete', ins: 'Insert', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', pgup: 'PageUp', pgdn: 'PageDown' };

/** A key name in canonical form (F13, A, 5, Space, ArrowUp, Numpad5, ...), or null. */
export function normKey(raw: string): string | null {
  if (raw === ' ') return 'Space';
  const s = raw.trim();
  if (!s) return null;
  const lower = s.toLowerCase();
  if (KEY_ALIASES[lower]) return KEY_ALIASES[lower];
  if (/^f([1-9]|1\d|2[0-4])$/i.test(s)) return 'F' + s.slice(1);
  if (/^[a-z0-9]$/i.test(s)) return s.toUpperCase();
  const num = /^numpad([0-9]|add|subtract|multiply|divide|decimal|enter)$/i.exec(s);
  if (num) return 'Numpad' + num[1][0].toUpperCase() + num[1].slice(1).toLowerCase();
  return NAMED.find((n) => n.toLowerCase() === lower) ?? null;
}

/** Canonical combo, or throws a 400. A plain letter, digit or space needs Ctrl, Alt or Meta, so a binding can never swallow typing. */
export function normCombo(input: unknown): string {
  if (typeof input !== 'string' || input.length > 60) throw new HttpError(400, 'combo is required, e.g. F13 or Ctrl+Alt+Shift+1');
  const parts = input.split('+').map((p) => p.trim());
  const mods = new Set<string>();
  let key: string | null = null;
  for (const p of parts) {
    const m = MOD_ALIASES[p.toLowerCase()];
    if (m) { mods.add(m); continue; }
    if (key !== null) throw new HttpError(400, 'A combo is any modifiers and exactly one key');
    key = normKey(p);
    if (!key) throw new HttpError(400, `"${p}" is not a key I know (try F13, Ctrl+Alt+1, Shift+F5)`);
  }
  if (!key) throw new HttpError(400, 'A combo needs a key as well as modifiers');
  const printable = /^[A-Z0-9]$|^Space$/.test(key);
  if (printable && !mods.has('Ctrl') && !mods.has('Alt') && !mods.has('Meta')) throw new HttpError(400, 'A letter, digit or space needs Ctrl, Alt or Meta too, so it cannot get in the way of typing');
  return [...MODS.filter((m) => mods.has(m)), key].join('+');
}

/** The scopes whose bindings apply where a client runs: the browser reads web and both, the desktop app app and both. */
export const scopesFor = (scope: string): string[] => (scope === 'web' ? ['web', 'both'] : scope === 'app' ? ['app', 'both'] : ['web', 'app', 'both']);
export const SCOPES = ['web', 'app', 'both'] as const;
/** Two scopes overlap when one client could see both. */
export const overlap = (a: string, b: string) => a === 'both' || b === 'both' || a === b;

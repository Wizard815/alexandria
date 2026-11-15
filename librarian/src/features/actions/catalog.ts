// The action registry (PLAN §16.1): every named thing a button, a hotkey, a
// macro or a trigger URL can do. An action declares who may run it and a typed
// argument list; it does its work by calling the world API with the caller's
// own token (so every route's own rules apply a second time), or a feature
// function where one is exported.
import type { Deps } from '../../app.ts';
import { HttpError } from '../../core/util.ts';
import { rollDice } from '../agent/intent.ts';
import { runScene } from '../lights/engine.ts';

export type Role = 'dm' | 'player';

export interface ArgSpec {
  name: string;
  type: 'string' | 'int' | 'number' | 'bool' | 'enum';
  label?: string;
  required?: boolean;
  default?: string | number | boolean;
  values?: readonly string[];
  min?: number;
  max?: number;
  maxLength?: number;
}

export interface Runner {
  d: Deps;
  worldId: string;
  accountId: string;
  role: Role;
  /** Calls the world API as the caller. */
  call(method: string, path: string, body?: unknown): Promise<{ ok: boolean; status: number; json: any }>;
}

export interface ActionDef {
  id: string;
  title: string;
  group: string;
  description: string;
  /** Who may run it. Everything not listed for players is DM-only. */
  roles: Role[];
  args: ArgSpec[];
  run(rc: Runner, a: Record<string, any>): Promise<unknown>;
}

/** A failed action: the message is for the person who pressed the button. */
export class ActionError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

// ---- arguments ----------------------------------------------------------------------

/** Check an argument object against the spec. Strings are accepted for numbers and flags (a trigger URL only has strings). Unknown names are refused. */
export function validateArgs(spec: ArgSpec[], input: unknown): Record<string, any> {
  const given = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const known = new Set(spec.map((s) => s.name));
  for (const k of Object.keys(given)) if (!known.has(k)) throw new ActionError(`Unknown argument "${k}"`);
  const out: Record<string, any> = {};
  for (const s of spec) {
    let v = given[s.name];
    if (v === undefined || v === null || v === '') v = s.default;
    if (v === undefined || v === null || v === '') {
      if (s.required) throw new ActionError(`${s.label ?? s.name} is required`);
      continue;
    }
    switch (s.type) {
      case 'string': {
        if (typeof v !== 'string' && typeof v !== 'number') throw new ActionError(`${s.name} must be text`);
        const t = String(v);
        if (t.length > (s.maxLength ?? 2000)) throw new ActionError(`${s.name} is too long`);
        out[s.name] = t;
        break;
      }
      case 'int':
      case 'number': {
        const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
        if (!Number.isFinite(n) || (s.type === 'int' && !Number.isInteger(n))) throw new ActionError(`${s.name} must be a ${s.type === 'int' ? 'whole ' : ''}number`);
        if (s.min !== undefined && n < s.min) throw new ActionError(`${s.name} must be at least ${s.min}`);
        if (s.max !== undefined && n > s.max) throw new ActionError(`${s.name} must be at most ${s.max}`);
        out[s.name] = n;
        break;
      }
      case 'bool': {
        if (v === true || v === 'true' || v === '1' || v === 'on' || v === 'yes') out[s.name] = true;
        else if (v === false || v === 'false' || v === '0' || v === 'off' || v === 'no') out[s.name] = false;
        else throw new ActionError(`${s.name} must be true or false`);
        break;
      }
      case 'enum': {
        if (typeof v !== 'string' || !s.values?.includes(v)) throw new ActionError(`${s.name} must be one of ${s.values?.join(', ')}`);
        out[s.name] = v;
        break;
      }
    }
  }
  return out;
}

// ---- helpers ------------------------------------------------------------------------

async function ok(rc: Runner, method: string, path: string, body?: unknown): Promise<any> {
  const r = await rc.call(method, path, body);
  if (!r.ok) throw new ActionError(String(r.json?.error ?? `The request failed (${r.status})`), r.status);
  return r.json;
}

const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();
const pick = <T extends { id: string }>(list: T[], ref: string, ...names: ((x: T) => string)[]): T | undefined =>
  list.find((x) => x.id === ref) ?? list.find((x) => names.some((n) => norm(n(x)) === norm(ref)));

async function combatant(rc: Runner, ref: string) {
  const c = await ok(rc, 'GET', '/live/combat');
  const list: any[] = c.combatants ?? [];
  if (!list.length) throw new ActionError('There is no one in combat');
  const x = norm(ref) === 'current' ? list[c.turn % list.length] : pick(list, ref, (y) => y.name);
  if (!x) throw new ActionError(`No combatant "${ref}"`, 404);
  return x;
}

const QUICK_TEMPLATES: Record<string, { kind: string; title: string; prompt: string; options?: string[]; skill?: string; dc?: number; timerS?: number }> = {
  ambush: { kind: 'save', title: 'Ambush!', prompt: 'Something moves in the dark. Roll to react.', skill: 'Perception', dc: 13 },
  noise: { kind: 'notice', title: 'A sudden noise', prompt: 'You hear something close by.' },
  vote: { kind: 'vote', title: 'Decide together', prompt: 'What does the party do?', options: ['Press on', 'Hold back'] },
  trap: { kind: 'save', title: 'A trap!', prompt: 'The floor clicks underfoot.', skill: 'Dexterity', dc: 14 },
};

const holds = new WeakMap<Deps, Map<string, { sessionId: string; startMs: number }>>();

async function activeSession(rc: Runner) {
  const list: any[] = await ok(rc, 'GET', '/audio/sessions');
  return list.find((s) => s.active);
}

const A = (a: ArgSpec): ArgSpec => a;
const TARGET: ArgSpec = A({ name: 'target', type: 'string', label: 'Who (current, a name or an id)', default: 'current', maxLength: 80 });

export const ACTIONS: ActionDef[] = [
  // ---- combat ----
  { id: 'combat.start', title: 'Start combat', group: 'Combat', description: 'Turn the combat tracker on.', roles: ['dm'], args: [], run: (rc) => ok(rc, 'PUT', '/live/combat', { active: true }) },
  { id: 'combat.end', title: 'End combat', group: 'Combat', description: 'Turn the combat tracker off.', roles: ['dm'], args: [], run: (rc) => ok(rc, 'PUT', '/live/combat', { active: false }) },
  { id: 'combat.next', title: 'Next turn', group: 'Combat', description: 'Move the combat tracker to the next turn.', roles: ['dm'], args: [], run: async (rc) => { const c = await ok(rc, 'POST', '/live/combat/next'); return { round: c.round, turn: c.turn }; } },
  {
    id: 'combat.damage', title: 'Damage a combatant', group: 'Combat', description: 'Take hit points off a combatant (the current one by default).', roles: ['dm'],
    args: [TARGET, A({ name: 'amount', type: 'int', label: 'Damage', required: true, min: 0, max: 99999 })],
    run: async (rc, a) => { const x = await combatant(rc, a.target); const r = await ok(rc, 'PATCH', `/live/combatants/${encodeURIComponent(x.id)}`, { damage: a.amount }); return { name: x.name, hp: r.hp }; },
  },
  {
    id: 'combat.heal', title: 'Heal a combatant', group: 'Combat', description: 'Give hit points to a combatant (the current one by default), up to their maximum.', roles: ['dm'],
    args: [TARGET, A({ name: 'amount', type: 'int', label: 'Healing', required: true, min: 0, max: 99999 })],
    run: async (rc, a) => { const x = await combatant(rc, a.target); const r = await ok(rc, 'PATCH', `/live/combatants/${encodeURIComponent(x.id)}`, { heal: a.amount }); return { name: x.name, hp: r.hp }; },
  },
  {
    id: 'combat.add_statblock', title: 'Add a statblock to combat', group: 'Combat', description: 'Add a creature from a statblock page to the combat tracker.', roles: ['dm'],
    args: [A({ name: 'page', type: 'string', label: 'Statblock page id', required: true, maxLength: 80 }), A({ name: 'initiative', type: 'int', label: 'Initiative (rolled if empty)', min: -20, max: 60 }), A({ name: 'hidden', type: 'bool', label: 'Hidden from players', default: false })],
    run: async (rc, a) => { const r = await ok(rc, 'POST', `/agent/statblock/${encodeURIComponent(a.page)}/combat`, { initiative: a.initiative, hidden: a.hidden }); return r.combatant; },
  },
  // ---- clock ----
  { id: 'clock.short_rest', title: 'Short rest', group: 'Clock', description: 'Advance the world clock by a short rest.', roles: ['dm'], args: [], run: (rc) => ok(rc, 'POST', '/clock/advance', { preset: 'short-rest' }).then((r) => ({ date: r.entry?.afterLabel ?? null })) },
  { id: 'clock.long_rest', title: 'Long rest', group: 'Clock', description: 'Advance the world clock by a long rest.', roles: ['dm'], args: [], run: (rc) => ok(rc, 'POST', '/clock/advance', { preset: 'long-rest' }).then((r) => ({ date: r.entry?.afterLabel ?? null })) },
  { id: 'clock.next_day', title: 'Next day', group: 'Clock', description: 'Advance the world clock to the next day.', roles: ['dm'], args: [], run: (rc) => ok(rc, 'POST', '/clock/advance', { preset: 'next-day' }).then((r) => ({ date: r.entry?.afterLabel ?? null })) },
  { id: 'clock.advance', title: 'Advance the clock', group: 'Clock', description: 'Move the world clock forward by some minutes.', roles: ['dm'], args: [A({ name: 'minutes', type: 'int', label: 'Minutes', required: true, min: 1, max: 525600 }), A({ name: 'reason', type: 'string', label: 'Why', maxLength: 200 })], run: (rc, a) => ok(rc, 'POST', '/clock/advance', { minutes: a.minutes, reason: a.reason ?? '' }).then(() => ({ minutes: a.minutes })) },
  // ---- sound ----
  {
    id: 'sound.pad', title: 'Play a sound pad', group: 'Sound', description: 'Play a sound pad by its label or id.', roles: ['dm'], args: [A({ name: 'pad', type: 'string', label: 'Pad label or id', required: true, maxLength: 80 })],
    run: async (rc, a) => { const pads: any[] = await ok(rc, 'GET', '/sound/pads'); const p = pick(pads, a.pad, (x) => x.label); if (!p) throw new ActionError(`No sound pad "${a.pad}"`, 404); await ok(rc, 'POST', '/sound/sfx/play', { padId: p.id }); return { pad: p.label }; },
  },
  {
    id: 'sound.mood', title: 'Set the music mood', group: 'Sound', description: 'Move the music to a spot on the mood map (x left to right, y top to bottom, both 0 to 1).', roles: ['dm'],
    args: [A({ name: 'x', type: 'number', label: 'Mood x (0 to 1)', required: true, min: 0, max: 1 }), A({ name: 'y', type: 'number', label: 'Mood y (0 to 1)', required: true, min: 0, max: 1 }), A({ name: 'area', type: 'string', label: 'Area (music folder)', maxLength: 120 })],
    run: async (rc, a) => { const r = await ok(rc, 'POST', '/sound/music/mood', { x: a.x, y: a.y, area: a.area }); return { track: r.track?.title ?? null, changed: r.changed }; },
  },
  {
    id: 'sound.ambience', title: 'Start an ambience scene', group: 'Sound', description: 'Start a saved ambience scene by name or id.', roles: ['dm'], args: [A({ name: 'scene', type: 'string', label: 'Scene name or id', required: true, maxLength: 80 })],
    run: async (rc, a) => { const list: any[] = await ok(rc, 'GET', '/sound/scenes'); const s = pick(list, a.scene, (x) => x.name); if (!s) throw new ActionError(`No ambience scene "${a.scene}"`, 404); await ok(rc, 'POST', `/sound/scenes/${encodeURIComponent(s.id)}/play`, {}); return { scene: s.name }; },
  },
  { id: 'sound.stop_all', title: 'Stop all sound', group: 'Sound', description: 'Stop the music and the ambience.', roles: ['dm'], args: [], run: async (rc) => { await ok(rc, 'POST', '/sound/music/stop', {}); await ok(rc, 'POST', '/sound/ambience/stop', {}); return { stopped: ['music', 'ambience'] }; } },
  // ---- stage ----
  {
    id: 'stage.show', title: 'Show a stage card', group: 'Stage', description: 'Show a stage card to the players. Name it by label, id or kind (for example combat).', roles: ['dm'],
    args: [A({ name: 'card', type: 'string', label: 'Card label, id or kind', required: true, maxLength: 120 })],
    run: async (rc, a) => { const c = await stageCard(rc, a.card); await ok(rc, 'POST', `/stage/cards/${encodeURIComponent(c.id)}/show`, {}); return { card: c.label || c.kind }; },
  },
  {
    id: 'stage.hide', title: 'Hide a stage card', group: 'Stage', description: 'Take a stage card away from the players.', roles: ['dm'],
    args: [A({ name: 'card', type: 'string', label: 'Card label, id or kind', required: true, maxLength: 120 })],
    run: async (rc, a) => { const c = await stageCard(rc, a.card); await ok(rc, 'POST', `/stage/cards/${encodeURIComponent(c.id)}/hide`, {}); return { card: c.label || c.kind }; },
  },
  // ---- recording ----
  { id: 'recording.start', title: 'Start recording', group: 'Recording', description: 'Start a recording session.', roles: ['dm'], args: [A({ name: 'name', type: 'string', label: 'Session name', maxLength: 80 })], run: async (rc, a) => { const s = await ok(rc, 'POST', '/audio/sessions', { name: a.name }); return { session: s.name }; } },
  { id: 'recording.stop', title: 'Stop recording', group: 'Recording', description: 'Stop the running recording session.', roles: ['dm'], args: [], run: async (rc) => { const s = await activeSession(rc); if (!s) throw new ActionError('Nothing is being recorded'); await ok(rc, 'POST', `/audio/sessions/${encodeURIComponent(s.id)}/stop`, {}); return { session: s.name }; } },
  {
    id: 'recording.aside', title: 'Aside on or off', group: 'Recording', description: 'Mark your microphones as an aside (kept out of the players\' transcript) or back to normal.', roles: ['dm'], args: [A({ name: 'on', type: 'bool', label: 'Aside on', required: true })],
    run: async (rc, a) => {
      const mics: any[] = (await ok(rc, 'GET', '/audio/mics')).filter((m: any) => m.accountId === rc.accountId);
      if (!mics.length) throw new ActionError('You have no microphone registered');
      for (const m of mics) await ok(rc, 'POST', '/audio/mics', { deviceId: m.deviceId, label: m.label, mode: m.mode, playersTranscript: m.playersTranscript, aside: a.on, room: m.room });
      return { aside: a.on, mics: mics.length };
    },
  },
  {
    id: 'recording.aside_hold', title: 'Aside (hold)', group: 'Recording', description: 'For a key held down: phase start when it goes down, end when it comes up. The stretch in between is marked as an aside.', roles: ['dm'], args: [A({ name: 'phase', type: 'enum', values: ['start', 'end'], required: true })],
    run: async (rc, a) => {
      const s = await activeSession(rc);
      if (!s) throw new ActionError('Nothing is being recorded');
      let m = holds.get(rc.d);
      if (!m) { m = new Map(); holds.set(rc.d, m); }
      const key = `${rc.worldId}:${rc.accountId}`;
      const at = Math.max(0, Date.now() - Date.parse(s.startedAt));
      if (a.phase === 'start') { m.set(key, { sessionId: s.id, startMs: at }); return { phase: 'start' }; }
      const h = m.get(key);
      if (!h || h.sessionId !== s.id) throw new ActionError('No aside was started');
      m.delete(key);
      await ok(rc, 'POST', `/audio/sessions/${encodeURIComponent(s.id)}/holds`, { kind: 'aside', start: h.startMs, end: Math.max(h.startMs, at) });
      return { phase: 'end', ms: at - h.startMs };
    },
  },
  // ---- quick event ----
  {
    id: 'event.send', title: 'Send a quick event', group: 'Table', description: 'Send a quick event to the players: a ready template (ambush, noise, vote, trap), with your own title or text if you like.', roles: ['dm'],
    args: [A({ name: 'template', type: 'enum', values: Object.keys(QUICK_TEMPLATES), required: true }), A({ name: 'title', type: 'string', maxLength: 120 }), A({ name: 'prompt', type: 'string', maxLength: 2000 }), A({ name: 'dc', type: 'int', min: 1, max: 40 })],
    run: async (rc, a) => { const t = QUICK_TEMPLATES[a.template]; const e = await ok(rc, 'POST', '/quick-events', { ...t, title: a.title || t.title, prompt: a.prompt || t.prompt, dc: a.dc ?? t.dc }); return { id: e.id, title: e.title }; },
  },
  // ---- voice ----
  {
    id: 'voice.speak', title: 'Speak with a voice', group: 'Table', description: 'Read a line aloud with a voice preset.', roles: ['dm'],
    args: [A({ name: 'preset', type: 'string', label: 'Voice preset name or id', required: true, maxLength: 80 }), A({ name: 'text', type: 'string', required: true, maxLength: 2000 })],
    run: async (rc, a) => { const list: any[] = await ok(rc, 'GET', '/voice/presets'); const p = pick(list, a.preset, (x) => x.name); if (!p) throw new ActionError(`No voice preset "${a.preset}"`, 404); await ok(rc, 'POST', '/voice/speak', { presetId: p.id, text: a.text }); return { preset: p.name }; },
  },
  // ---- dice (players too) ----
  {
    id: 'dice.roll', title: 'Roll dice', group: 'Table', description: 'Roll dice such as 2d6+3 or d20.', roles: ['dm', 'player'], args: [A({ name: 'notation', type: 'string', label: 'Dice', default: 'd20', maxLength: 40 })],
    run: async (_rc, a) => { const r = rollDice(a.notation); if (!r) throw new ActionError(`"${a.notation}" is not dice notation (try 2d6+3)`); return { notation: r.notation, total: r.total, text: r.text }; },
  },
  // ---- quick gen ----
  {
    id: 'gen.gold', title: 'Gold to the party', group: 'Table', description: 'Roll treasure coins and put them in the party pouch.', roles: ['dm'],
    args: [A({ name: 'mode', type: 'enum', values: ['individual', 'hoard'], default: 'individual' }), A({ name: 'level', type: 'int', label: 'Party level', default: 3, min: 1, max: 20 })],
    run: async (rc, a) => {
      const c = await ok(rc, 'GET', `/quickgen/coins?mode=${a.mode}&level=${a.level}`);
      const cp = Number(c.totalCp);
      if (!(cp > 0)) throw new ActionError('That roll came to no coin');
      await ok(rc, 'POST', '/live/ledger', { owner: 'party', amountCp: cp, note: `Treasure: ${c.text ?? 'coins'}`.slice(0, 200) });
      return { text: c.text ?? null, totalCp: cp };
    },
  },
  // ---- lights ----
  {
    id: 'lights.scene', title: 'Run a light scene', group: 'Lights', description: 'Set the lights to a saved scene.', roles: ['dm'], args: [A({ name: 'scene', type: 'string', label: 'Scene name or id', required: true, maxLength: 80 })],
    run: async (rc, a) => {
      try { const r = runScene(rc.d, rc.worldId, a.scene); return { scene: r.scene.name, queued: r.queued }; }
      catch (e) { if (e instanceof HttpError) throw new ActionError(e.message, e.status); throw e; }
    },
  },
];

async function stageCard(rc: Runner, ref: string) {
  const s = await ok(rc, 'GET', '/stage');
  const list: any[] = s.cards ?? [];
  const c = pick(list, ref, (x) => x.label) ?? list.find((x) => norm(x.kind) === norm(ref));
  if (!c) throw new ActionError(`No stage card "${ref}"`, 404);
  return c;
}

export const actionById = (id: string) => ACTIONS.find((x) => x.id === id);

export const canRun = (a: ActionDef, role: string) => (role === 'dm' || role === 'player') && a.roles.includes(role);

export const actionView = (a: ActionDef) => ({ id: a.id, title: a.title, group: a.group, description: a.description, roles: a.roles, args: a.args });

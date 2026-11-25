// An encounter's script: what the NPC says at each step, the player's
// options, what an option gives (a little gold, a simple item, a shop), and
// the small games an NPC can offer. Pure code: parsing, checking and the
// built-in starter encounters. index.ts runs them.
import { randomInt } from 'node:crypto';
import { HttpError } from '../../core/util.ts';

export type Effect =
  | { kind: 'gold'; cp: number }
  | { kind: 'item'; name: string; qty: number }
  /** shopId '' means "the shop picked when the encounter is sent", else any open shop. */
  | { kind: 'shop'; shopId: string };

export interface Option { label: string; next: string | null; effects: Effect[] }

export const GAMES = ['coin', 'shells', 'dice', 'check'] as const;
export type GameKind = (typeof GAMES)[number];
export const GAME_LABEL: Record<GameKind, string> = { coin: 'Coin toss', shells: 'Shell game', dice: 'Dice duel', check: 'Skill check' };

export interface Game {
  kind: GameKind;
  /** Coin the player puts up; lost on a loss. 0 for none. */
  stakeCp: number;
  /** Coin paid on a win (on top of getting the stake back). */
  winCp: number;
  /** check only. */
  dc: number | null;
  skill: string | null;
  /** Where the story goes after a win or a loss. */
  win: string;
  lose: string;
}

export interface Node { id: string; text: string; options: Option[]; game: Game | null }
export interface Script { start: string; nodes: Node[] }

export const LIMITS = { nodes: 40, options: 6, effects: 3, text: 1000, label: 120, cp: 100_000, qty: 20, steps: 60 };
const NODE_ID = /^[\w-]{1,40}$/;

const bad = (msg: string) => new HttpError(400, msg);
const text = (v: unknown, field: string, max: number, optional = false): string => {
  if (v === undefined || v === null || v === '') { if (optional) return ''; throw bad(`${field} is required`); }
  if (typeof v !== 'string') throw bad(`${field} must be text`);
  const s = v.trim();
  if (!s && !optional) throw bad(`${field} is required`);
  if (s.length > max) throw bad(`${field} is longer than ${max} characters`);
  return s;
};
const whole = (v: unknown, field: string, min: number, max: number, dflt: number): number => {
  if (v === undefined || v === null || v === '') return dflt;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw bad(`${field} must be a whole number from ${min} to ${max}`);
  return n;
};

function parseEffect(v: any, at: string): Effect {
  if (!v || typeof v !== 'object') throw bad(`${at} must be an object`);
  switch (v.kind) {
    case 'gold': return { kind: 'gold', cp: whole(v.cp, `${at}.cp`, 1, LIMITS.cp, 0) || (() => { throw bad(`${at}.cp is required`); })() };
    case 'item': return { kind: 'item', name: text(v.name, `${at}.name`, LIMITS.label), qty: whole(v.qty, `${at}.qty`, 1, LIMITS.qty, 1) };
    case 'shop': return { kind: 'shop', shopId: text(v.shopId, `${at}.shopId`, 60, true) };
    default: throw bad(`${at}.kind must be gold, item or shop`);
  }
}

/** Check and normalise a script from a request or the database. Throws 400 on anything wrong. */
export function parseScript(v: any): Script {
  if (!v || typeof v !== 'object' || !Array.isArray(v.nodes)) throw bad('script needs a list of nodes');
  if (!v.nodes.length) throw bad('script needs at least one node');
  if (v.nodes.length > LIMITS.nodes) throw bad(`script can have at most ${LIMITS.nodes} nodes`);
  const nodes: Node[] = v.nodes.map((n: any, i: number) => {
    const at = `nodes[${i}]`;
    if (!n || typeof n !== 'object') throw bad(`${at} must be an object`);
    const id = text(n.id, `${at}.id`, 40);
    if (!NODE_ID.test(id)) throw bad(`${at}.id may only use letters, digits, _ and -`);
    const opts = n.options === undefined ? [] : n.options;
    if (!Array.isArray(opts)) throw bad(`${at}.options must be a list`);
    if (opts.length > LIMITS.options) throw bad(`${at} can have at most ${LIMITS.options} options`);
    const options: Option[] = opts.map((o: any, j: number) => {
      const oat = `${at}.options[${j}]`;
      if (!o || typeof o !== 'object') throw bad(`${oat} must be an object`);
      const effects = o.effects === undefined ? [] : o.effects;
      if (!Array.isArray(effects) || effects.length > LIMITS.effects) throw bad(`${oat}.effects must be a list of at most ${LIMITS.effects}`);
      return { label: text(o.label, `${oat}.label`, LIMITS.label), next: o.next ? text(o.next, `${oat}.next`, 40) : null, effects: effects.map((e: any, k: number) => parseEffect(e, `${oat}.effects[${k}]`)) };
    });
    let game: Game | null = null;
    if (n.game) {
      const g = n.game;
      const gat = `${at}.game`;
      if (!(GAMES as readonly string[]).includes(g.kind)) throw bad(`${gat}.kind must be one of: ${GAMES.join(', ')}`);
      game = {
        kind: g.kind, stakeCp: whole(g.stakeCp, `${gat}.stakeCp`, 0, LIMITS.cp, 0), winCp: whole(g.winCp, `${gat}.winCp`, 0, LIMITS.cp, 0),
        dc: g.kind === 'check' ? whole(g.dc, `${gat}.dc`, 1, 40, 12) : null,
        skill: g.kind === 'check' ? text(g.skill, `${gat}.skill`, 40, true) || null : null,
        win: text(g.win, `${gat}.win`, 40), lose: text(g.lose, `${gat}.lose`, 40),
      };
    }
    return { id, text: text(n.text, `${at}.text`, LIMITS.text), options, game };
  });
  const ids = new Set<string>();
  for (const n of nodes) { if (ids.has(n.id)) throw bad(`Two nodes are called ${n.id}`); ids.add(n.id); }
  const need = (to: string | null, at: string) => { if (to && !ids.has(to)) throw bad(`${at} goes to ${to}, which is not a node`); };
  for (const n of nodes) {
    n.options.forEach((o, j) => need(o.next, `${n.id} option ${j + 1}`));
    if (n.game) { need(n.game.win, `${n.id} win`); need(n.game.lose, `${n.id} lose`); }
  }
  const start = v.start ? text(v.start, 'start', 40) : nodes[0].id;
  if (!ids.has(start)) throw bad(`start ${start} is not a node`);
  return { start, nodes };
}

/** One NPC line with plain end-the-talk answers: what the DM sends by hand. */
export const quickScript = (line: string, answers: string[]): Script => parseScript({
  nodes: [{ id: 'start', text: line, options: answers.map((label) => ({ label, next: null })) }],
});

// ---------------- the games ----------------

export interface GameResult { won: boolean; text: string; roll?: number; total?: number }

const FACES = ['heads', 'tails'];
const SHELLS = ['left', 'middle', 'right'];
const d = (n: number) => randomInt(1, n + 1);

/**
 * Play a game on the server, so the odds are the odds whatever the phone
 * says. pick: coin 0/1, shells 0/1/2. check: roll (1-20, from real dice) and
 * modifier; the app rolls when roll is missing. Dice ties go to the NPC.
 */
export function play(g: Game, input: { pick?: unknown; roll?: unknown; modifier?: unknown }, rnd: (n: number) => number = d): GameResult {
  switch (g.kind) {
    case 'coin': {
      const pick = whole(input.pick, 'pick', 0, 1, -1);
      if (pick < 0) throw bad('Call heads (0) or tails (1)');
      const side = rnd(2) - 1;
      return { won: side === pick, text: `You call ${FACES[pick]}. The coin lands ${FACES[side]}.` };
    }
    case 'shells': {
      const pick = whole(input.pick, 'pick', 0, 2, -1);
      if (pick < 0) throw bad('Pick a shell: 0, 1 or 2');
      const pea = rnd(3) - 1;
      return { won: pea === pick, text: `You point at the ${SHELLS[pick]} shell. The pea is under the ${SHELLS[pea]} one.` };
    }
    case 'dice': {
      const a = [rnd(6), rnd(6)], b = [rnd(6), rnd(6)];
      const you = a[0] + a[1], them = b[0] + b[1];
      return { won: you > them, text: `You roll ${a[0]} + ${a[1]} = ${you}. They roll ${b[0]} + ${b[1]} = ${them}.${you === them ? ' Ties go to the house.' : ''}` };
    }
    case 'check': {
      const roll = whole(input.roll, 'roll', 1, 20, 0) || rnd(20);
      const mod = whole(input.modifier, 'modifier', -10, 30, 0);
      const total = roll + mod;
      return { won: total >= (g.dc ?? 10), roll, total, text: `You roll ${roll}${mod ? ` ${mod > 0 ? '+' : '-'} ${Math.abs(mod)} = ${total}` : ''}${g.skill ? ` (${g.skill})` : ''}.` };
    }
  }
}

// ---------------- built-in starters ----------------

export interface Starter { id: string; name: string; npcName: string; npcBlurb: string; script: Script }

/** Ready to send in any world. ids start with "builtin:" and cannot be edited (copy one to change it). */
export const STARTERS: Starter[] = [
  {
    id: 'builtin:coin', name: 'Street gambler: coin toss', npcName: 'Pip the Flipper', npcBlurb: 'A grinning halfling spinning a silver piece across their knuckles.',
    script: parseScript({ start: 'hi', nodes: [
      { id: 'hi', text: '"Fancy a flip, friend? One silver says you can\'t call it."', options: [{ label: 'Sure, I\'ll play', next: 'toss' }, { label: 'Not today', next: null }] },
      { id: 'toss', text: 'Pip flicks the coin high. "Call it!"', game: { kind: 'coin', stakeCp: 10, winCp: 10, win: 'won', lose: 'lost' } },
      { id: 'won', text: '"Ha! Lucky you." Pip pays up with a wink.', options: [{ label: 'Again!', next: 'toss' }, { label: 'I\'ll quit while I\'m ahead', next: null }] },
      { id: 'lost', text: '"The coin loves me today." Pip pockets your silver.', options: [{ label: 'Double or nothing… well, again', next: 'toss' }, { label: 'Walk away', next: null }] },
    ] }),
  },
  {
    id: 'builtin:shells', name: 'Shell game hustler', npcName: 'Madame Vell', npcBlurb: 'Three walnut shells, a dried pea and very quick hands on an upturned crate.',
    script: parseScript({ start: 'hi', nodes: [
      { id: 'hi', text: '"Find the pea, win the purse! Two silver to play, five back if your eyes are sharp."', options: [{ label: 'Play', next: 'shells' }, { label: 'Keep walking', next: null }] },
      { id: 'shells', text: 'The shells blur across the crate, then stop. "Where is it?"', game: { kind: 'shells', stakeCp: 20, winCp: 30, win: 'won', lose: 'lost' } },
      { id: 'won', text: 'Vell blinks, then laughs and counts out your coin. "Sharp eyes indeed."', options: [{ label: 'One more round', next: 'shells' }, { label: 'Thanks, goodbye', next: null }] },
      { id: 'lost', text: '"So close!" The pea was never where you looked.', options: [{ label: 'Try again', next: 'shells' }, { label: 'Leave', next: null }] },
    ] }),
  },
  {
    id: 'builtin:armwrestle', name: 'Dockhand arm-wrestling', npcName: 'Big Hollis', npcBlurb: 'A dockworker with forearms like mooring posts, elbow already on the barrel.',
    script: parseScript({ start: 'hi', nodes: [
      { id: 'hi', text: '"Beat me and the next round\'s on me. Plus a silver for your trouble."', options: [{ label: 'Grip hands', next: 'wrestle' }, { label: 'Maybe later', next: null }] },
      { id: 'wrestle', text: 'Hollis grins and leans in. The crowd starts to cheer.', game: { kind: 'check', skill: 'Athletics', dc: 13, stakeCp: 0, winCp: 10, win: 'won', lose: 'lost' } },
      { id: 'won', text: 'Your arm slams his down. Hollis roars with laughter and pays up.', options: [{ label: 'Take the coin and a mug', next: null, effects: [{ kind: 'item', name: 'Mug of dockside ale', qty: 1 }] }] },
      { id: 'lost', text: 'Hollis pins you with a thump. "Good effort! Come back when you\'ve eaten."', options: [{ label: 'Rub your arm and leave', next: null }] },
    ] }),
  },
  {
    id: 'builtin:dice', name: 'Tavern dice duel', npcName: 'Old Teodor', npcBlurb: 'A one-eyed veteran rattling two bone dice in a leather cup.',
    script: parseScript({ start: 'hi', nodes: [
      { id: 'hi', text: '"High roll takes it. A silver a throw, if you\'ve the nerve."', options: [{ label: 'Roll the bones', next: 'duel' }, { label: 'No thanks', next: null }] },
      { id: 'duel', text: 'Teodor slides you the cup.', game: { kind: 'dice', stakeCp: 10, winCp: 10, win: 'won', lose: 'lost' } },
      { id: 'won', text: '"Bah. Fair\'s fair." He flicks a coin your way.', options: [{ label: 'Another', next: 'duel' }, { label: 'Done for now', next: null }] },
      { id: 'lost', text: '"The bones remember me." He scoops up the silver.', options: [{ label: 'Another', next: 'duel' }, { label: 'Done for now', next: null }] },
    ] }),
  },
  {
    id: 'builtin:lostchild', name: 'Lost child', npcName: 'Mira', npcBlurb: 'A small child clutching a wooden horse, eyes red from crying.',
    script: parseScript({ start: 'hi', nodes: [
      { id: 'hi', text: '"I can\'t find my mum. She sells bread by the fountain…"', options: [{ label: 'Walk her to the fountain', next: 'found' }, { label: 'Point the way and move on', next: null }] },
      { id: 'found', text: 'Her mother sweeps her up, weeping with relief, and presses something into your hands.', options: [{ label: 'Accept the gift', next: null, effects: [{ kind: 'item', name: 'Fresh honey loaf', qty: 1 }, { kind: 'gold', cp: 5 }] }, { label: 'Politely refuse', next: null }] },
    ] }),
  },
  {
    id: 'builtin:peddler', name: 'Travelling peddler', npcName: 'Quill', npcBlurb: 'A gnome under an enormous pack hung with pots, charms and bottles.',
    script: parseScript({ start: 'hi', nodes: [
      { id: 'hi', text: '"Wares! Wondrous wares! Have a look, no charge for looking."', options: [{ label: 'Show me what you have', next: null, effects: [{ kind: 'shop', shopId: '' }] }, { label: 'Any news?', next: 'news' }, { label: 'Not interested', next: null }] },
      { id: 'news', text: '"News costs nothing but I\'ll tell you anyway: the roads north are getting worse." Quill taps their nose.', options: [{ label: 'Let me see the wares, then', next: null, effects: [{ kind: 'shop', shopId: '' }] }, { label: 'Thanks', next: null }] },
    ] }),
  },
];

export const starter = (id: string) => STARTERS.find((s) => s.id === id) ?? null;

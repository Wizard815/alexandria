// The information broker: an in-world NPC who sells what the party could
// learn, at prices and waits the DM sets. Everything is decided on the
// server: the tier comes from the best-matching shared pages in the player's
// own library (the party index only), the player never sends a price, coin
// comes off atomically, and the answer is built only from that player's
// player copies. It is held back until the wait is over (real time, or the
// world's game clock). Questions the library can't answer go to the DM to
// price or refuse.
import { Router, type Response } from 'express';
import { randomBytes } from 'node:crypto';
import type { Deps } from '../app.ts';
import { audit } from '../app.ts';
import { type DB, one, all, run, tx } from '../core/db.ts';
import { requireDM, requirePlayerOrDM } from '../core/auth.ts';
import { dmAnd } from '../core/events.ts';
import { HttpError, id, int, now, oneOf, str } from '../core/util.ts';
import { DEFAULT_SETTINGS, type Viewer } from '../core/policy.ts';
import { ctx, isDM, me, names, settings } from './_shared.ts';

type Clock = 'real' | 'game';
type Unit = 'minutes' | 'hours' | 'days';
interface Tier { id: string; name: string; description: string; knowledge: string; costCp: number | null; wait: { amount: number; unit: Unit; clock: Clock } | null }
interface Config {
  persona: { name: string; title: string; description: string; greeting: string; voice: string; portrait: string };
  tiers: Tier[];
  lengths: { id: string; name: string; multiplier: number }[];
}

export const DEFAULT_BROKER: Config = {
  persona: {
    name: 'The Broker', title: 'Dealer in rumors and records', description: 'Knows a little about everything, for a price.',
    greeting: 'Information has a price, friend. What do you want to know?', voice: 'leans in and lowers their voice', portrait: '',
  },
  tiers: [
    { id: 'common', name: 'Common knowledge', description: 'What the party saw or was told: sessions, the road, people you met.', knowledge: 'common', costCp: 0, wait: { amount: 0, unit: 'minutes', clock: 'real' } },
    { id: 'local', name: 'Local lore', description: 'Towns, places, rumors and the people who run them.', knowledge: 'local', costCp: 50, wait: { amount: 1, unit: 'hours', clock: 'game' } },
    { id: 'deep', name: 'Deep lore', description: 'The Hearts, the Marked, old history.', knowledge: 'deep', costCp: 200, wait: { amount: 1, unit: 'days', clock: 'game' } },
    { id: 'secret', name: 'Guarded secrets', description: 'Not in your library. The broker asks around; the DM names the price or says no.', knowledge: 'secret', costCp: null, wait: null },
  ],
  lengths: [{ id: 'short', name: 'Short answer', multiplier: 1 }, { id: 'full', name: 'Full answer', multiplier: 2 }],
};

const UNIT_MIN: Record<Unit, number> = { minutes: 1, hours: 60, days: 1440 };
const QUOTE_MS = 2 * 60_000;
const STOP = new Set('the a an and or of to in on at is are was were what who whom where when why how does do did about tell me with from for that this there their they his her its it be been can could would should into than then any some much many more most have has had our your you we i know want need find out anything everything thing things happened happen going around'.split(' '));
const words = (t: string) => String(t).toLowerCase().replace(/[’']/g, '').split(/[^\p{L}\p{N}]+/u).filter((w) => (w.length > 2 || /^\d+$/.test(w)) && !STOP.has(w));

export function clockLabel(m: number) {
  const day = Math.floor(m / 1440) + 1;
  const mm = ((m % 1440) + 1440) % 1440;
  return `Day ${day}, ${String(Math.floor(mm / 60)).padStart(2, '0')}:${String(mm % 60).padStart(2, '0')}`;
}

function loadConfig(db: DB, worldId: string): { cfg: Config; minutes: number } {
  const row = one<any>(db, 'SELECT config, game_minutes FROM broker_config WHERE world_id = ?', worldId);
  if (!row) return { cfg: DEFAULT_BROKER, minutes: 8 * 60 };
  const c = JSON.parse(row.config);
  return { cfg: { ...DEFAULT_BROKER, ...c, persona: { ...DEFAULT_BROKER.persona, ...c.persona } }, minutes: row.game_minutes };
}

function saveConfig(db: DB, worldId: string, cfg: Config | null, minutes: number | null) {
  const cur = loadConfig(db, worldId);
  run(db, `INSERT INTO broker_config (world_id, config, game_minutes) VALUES (?, ?, ?) ON CONFLICT (world_id) DO UPDATE SET config = excluded.config, game_minutes = excluded.game_minutes`,
    worldId, JSON.stringify(cfg ?? cur.cfg), minutes ?? cur.minutes);
}

function validConfig(b: any): Config {
  const p = b?.persona ?? {};
  const persona = {
    name: str(p.name, 'persona.name', { max: 80 }), title: str(p.title, 'persona.title', { max: 120, optional: true }), description: str(p.description, 'persona.description', { max: 600, optional: true }),
    greeting: str(p.greeting, 'persona.greeting', { max: 300, optional: true }), voice: str(p.voice, 'persona.voice', { max: 120, optional: true }) || 'leans in',
    portrait: str(p.portrait, 'persona.portrait', { max: 500, optional: true }),
  };
  if (persona.portrait && !/^https?:\/\//.test(persona.portrait)) throw new HttpError(400, 'Portrait must be an http(s) URL');
  if (!Array.isArray(b?.tiers) || !b.tiers.length || b.tiers.length > 12) throw new HttpError(400, 'Give 1 to 12 tiers');
  const tiers: Tier[] = b.tiers.map((t: any, i: number) => {
    const knowledge = oneOf(t.knowledge, `tiers[${i}].knowledge`, ['common', 'local', 'deep', 'secret'] as const);
    const cost = t.costCp === null || t.costCp === undefined ? null : int(t.costCp, `tiers[${i}].costCp`, { min: 0, max: 100_000_000 });
    const wait = t.wait ? { amount: int(t.wait.amount, `tiers[${i}].wait.amount`, { min: 0, max: 100_000 })!, unit: oneOf(t.wait.unit, `tiers[${i}].wait.unit`, ['minutes', 'hours', 'days'] as const), clock: oneOf(t.wait.clock, `tiers[${i}].wait.clock`, ['real', 'game'] as const) } : null;
    if (knowledge !== 'secret' && (cost === null || !wait)) throw new HttpError(400, `${t.name || 'Tier'}: set a cost and a wait`);
    return { id: str(t.id, `tiers[${i}].id`, { max: 30 }).replace(/[^\w-]/g, '') || knowledge, name: str(t.name, `tiers[${i}].name`, { max: 60 }), description: str(t.description, `tiers[${i}].description`, { max: 300, optional: true }), knowledge, costCp: cost, wait };
  });
  for (const k of ['common', 'local', 'deep', 'secret']) if (!tiers.some((t) => t.knowledge === k)) throw new HttpError(400, `Keep a tier for ${k} knowledge`);
  const lengths = Array.isArray(b?.lengths) && b.lengths.length ? b.lengths.slice(0, 4).map((l: any, i: number) => ({ id: str(l.id, `lengths[${i}].id`, { max: 20 }).replace(/[^\w-]/g, ''), name: str(l.name, `lengths[${i}].name`, { max: 40 }), multiplier: Math.max(0, Math.min(20, Number(l.multiplier) || 1)) })) : DEFAULT_BROKER.lengths;
  return { persona, tiers, lengths };
}

const money = (cp: number) => {
  if (!cp) return 'nothing';
  const gp = Math.floor(cp / 100), sp = Math.floor((cp % 100) / 10), c = cp % 10;
  return [gp && `${gp} gp`, sp && `${sp} sp`, c && `${c} cp`].filter(Boolean).join(' ');
};
const waitText = (w: Tier['wait']) => (!w || !w.amount ? 'right now' : `${w.amount} ${w.amount === 1 ? w.unit.replace(/s$/, '') : w.unit}${w.clock === 'game' ? ' of game time' : ''}`);

/** The player's own library: best-matching lines from shared pages (party copies only). */
function findAnswer(d: Deps, worldId: string, question: string, length: string, viewer: Viewer) {
  const q = [...new Set(words(question))];
  if (!q.length) return null;
  const hits = d.library.search(worldId, q.join(' '), viewer, 8) as any[];
  // FTS needs every term; retry with each term for partial matches.
  const pagesIds = new Set(hits.map((h) => h.id));
  if (pagesIds.size < 3) for (const t of q) for (const h of d.library.search(worldId, t, viewer, 4) as any[]) pagesIds.add(h.id);
  const units: { page: string; title: string; text: string; score: number }[] = [];
  for (const pid of [...pagesIds].slice(0, 12)) {
    let pg: any;
    try { pg = d.library.get(worldId, pid, viewer); } catch { continue; } // only shared pages
    const titleWords = words(pg.title);
    for (const raw of String(pg.body ?? '').split(/\n+/)) {
      const text = raw.replace(/^[#>\-*\s|]+/, '').replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2').replace(/\[\[([^\]]+)\]\]/g, '$1').replace(/[*_`]/g, '').trim();
      if (text.length < 20) continue;
      const w = words(text);
      const hit = q.filter((x) => w.some((y) => y.startsWith(x) || x.startsWith(y)) || titleWords.includes(x));
      if (hit.length) units.push({ page: pg.id, title: pg.title, text, score: hit.length + Math.min(text.length, 200) / 400 });
    }
  }
  units.sort((a, b) => b.score - a.score);
  if (!units.length || units[0].score < Math.max(1, Math.ceil(q.length * 0.5))) return null;
  const take = units.slice(0, length === 'full' ? 5 : 2);
  const sources = [...new Map(take.map((u) => [u.page, { id: u.page, title: u.title }])).values()];
  const knowledge = sources.map((s) => one<any>(d.db, 'SELECT knowledge FROM pages WHERE id = ?', s.id)?.knowledge).filter(Boolean);
  const rank = { common: 0, local: 1, deep: 2 } as Record<string, number>;
  const level = knowledge.length ? knowledge.sort((a, b) => rank[b] - rank[a])[0] : 'local';
  return { answer: take.map((u) => u.text).join('\n\n'), sources, knowledge: level as string };
}

const quotes = new Map<string, any>();

export default function brokerRoutes(d: Deps) {
  const r = Router({ mergeParams: true });
  const { db } = d;

  const on = (res: Response) => {
    if (!settings(res).brokerEnabled) throw new HttpError(404, 'The information broker is closed in this world');
  };
  const emit = (worldId: string, req: any) => d.hub.emit(worldId, 'broker', { id: req.id, status: req.status }, dmAnd(req.account_id));

  /** Waits that are over become answers. */
  function settle(worldId: string) {
    const { minutes } = loadConfig(db, worldId);
    const due = all<any>(db, `SELECT * FROM broker_requests WHERE world_id = ? AND status = 'waiting' AND ((wait_clock = 'real' AND ready_at <= ?) OR (wait_clock = 'game' AND ready_at_game <= ?))`, worldId, now(), minutes);
    for (const q of due) {
      run(db, `UPDATE broker_requests SET status = 'answered', delivered_at = ? WHERE id = ?`, now(), q.id);
      emit(worldId, { ...q, status: 'answered' });
    }
  }
  const timer = setInterval(() => { for (const w of all<any>(db, `SELECT DISTINCT world_id FROM broker_requests WHERE status = 'waiting'`)) settle(w.world_id); }, 15_000);
  timer.unref();

  const view = (res: Response, q: any, nm: Record<string, string>) => {
    const { cfg, minutes } = loadConfig(db, q.world_id);
    const dm = isDM(res);
    const tier = cfg.tiers.find((t) => t.id === q.tier);
    const out: any = {
      id: q.id, question: q.question, length: q.length, tier: q.tier, tier_name: tier?.name ?? q.tier, cost_cp: q.status === 'pricing' || (q.status === 'declined' && !q.ledger_id && q.answer === null) ? null : q.cost_cp, payer: q.payer, status: q.status,
      wait_clock: q.wait_clock, ready_at: q.ready_at, ready_at_game: q.ready_at_game, ready_at_game_label: q.ready_at_game !== null && q.ready_at_game !== undefined ? clockLabel(q.ready_at_game) : null,
      game_now: minutes, created_at: q.created_at, delivered_at: q.delivered_at, reply: q.dm_note,
    };
    if (q.status === 'answered' || dm) { out.answer = q.answer; out.sources = JSON.parse(q.sources || '[]'); }
    if (q.status === 'answered') out.voice = `${cfg.persona.name} ${cfg.persona.voice}`;
    if (dm) { out.asker = q.account_id; out.asker_name = nm[q.account_id] ?? 'Someone'; }
    return out;
  };

  r.get('/config', (_req, res) => {
    on(res);
    const { cfg, minutes } = loadConfig(db, ctx(res).world.id);
    res.json({ ...cfg, payer: settings(res).brokerPayer, clock: { minutes, label: clockLabel(minutes) } });
  });
  r.put('/config', requireDM, (req, res) => {
    const c = validConfig(req.body);
    saveConfig(db, ctx(res).world.id, c, null);
    audit(db, ctx(res).world.id, me(res), 'broker.config', `${c.tiers.length} tiers`);
    d.hub.emit(ctx(res).world.id, 'broker-config', {}, () => true);
    res.json(c);
  });
  r.post('/clock', requireDM, (req, res) => {
    const w = ctx(res).world.id;
    const { minutes } = loadConfig(db, w);
    const next = req.body?.setMinutes !== undefined ? int(req.body.setMinutes, 'setMinutes', { min: 0, max: 1_000_000_000 })! : minutes + int(req.body?.addMinutes, 'addMinutes', { min: -1_000_000, max: 1_000_000 })!;
    saveConfig(db, w, null, Math.max(0, next));
    settle(w);
    d.hub.emit(w, 'broker-clock', { minutes: Math.max(0, next), label: clockLabel(Math.max(0, next)) }, () => true);
    res.json({ minutes: Math.max(0, next), label: clockLabel(Math.max(0, next)) });
  });

  // A quote. GET works with read-only keys (MCP); it never charges.
  function quote(res: Response, question: string, length: string) {
    on(res);
    const w = ctx(res).world.id;
    const { cfg } = loadConfig(db, w);
    const len = cfg.lengths.find((l) => l.id === length) ?? cfg.lengths[0];
    // Always a player's view: the DM asking gets what a player would get.
    const viewer: Viewer = isDM(res) ? { accountId: me(res), role: 'player' } : ctx(res).viewer;
    const found = findAnswer(d, w, question, len.id, viewer);
    const tier = found ? cfg.tiers.find((t) => t.knowledge === found.knowledge) ?? cfg.tiers.find((t) => t.knowledge === 'local')! : cfg.tiers.find((t) => t.knowledge === 'secret')!;
    const secret = !found || tier.knowledge === 'secret' || tier.costCp === null;
    const cost = secret ? null : Math.round(tier.costCp! * len.multiplier);
    const qid = randomBytes(9).toString('base64url');
    quotes.set(qid, { world: w, account: me(res), question, length: len.id, tier: tier.id, cost, wait: secret ? null : tier.wait, found, expires: Date.now() + QUOTE_MS });
    for (const [k, v] of quotes) if (v.expires < Date.now()) quotes.delete(k);
    const p = cfg.persona.name;
    const line = secret
      ? `${p} frowns. "That's not something I know. I'll have to ask around, and that costs whatever it costs."`
      : cost === 0 ? `${p} shrugs. "Everyone knows that. No charge."` : `${p} considers it. "${tier.name}. ${money(cost!)}, and give me ${waitText(tier.wait)}."`;
    return { quoteId: qid, tier: tier.id, tier_name: tier.name, length: len.id, cost_cp: cost, wait: secret ? null : tier.wait, wait_text: secret ? 'the DM decides' : waitText(tier.wait), secret, line, expires_in: QUOTE_MS / 1000 };
  }
  r.get('/quote', requirePlayerOrDM, (req, res) => res.json(quote(res, str(req.query.question, 'question', { max: 500 }), String(req.query.length ?? 'short'))));
  r.post('/quote', requirePlayerOrDM, (req, res) => res.json(quote(res, str(req.body?.question, 'question', { max: 500 }), String(req.body?.length ?? 'short'))));

  function charge(res: Response, asker: string, cost: number, question: string): { payer: string; ledgerId: string | null } {
    const s = settings(res);
    const w = ctx(res).world.id;
    const payer = s.brokerPayer === 'party' && s.partyPurse ? 'party' : asker;
    if (!cost) return { payer, ledgerId: null };
    const bal = one<any>(db, `SELECT COALESCE(SUM(amount_cp), 0) AS cp FROM ledger WHERE world_id = ? AND owner = ? AND status = 'approved'`, w, payer)!.cp;
    if (bal < cost) throw new HttpError(402, `Not enough coin: this costs ${money(cost)} and ${payer === 'party' ? 'the party purse has' : 'you have'} ${money(Math.max(0, bal))}`);
    const lid = id('led_');
    run(db, `INSERT INTO ledger (id, world_id, owner, amount_cp, note, by_id, at, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'approved')`, lid, w, payer, -cost, `Broker: ${question}`.slice(0, 200), asker, now());
    return { payer, ledgerId: lid };
  }
  const readyAt = (w: string, wait: Tier['wait']) => {
    const { minutes } = loadConfig(db, w);
    if (!wait || !wait.amount) return { clock: 'real', at: now(), game: null };
    const mins = wait.amount * UNIT_MIN[wait.unit];
    return wait.clock === 'game' ? { clock: 'game', at: null, game: minutes + mins } : { clock: 'real', at: new Date(Date.now() + mins * 60_000).toISOString(), game: null };
  };

  r.post('/ask', requirePlayerOrDM, (req, res) => {
    on(res);
    const w = ctx(res).world.id;
    const qid = str(req.body?.quoteId, 'quoteId', { max: 40 });
    const q = quotes.get(qid);
    if (!q || q.world !== w || q.account !== me(res)) throw new HttpError(404, 'That quote is not yours or no longer exists');
    if (q.expires < Date.now()) { quotes.delete(qid); throw new HttpError(410, 'The quote ran out. Ask again for a fresh price.'); }
    quotes.delete(qid);
    const rid = id('brk_');
    if (q.cost === null) {
      run(db, `INSERT INTO broker_requests (id, world_id, account_id, question, length, tier, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pricing', ?)`, rid, w, me(res), q.question, q.length, q.tier, now());
    } else {
      tx(db, () => {
        const { payer, ledgerId } = charge(res, me(res), q.cost, q.question);
        const ra = readyAt(w, q.wait);
        run(db, `INSERT INTO broker_requests (id, world_id, account_id, question, length, tier, cost_cp, payer, ledger_id, status, wait_clock, ready_at, ready_at_game, answer, sources, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'waiting', ?, ?, ?, ?, ?, ?)`,
          rid, w, me(res), q.question, q.length, q.tier, q.cost, payer, ledgerId, ra.clock, ra.at, ra.game, q.found.answer, JSON.stringify(q.found.sources), now());
      });
      settle(w);
    }
    const row = one<any>(db, 'SELECT * FROM broker_requests WHERE id = ?', rid);
    audit(db, w, me(res), 'broker.ask', `${q.tier} ${q.cost ?? 'priced by DM'}`);
    emit(w, row);
    res.status(201).json(view(res, row, names(db, w)));
  });

  r.get('/', (_req, res) => {
    on(res);
    const w = ctx(res).world.id;
    settle(w);
    const rows = isDM(res)
      ? all<any>(db, 'SELECT * FROM broker_requests WHERE world_id = ? ORDER BY created_at DESC LIMIT 200', w)
      : all<any>(db, 'SELECT * FROM broker_requests WHERE world_id = ? AND account_id = ? ORDER BY created_at DESC LIMIT 100', w, me(res));
    const nm = names(db, w);
    const { minutes } = loadConfig(db, w);
    res.json({ requests: rows.map((q) => view(res, q, nm)), clock: { minutes, label: clockLabel(minutes) } });
  });

  const reqFor = (res: Response, rid: string) => {
    const q = one<any>(db, 'SELECT * FROM broker_requests WHERE id = ? AND world_id = ?', rid, ctx(res).world.id);
    if (!q || (!isDM(res) && q.account_id !== me(res))) throw new HttpError(404, 'Request not found');
    return q;
  };
  const back = (res: Response, rid: string, w: string) => {
    const row = one<any>(db, 'SELECT * FROM broker_requests WHERE id = ?', rid);
    emit(w, row);
    res.json(view(res, row, names(db, w)));
  };

  // DM prices a guarded secret (and writes the answer); the player then accepts or declines.
  r.post('/:id/price', requireDM, (req, res) => {
    const w = ctx(res).world.id;
    const q = reqFor(res, String(req.params.id));
    if (q.status !== 'pricing') throw new HttpError(409, 'This request is not waiting for a price');
    const cost = int(req.body?.costCp, 'costCp', { min: 0, max: 100_000_000 })!;
    const wait = { amount: int(req.body?.waitAmount, 'waitAmount', { min: 0, max: 100_000, optional: true }) ?? 0, unit: oneOf(req.body?.waitUnit, 'waitUnit', ['minutes', 'hours', 'days'] as const, 'hours'), clock: oneOf(req.body?.clock, 'clock', ['real', 'game'] as const, 'game') };
    const answer = str(req.body?.answer, 'answer', { max: 10_000 });
    run(db, `UPDATE broker_requests SET status = 'offered', cost_cp = ?, wait_clock = ?, ready_at = ?, answer = ?, dm_note = ? WHERE id = ?`,
      cost, wait.clock, JSON.stringify(wait), answer, str(req.body?.note, 'note', { max: 300, optional: true }) || null, q.id);
    audit(db, w, me(res), 'broker.price', `${q.id} ${cost}`);
    back(res, q.id, w);
  });
  r.post('/:id/accept', requirePlayerOrDM, (req, res) => {
    const w = ctx(res).world.id;
    const q = reqFor(res, String(req.params.id));
    if (q.account_id !== me(res) || q.status !== 'offered') throw new HttpError(409, 'There is no offer to accept');
    const wait = JSON.parse(q.ready_at || '{}');
    tx(db, () => {
      const { payer, ledgerId } = charge(res, me(res), q.cost_cp, q.question);
      const ra = readyAt(w, wait.amount !== undefined ? wait : null);
      run(db, `UPDATE broker_requests SET status = 'waiting', payer = ?, ledger_id = ?, wait_clock = ?, ready_at = ?, ready_at_game = ? WHERE id = ?`, payer, ledgerId, ra.clock, ra.at, ra.game, q.id);
    });
    settle(w);
    back(res, q.id, w);
  });
  r.post('/:id/decline', requirePlayerOrDM, (req, res) => {
    const q = reqFor(res, String(req.params.id));
    if (q.account_id !== me(res) || !['offered', 'pricing'].includes(q.status)) throw new HttpError(409, 'Nothing to decline');
    run(db, `UPDATE broker_requests SET status = 'declined' WHERE id = ?`, q.id);
    back(res, q.id, ctx(res).world.id);
  });

  function refund(res: Response, q: any) {
    if (!q.ledger_id || !q.cost_cp) return;
    run(db, `INSERT INTO ledger (id, world_id, owner, amount_cp, note, by_id, at, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'approved')`, id('led_'), q.world_id, q.payer, q.cost_cp, `Broker refund: ${q.question}`.slice(0, 200), me(res), now());
  }
  r.post('/:id/refuse', requireDM, (req, res) => {
    const w = ctx(res).world.id;
    const q = reqFor(res, String(req.params.id));
    if (!['pricing', 'offered', 'waiting'].includes(q.status)) throw new HttpError(409, 'Too late to refuse; refund it instead');
    tx(db, () => {
      refund(res, q);
      run(db, `UPDATE broker_requests SET status = ?, dm_note = ? WHERE id = ?`, q.ledger_id ? 'refunded' : 'refused', str(req.body?.note, 'note', { max: 300, optional: true }) || null, q.id);
    });
    audit(db, w, me(res), 'broker.refuse', q.id);
    back(res, q.id, w);
  });
  r.post('/:id/refund', requireDM, (req, res) => {
    const w = ctx(res).world.id;
    const q = reqFor(res, String(req.params.id));
    if (q.status === 'refunded' || !q.ledger_id) throw new HttpError(409, 'Nothing to refund');
    tx(db, () => {
      refund(res, q);
      run(db, `UPDATE broker_requests SET status = 'refunded', dm_note = COALESCE(?, dm_note) WHERE id = ?`, str(req.body?.note, 'note', { max: 300, optional: true }) || null, q.id);
    });
    audit(db, w, me(res), 'broker.refund', q.id);
    back(res, q.id, w);
  });
  r.post('/:id/deliver', requireDM, (req, res) => {
    const w = ctx(res).world.id;
    const q = reqFor(res, String(req.params.id));
    if (q.status !== 'waiting') throw new HttpError(409, 'Only a waiting answer can be delivered early');
    run(db, `UPDATE broker_requests SET status = 'answered', delivered_at = ? WHERE id = ?`, now(), q.id);
    back(res, q.id, w);
  });
  // DM edits the prepared answer before it is revealed (or after).
  r.patch('/:id', requireDM, (req, res) => {
    const w = ctx(res).world.id;
    const q = reqFor(res, String(req.params.id));
    run(db, 'UPDATE broker_requests SET answer = ?, dm_note = ? WHERE id = ?', req.body?.answer !== undefined ? str(req.body.answer, 'answer', { max: 10_000 }) : q.answer, req.body?.note !== undefined ? str(req.body.note, 'note', { max: 300, optional: true }) || null : q.dm_note, q.id);
    audit(db, w, me(res), 'broker.edit', q.id);
    back(res, q.id, w);
  });

  return r;
}

export const BROKER_DEFAULT_SETTINGS = { brokerEnabled: DEFAULT_SETTINGS.brokerEnabled, brokerPayer: DEFAULT_SETTINGS.brokerPayer };

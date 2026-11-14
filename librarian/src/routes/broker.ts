// The information broker: an in-world NPC who sells what the party could
// learn, at prices and waits the DM sets. Everything is decided on the
// server: the tier comes from the best-matching shared pages in the player's
// own library (the party index only), the player never sends a price, coin
// comes off atomically, and the answer is built only from that player's
// player copies. It is held back until the wait is over (real time, or the
// world clock, features/clock). Questions the library can't answer, or that are
// really about DM secrets (core/brokerClassify.ts), go to the DM to price or
// refuse; to the player both look the same, so asking never reveals that a
// secret exists. The broker never invents text: it sells player-copy lines,
// notes the DM wrote to be sold, or an answer the DM writes.
//
// The DM can also send special offers ("knowledge of X for 50 gp") to one
// player or the party. They wait on the broker page until paid, declined, or
// until the end of the Nth game session (or a real-time deadline).
import { Router, type Response } from 'express';
import { randomBytes } from 'node:crypto';
import type { Deps } from '../app.ts';
import { audit } from '../app.ts';
import { type DB, one, all, run, tx } from '../core/db.ts';
import { requireDM, requirePlayerOrDM } from '../core/auth.ts';
import { dmAnd } from '../core/events.ts';
import { HttpError, id, int, now, oneOf, str } from '../core/util.ts';
import { DEFAULT_SETTINGS, featureSetting, type Viewer } from '../core/policy.ts';
import { classify, questionType, type Classification } from '../core/brokerClassify.ts';
import { addMinutesForWait, advance, formatDate, getCalendar, getClock } from '../features/clock/api.ts';
import { migrateBrokerClock, moveClockTo } from '../features/broker2/clock.ts';
import { leaks } from '../features/broker2/guard.ts';
import { itemAnswer, rulesAnswer, visibleItems, type OtherAnswer } from '../features/broker2/other.ts';
import { LOW_CONFIDENCE, routeQuestion, type Labels } from '../features/broker2/routing.ts';
import { balance, money } from '../core/coin.ts';
import { ctx, isDM, me, memberIds, names, settings } from './_shared.ts';

type Clock = 'real' | 'game';
type Unit = 'minutes' | 'hours' | 'days';
type Delivery = 'auto' | 'review';
interface Tier { id: string; name: string; description: string; knowledge: string; costCp: number | null; wait: { amount: number; unit: Unit; clock: Clock } | null; delivery: Delivery }
interface Config {
  persona: { name: string; title: string; description: string; greeting: string; voice: string; portrait: string };
  tiers: Tier[];
  lengths: { id: string; name: string; multiplier: number }[];
  /** What happens to questions the broker can't answer: the DM prices them, or the broker turns them away. */
  unknown: 'dm' | 'refuse';
}

export const DEFAULT_BROKER: Config = {
  persona: {
    name: 'The Broker', title: 'Dealer in rumors and records', description: 'Knows a little about everything, for a price.',
    greeting: 'Information has a price, friend. What do you want to know?', voice: 'leans in and lowers their voice', portrait: '',
  },
  tiers: [
    { id: 'common', name: 'Common knowledge', description: 'What the party saw or was told: sessions, the road, people you met.', knowledge: 'common', costCp: 0, wait: { amount: 0, unit: 'minutes', clock: 'real' }, delivery: 'auto' },
    { id: 'local', name: 'Local lore', description: 'Towns, places, rumors and the people who run them.', knowledge: 'local', costCp: 50, wait: { amount: 1, unit: 'hours', clock: 'game' }, delivery: 'auto' },
    { id: 'deep', name: 'Deep lore', description: 'The Hearts, the Marked, old history.', knowledge: 'deep', costCp: 200, wait: { amount: 1, unit: 'days', clock: 'game' }, delivery: 'review' },
    { id: 'secret', name: 'Guarded secrets', description: 'Not in your library. The broker asks around; the DM names the price or says no.', knowledge: 'secret', costCp: null, wait: null, delivery: 'review' },
  ],
  lengths: [{ id: 'short', name: 'Short answer', multiplier: 1 }, { id: 'full', name: 'Full answer', multiplier: 2 }],
  unknown: 'dm',
};

/** Guarded secrets are always the DM's, whatever was saved. */
const DELIVERY_DEFAULT: Record<string, Delivery> = { common: 'auto', local: 'auto', deep: 'review', secret: 'review' };
const deliveryOf = (knowledge: string, v: unknown): Delivery => (knowledge === 'secret' ? 'review' : v === 'auto' || v === 'review' ? v : DELIVERY_DEFAULT[knowledge] ?? 'review');

const UNIT_MIN: Record<Unit, number> = { minutes: 1, hours: 60, days: 1440 };
const QUOTE_MS = 2 * 60_000;

function loadConfig(db: DB, worldId: string): { cfg: Config } {
  const row = one<any>(db, 'SELECT config FROM broker_config WHERE world_id = ?', worldId);
  const c = row ? JSON.parse(row.config) : {};
  const cfg: Config = { ...DEFAULT_BROKER, ...c, persona: { ...DEFAULT_BROKER.persona, ...c.persona } };
  cfg.tiers = cfg.tiers.map((t) => ({ ...t, delivery: deliveryOf(t.knowledge, (t as any).delivery) }));
  return { cfg };
}

function saveConfig(db: DB, worldId: string, cfg: Config) {
  run(db, `INSERT INTO broker_config (world_id, config, game_minutes, clock_migrated) VALUES (?, ?, 0, 1) ON CONFLICT (world_id) DO UPDATE SET config = excluded.config`, worldId, JSON.stringify(cfg));
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
    if (t.delivery !== undefined && t.delivery !== 'auto' && t.delivery !== 'review') throw new HttpError(400, `tiers[${i}].delivery must be auto or review`);
    return { id: str(t.id, `tiers[${i}].id`, { max: 30 }).replace(/[^\w-]/g, '') || knowledge, name: str(t.name, `tiers[${i}].name`, { max: 60 }), description: str(t.description, `tiers[${i}].description`, { max: 300, optional: true }), knowledge, costCp: cost, wait, delivery: deliveryOf(knowledge, t.delivery) };
  });
  for (const k of ['common', 'local', 'deep', 'secret']) if (!tiers.some((t) => t.knowledge === k)) throw new HttpError(400, `Keep a tier for ${k} knowledge`);
  const lengths = Array.isArray(b?.lengths) && b.lengths.length ? b.lengths.slice(0, 4).map((l: any, i: number) => ({ id: str(l.id, `lengths[${i}].id`, { max: 20 }).replace(/[^\w-]/g, ''), name: str(l.name, `lengths[${i}].name`, { max: 40 }), multiplier: Math.max(0, Math.min(20, Number(l.multiplier) || 1)) })) : DEFAULT_BROKER.lengths;
  return { persona, tiers, lengths, unknown: b?.unknown === 'refuse' ? 'refuse' : 'dm' };
}

const waitText = (w: Tier['wait']) => (!w || !w.amount ? 'right now' : `${w.amount} ${w.amount === 1 ? w.unit.replace(/s$/, '') : w.unit}${w.clock === 'game' ? ' of game time' : ''}`);

const quotes = new Map<string, any>();

const OFF_TOPIC_LINE = (p: string) => `${p} waves a hand. "That's not something I deal in."`;
const NO_LEAK_LINE = 'The broker has nothing to say about that.';

export default function brokerRoutes(d: Deps) {
  const r = Router({ mergeParams: true });
  const { db } = d;

  const on = (res: Response) => {
    if (!settings(res).brokerEnabled) throw new HttpError(404, 'The information broker is closed in this world');
  };
  const emit = (worldId: string, req: any) => d.hub.emit(worldId, 'broker', { id: req.id, status: req.status }, dmAnd(req.account_id));

  /** The world clock (the broker keeps none of its own). Moves old broker minutes over once. */
  const worldNow = (worldId: string) => {
    migrateBrokerClock(db, worldId);
    return getClock(db, worldId);
  };
  const gameLabel = (worldId: string, minutes: number) => formatDate(getCalendar(db, worldId).definition, minutes);

  /**
   * Waits that are over become answers, unless the tier is "DM reviews" (those
   * wait for approval). Answers a model or the rules built are checked once more
   * for DM-only text first; a hit holds the answer for the DM.
   */
  function settle(worldId: string) {
    const minutes = worldNow(worldId).minutes;
    const due = all<any>(db, `SELECT * FROM broker_requests WHERE world_id = ? AND status = 'waiting' AND needs_review = 0 AND ((wait_clock = 'real' AND ready_at <= ?) OR (wait_clock = 'game' AND ready_at_game <= ?))`, worldId, now(), minutes);
    for (const q of due) {
      if (!q.dm_written && q.answer && leaks(db, d.library, worldId, q.answer, q.question, !!q.broker_level)) {
        run(db, 'UPDATE broker_requests SET needs_review = 1 WHERE id = ?', q.id);
        emit(worldId, { ...q, status: 'waiting' });
        continue;
      }
      run(db, `UPDATE broker_requests SET status = 'answered', delivered_at = ? WHERE id = ?`, now(), q.id);
      emit(worldId, { ...q, status: 'answered' });
    }
  }
  const timer = setInterval(() => {
    for (const w of all<any>(db, `SELECT DISTINCT world_id FROM broker_requests WHERE status = 'waiting'`)) { try { settle(w.world_id); } catch { /* world gone */ } }
  }, 15_000);
  timer.unref();

  const view = (res: Response, q: any, nm: Record<string, string>) => {
    const { cfg } = loadConfig(db, q.world_id);
    const minutes = getClock(db, q.world_id).minutes;
    const dm = isDM(res);
    const tier = cfg.tiers.find((t) => t.id === q.tier);
    const out: any = {
      id: q.id, question: q.question, length: q.length, tier: q.tier, tier_name: q.tier === 'other' ? 'Other' : tier?.name ?? q.tier, cost_cp: q.status === 'pricing' || (q.status === 'declined' && !q.ledger_id && q.answer === null) ? null : q.cost_cp, payer: q.payer, status: q.status,
      wait_clock: q.wait_clock, ready_at: q.ready_at, ready_at_game: q.ready_at_game, ready_at_game_label: q.ready_at_game !== null && q.ready_at_game !== undefined ? gameLabel(q.world_id, q.ready_at_game) : null,
      game_now: minutes, created_at: q.created_at, delivered_at: q.delivered_at, reply: q.dm_note,
    };
    if (q.status === 'answered' || dm) { out.answer = q.answer; out.sources = JSON.parse(q.sources || '[]'); }
    if (q.status === 'answered') out.voice = `${cfg.persona.name} ${cfg.persona.voice}`;
    if (dm) {
      out.broker_level = !!q.broker_level;
      out.asker = q.account_id; out.asker_name = nm[q.account_id] ?? 'Someone';
      out.needs_review = !!q.needs_review && q.status === 'waiting';
      // DM only: how the question was judged, and the DM-side lines that matched.
      const c: (Classification & { routing?: Labels }) | null = q.classification ? JSON.parse(q.classification) : null;
      out.classification = ctx(res).viewer.audience === 'ai' ? null : c ? { type: c.type, verdict: c.verdict, reason: c.reason, entities: c.entities, knowledge: c.knowledge, multiplier: c.multiplier, dmEvidence: c.dmEvidence, routing: c.routing ?? null } : { type: questionType(q.question), verdict: null, reason: 'Asked before questions were classified.', entities: [], knowledge: null, multiplier: 1, dmEvidence: [], routing: null };
    }
    return out;
  };

  const siteOf = (res: Response) => {
    const s = settings(res);
    const url = String(featureSetting(s, 'brokerSiteUrl') ?? '').trim();
    if (!/^https?:\/\//i.test(url)) return null;
    return { url, label: String(featureSetting(s, 'brokerSiteLabel') ?? '').trim() || url };
  };
  const topicsOf = (res: Response): string[] => {
    const v = featureSetting<unknown>(settings(res), 'brokerTopics');
    return Array.isArray(v) ? v.map(String).filter(Boolean) : [];
  };

  r.get('/config', (_req, res) => {
    on(res);
    const w = ctx(res).world.id;
    const { cfg } = loadConfig(db, w);
    const c = worldNow(w);
    // Players get the same config; spoiler tags and routing rules stay on DM-only routes.
    res.json({ ...cfg, payer: settings(res).brokerPayer, clock: { minutes: c.minutes, label: c.label }, site: siteOf(res), topics: topicsOf(res) });
  });
  r.put('/config', requireDM, (req, res) => {
    const c = validConfig(req.body);
    saveConfig(db, ctx(res).world.id, c);
    audit(db, ctx(res).world.id, me(res), 'broker.config', `${c.tiers.length} tiers`);
    d.hub.emit(ctx(res).world.id, 'broker-config', {}, () => true);
    res.json(loadConfig(db, ctx(res).world.id).cfg);
  });
  // "Auto for all tiers except Guarded": every price tier delivers when its wait is over.
  r.post('/delivery/auto', requireDM, (_req, res) => {
    const w = ctx(res).world.id;
    const { cfg } = loadConfig(db, w);
    const next: Config = { ...cfg, tiers: cfg.tiers.map((t) => ({ ...t, delivery: deliveryOf(t.knowledge, 'auto') })) };
    saveConfig(db, w, next);
    audit(db, w, me(res), 'broker.config', 'delivery: auto except guarded');
    d.hub.emit(w, 'broker-config', {}, () => true);
    res.json(loadConfig(db, w).cfg);
  });
  // The old broker clock, now a thin wrapper over the world clock.
  r.post('/clock', requireDM, (req, res) => {
    const w = ctx(res).world.id;
    const cur = worldNow(w).minutes;
    if (req.body?.setMinutes !== undefined) moveClockTo(db, d.hub, w, int(req.body.setMinutes, 'setMinutes', { min: 0, max: 1_000_000_000 })!, 'Broker clock', me(res));
    else {
      const add = int(req.body?.addMinutes, 'addMinutes', { min: -1_000_000, max: 1_000_000 })!;
      if (add > 0) advance(db, d.hub, w, add, 'Broker clock', me(res));
      else if (add < 0) moveClockTo(db, d.hub, w, Math.max(0, cur + add), 'Broker clock', me(res));
    }
    settle(w);
    const c = getClock(db, w);
    d.hub.emit(w, 'broker-clock', { minutes: c.minutes, label: c.label }, () => true);
    res.json({ minutes: c.minutes, label: c.label });
  });

  // DM only: free-text spoiler topics. A question that names one always goes to the DM.
  r.get('/spoilers', requireDM, (_req, res) => {
    const row = one<any>(db, 'SELECT spoiler_topics FROM broker_config WHERE world_id = ?', ctx(res).world.id);
    res.json({ topics: JSON.parse(row?.spoiler_topics || '[]') });
  });
  r.put('/spoilers', requireDM, (req, res) => {
    const w = ctx(res).world.id;
    const raw = req.body?.topics;
    if (!Array.isArray(raw) || raw.length > 50) throw new HttpError(400, 'topics must be a list of up to 50 texts');
    const topics = [...new Set(raw.map((t: unknown) => str(t, 'topic', { max: 200 }).trim()).filter(Boolean))];
    run(db, `INSERT INTO broker_config (world_id, config, game_minutes, clock_migrated, spoiler_topics) VALUES (?, '{}', 0, 1, ?) ON CONFLICT (world_id) DO UPDATE SET spoiler_topics = excluded.spoiler_topics`, w, JSON.stringify(topics));
    audit(db, w, me(res), 'broker.spoilers', `${topics.length} topics`);
    res.json({ topics });
  });

  /** Where a question goes, and the quote the player sees. Never charges. */
  async function quote(res: Response, question: string, length: string) {
    on(res);
    const w = ctx(res).world.id;
    const { cfg } = loadConfig(db, w);
    const len = cfg.lengths.find((l) => l.id === length) ?? cfg.lengths[0];
    const asker = me(res);
    // Always a player's view: the DM asking gets what a player would get.
    const viewer: Viewer = isDM(res) ? { accountId: asker, role: 'player' } : ctx(res).viewer;
    const labels = await routeQuestion(d, w, question, topicsOf(res), visibleItems(d, w, asker).map((i) => i.name));
    const p = cfg.persona.name;
    const qid = randomBytes(9).toString('base64url');
    const stub = (reason: string): Classification & { routing: Labels } => ({ type: labels.type, verdict: null as any, reason, entities: [], knowledge: 'local', multiplier: 1, player: null, dmEvidence: [], routing: labels });
    const keep = (extra: Record<string, unknown>) => {
      quotes.set(qid, { world: w, account: asker, question, length: len.id, expires: Date.now() + QUOTE_MS, ...extra });
      for (const [k, v] of quotes) if (v.expires < Date.now()) quotes.delete(k);
    };
    const confident = labels.confidence >= LOW_CONFIDENCE;
    const shape = { quoteId: qid, length: len.id, expires_in: QUOTE_MS / 1000 };

    // Outside the world and the DM's allowed topics: an in-character refusal, free.
    if (labels.scope === 'off-topic' && confident) {
      keep({ kind: 'offtopic', tier: 'other', cost: 0, wait: null, found: null, refused: true, classification: stub('Off topic: refused in character, nothing charged.') });
      return { ...shape, tier: 'other', tier_name: 'Other', cost_cp: 0, wait: null, wait_text: 'no answer', secret: false, refused: true, line: OFF_TOPIC_LINE(p), kind: 'offtopic', delivery: 'auto' };
    }

    // Spoiler-seeking, meta-gaming or unsure: the DM decides (Guarded secrets).
    const guarded = labels.intent !== 'fact' || !confident;

    // "Other": rules and items. Free, answered at once, never a price tier.
    if (!guarded && (labels.scope === 'rules' || labels.scope === 'item')) {
      let other: OtherAnswer = labels.scope === 'rules' ? rulesAnswer(d, w, question) : itemAnswer(d, w, asker, question);
      let reason = labels.scope === 'rules' ? 'Rules question: answered free from the game module.' : 'Item question: answered free from the item card.';
      if (leaks(db, d.library, w, other.answer, question)) { other = { answer: NO_LEAK_LINE, sources: [] }; reason += ' (The output check held the text back.)'; }
      keep({ kind: 'other', tier: 'other', cost: 0, wait: null, found: other, classification: stub(reason) });
      return { ...shape, tier: 'other', tier_name: 'Other', cost_cp: 0, wait: null, wait_text: 'right now', secret: false, refused: false, line: `${p} shrugs. "That's about the game, not the world. No charge."`, kind: 'other', delivery: 'auto', answer: other.answer, sources: other.sources };
    }

    const c = classify(db, d.library, w, question, len.id, viewer);
    const found = !guarded && c.verdict === 'shared' ? c.player : null;
    const tier = found ? cfg.tiers.find((t) => t.knowledge === c.knowledge) ?? cfg.tiers.find((t) => t.knowledge === 'local')! : cfg.tiers.find((t) => t.knowledge === 'secret')!;
    const secret = !found || tier.knowledge === 'secret' || tier.costCp === null;
    const refused = secret && cfg.unknown === 'refuse';
    const cost = secret ? null : Math.round(tier.costCp! * len.multiplier * c.multiplier);
    const reason = guarded ? `Goes to you: ${labels.intent !== 'fact' ? labels.intent : 'the audit labels are low-confidence'}. ${c.reason}` : c.reason;
    // An answer that uses broker-level lines waits for the DM unless the world says brokerLevelDelivery: auto.
    const brokerLevel = !!found?.brokerLevel && !secret;
    const delivery: Delivery = brokerLevel && featureSetting(settings(res), 'brokerLevelDelivery') !== 'auto' ? 'review' : tier.delivery;
    keep({ kind: secret ? 'secret' : 'priced', tier: tier.id, cost, wait: secret ? null : tier.wait, found, refused, delivery, brokerLevel, classification: { ...c, reason, routing: labels } });
    const line = refused
      ? `${p} shakes their head. "Never heard of it. Ask me something else."`
      : secret
        ? `${p} frowns. "That's not something I know. I'll have to ask around, and that costs whatever it costs."`
        : cost === 0 ? `${p} shrugs. "Everyone knows that. No charge."` : `${p} considers it. "${tier.name}. ${money(cost!)}, and give me ${waitText(tier.wait)}."`;
    return { ...shape, tier: tier.id, tier_name: tier.name, cost_cp: cost, wait: secret ? null : tier.wait, wait_text: refused ? 'no answer' : secret ? 'the DM decides' : waitText(tier.wait), secret, refused, line, kind: secret ? 'secret' : 'priced', delivery: secret ? 'review' : delivery };
  }
  // GET works with read-only keys (MCP); it never charges.
  // Secret, spoiler and unknown questions get the same reply, so a quote never reveals that a secret exists.
  r.get('/quote', requirePlayerOrDM, async (req, res) => res.json(await quote(res, str(req.query.question, 'question', { max: 500 }), String(req.query.length ?? 'short'))));
  r.post('/quote', requirePlayerOrDM, async (req, res) => res.json(await quote(res, str(req.body?.question, 'question', { max: 500 }), String(req.body?.length ?? 'short'))));

  function charge(res: Response, asker: string, cost: number, question: string): { payer: string; ledgerId: string | null } {
    const s = settings(res);
    const w = ctx(res).world.id;
    const payer = s.brokerPayer === 'party' && s.partyPurse ? 'party' : asker;
    if (!cost) return { payer, ledgerId: null };
    const bal = balance(db, w, payer);
    if (bal < cost) throw new HttpError(402, `Not enough coin: this costs ${money(cost)} and ${payer === 'party' ? 'the party pouch has' : 'you have'} ${money(Math.max(0, bal))}`);
    const lid = id('led_');
    run(db, `INSERT INTO ledger (id, world_id, owner, amount_cp, note, by_id, at, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'approved')`, lid, w, payer, -cost, `Broker: ${question}`.slice(0, 200), asker, now());
    return { payer, ledgerId: lid };
  }
  const readyAt = (w: string, wait: Tier['wait']) => {
    if (!wait || !wait.amount) return { clock: 'real', at: now(), game: null };
    if (wait.clock === 'game') return { clock: 'game', at: null, game: addMinutesForWait(db, w, wait.amount, wait.unit) };
    return { clock: 'real', at: new Date(Date.now() + wait.amount * UNIT_MIN[wait.unit] * 60_000).toISOString(), game: null };
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
    // Classified text lives on its page only: the stored evidence names the page and says so, never repeats the text.
    const cls = JSON.stringify({ ...q.classification, dmEvidence: (q.classification?.dmEvidence ?? []).map((e: any) => (e.level === 'classified' ? { ...e, text: '(classified: open the page to read it)' } : e)) });
    if (q.refused) {
      // Turned away. The DM still sees what was asked (and could send an offer).
      run(db, `INSERT INTO broker_requests (id, world_id, account_id, question, length, tier, status, created_at, classification) VALUES (?, ?, ?, ?, ?, ?, 'noted', ?, ?)`, rid, w, me(res), q.question, q.length, q.tier, now(), cls);
      audit(db, w, me(res), 'broker.ask', q.kind === 'offtopic' ? 'off topic' : 'turned away');
      d.hub.emit(w, 'broker', { id: rid, status: 'noted' }, dmAnd());
      return res.status(200).json({ id: rid, status: 'noted', question: q.question, line: q.kind === 'offtopic' ? 'That’s not something I deal in.' : 'The broker has nothing for you on that.' });
    }
    if (q.kind === 'other') {
      // Free and at once. The answer was checked for DM-only text when it was built.
      run(db, `INSERT INTO broker_requests (id, world_id, account_id, question, length, tier, cost_cp, status, wait_clock, ready_at, answer, sources, created_at, delivered_at, classification) VALUES (?, ?, ?, ?, ?, 'other', 0, 'answered', 'real', ?, ?, ?, ?, ?, ?)`,
        rid, w, me(res), q.question, q.length, now(), q.found.answer, JSON.stringify(q.found.sources), now(), now(), cls);
      audit(db, w, me(res), 'broker.ask', 'other (free)');
    } else if (q.cost === null) {
      run(db, `INSERT INTO broker_requests (id, world_id, account_id, question, length, tier, status, created_at, classification) VALUES (?, ?, ?, ?, ?, ?, 'pricing', ?, ?)`, rid, w, me(res), q.question, q.length, q.tier, now(), cls);
      audit(db, w, me(res), 'broker.ask', `${q.tier} ${q.cost ?? 'priced by DM'}`);
    } else {
      tx(db, () => {
        const { payer, ledgerId } = charge(res, me(res), q.cost, q.question);
        const ra = readyAt(w, q.wait);
        run(db, `INSERT INTO broker_requests (id, world_id, account_id, question, length, tier, cost_cp, payer, ledger_id, status, wait_clock, ready_at, ready_at_game, answer, sources, created_at, classification, needs_review, broker_level) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'waiting', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          rid, w, me(res), q.question, q.length, q.tier, q.cost, payer, ledgerId, ra.clock, ra.at, ra.game, q.found.answer, JSON.stringify(q.found.sources), now(), cls, q.delivery === 'review' ? 1 : 0, q.brokerLevel ? 1 : 0);
      });
      settle(w);
      audit(db, w, me(res), 'broker.ask', `${q.tier} ${q.cost}`);
    }
    const row = one<any>(db, 'SELECT * FROM broker_requests WHERE id = ?', rid);
    emit(w, row);
    res.status(201).json(view(res, row, names(db, w)));
  });

  r.get('/', (_req, res) => {
    on(res);
    const w = ctx(res).world.id;
    settle(w);
    const rows = isDM(res)
      ? all<any>(db, 'SELECT * FROM broker_requests WHERE world_id = ? ORDER BY created_at DESC LIMIT 200', w)
      : all<any>(db, `SELECT * FROM broker_requests WHERE world_id = ? AND account_id = ? AND status <> 'noted' ORDER BY created_at DESC LIMIT 100`, w, me(res));
    const nm = names(db, w);
    const c = getClock(db, w);
    res.json({ requests: rows.map((q) => view(res, q, nm)), clock: { minutes: c.minutes, label: c.label } });
  });

  const reqFor = (res: Response, rid: string) => {
    const q = one<any>(db, 'SELECT * FROM broker_requests WHERE id = ? AND world_id = ?', rid, ctx(res).world.id);
    if (!q || (!isDM(res) && (q.account_id !== me(res) || q.status === 'noted'))) throw new HttpError(404, 'Request not found');
    return q;
  };
  const back = (res: Response, rid: string, w: string) => {
    const row = one<any>(db, 'SELECT * FROM broker_requests WHERE id = ?', rid);
    emit(w, row);
    res.json(view(res, row, names(db, w)));
  };

  // ---- DM tuning: try a question, notes the broker may sell, per-page rules ----

  // What a question would be judged as, without anyone paying. DM only.
  r.post('/classify', requireDM, async (req, res) => {
    on(res);
    const w = ctx(res).world.id;
    const question = str(req.body?.question, 'question', { max: 500 });
    const c = classify(db, d.library, w, question, String(req.body?.length ?? 'short'), { accountId: me(res), role: 'player' });
    const { cfg } = loadConfig(db, w);
    const tier = c.verdict === 'shared' ? cfg.tiers.find((t) => t.knowledge === c.knowledge) ?? null : cfg.tiers.find((t) => t.knowledge === 'secret') ?? null;
    const routing = await routeQuestion(d, w, question, topicsOf(res), visibleItems(d, w, me(res)).map((i) => i.name));
    // A model asking (spoofed marker or not) gets no DM-side text.
    const blind = ctx(res).viewer.audience === 'ai';
    res.json({ ...c, ...(blind ? { dmEvidence: [], reason: 'Hidden from models.' } : {}), routing, tier: tier?.id ?? null, tier_name: tier?.name ?? null, cost_cp: c.verdict === 'shared' && tier?.costCp !== null && tier ? Math.round(tier.costCp! * c.multiplier) : null });
  });

  const noteOut = (n: any) => ({ id: n.id, page_id: n.page_id, page_title: n.page_id ? one<any>(db, 'SELECT title FROM pages WHERE id = ?', n.page_id)?.title ?? null : null, topic: n.topic, text: n.text, knowledge: n.knowledge, active: !!n.active, from_request: n.from_request, at: n.at });
  const notePage = (w: string, raw: unknown) => {
    if (raw === undefined || raw === null || raw === '') return null;
    const pid = str(raw, 'pageId', { max: 80 });
    if (!one(db, 'SELECT 1 FROM pages WHERE id = ? AND world_id = ?', pid, w)) throw new HttpError(404, 'Page not found');
    return pid;
  };
  r.get('/notes', requireDM, (_req, res) => res.json(all<any>(db, 'SELECT * FROM broker_notes WHERE world_id = ? ORDER BY at DESC', ctx(res).world.id).map(noteOut)));
  r.post('/notes', requireDM, (req, res) => {
    const w = ctx(res).world.id;
    const b = req.body ?? {};
    const n = { id: id('bnt_'), page_id: notePage(w, b.pageId), topic: str(b.topic, 'topic', { max: 200 }), text: str(b.text, 'text', { max: 5000 }), knowledge: oneOf(b.knowledge, 'knowledge', ['common', 'local', 'deep'] as const, 'local') };
    run(db, 'INSERT INTO broker_notes (id, world_id, page_id, topic, text, knowledge, active, from_request, by_id, at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)', n.id, w, n.page_id, n.topic, n.text, n.knowledge, b.fromRequest ? str(b.fromRequest, 'fromRequest', { max: 40 }) : null, me(res), now());
    audit(db, w, me(res), 'broker.note', n.topic);
    res.status(201).json(noteOut(one(db, 'SELECT * FROM broker_notes WHERE id = ?', n.id)));
  });
  r.patch('/notes/:nid', requireDM, (req, res) => {
    const w = ctx(res).world.id;
    const n = one<any>(db, 'SELECT * FROM broker_notes WHERE id = ? AND world_id = ?', String(req.params.nid), w);
    if (!n) throw new HttpError(404, 'Note not found');
    const b = req.body ?? {};
    run(db, 'UPDATE broker_notes SET page_id = ?, topic = ?, text = ?, knowledge = ?, active = ? WHERE id = ?',
      b.pageId !== undefined ? notePage(w, b.pageId) : n.page_id, b.topic !== undefined ? str(b.topic, 'topic', { max: 200 }) : n.topic, b.text !== undefined ? str(b.text, 'text', { max: 5000 }) : n.text,
      b.knowledge !== undefined ? oneOf(b.knowledge, 'knowledge', ['common', 'local', 'deep'] as const) : n.knowledge, b.active !== undefined ? (b.active ? 1 : 0) : n.active, n.id);
    res.json(noteOut(one(db, 'SELECT * FROM broker_notes WHERE id = ?', n.id)));
  });
  r.delete('/notes/:nid', requireDM, (req, res) => {
    run(db, 'DELETE FROM broker_notes WHERE id = ? AND world_id = ?', String(req.params.nid), ctx(res).world.id);
    res.json({ ok: true });
  });

  const ruleOut = (x: any) => ({ page_id: x.page_id, title: x.title ?? null, visibility: x.visibility ?? null, page_knowledge: x.page_knowledge ?? null, knowledge: x.knowledge, multiplier: x.multiplier, never_sell: !!x.never_sell, spoiler: !!x.spoiler });
  r.get('/rules', requireDM, (_req, res) => {
    res.json(all<any>(db, `SELECT r.*, p.title, p.visibility, p.knowledge AS page_knowledge FROM broker_page_rules r LEFT JOIN pages p ON p.id = r.page_id WHERE r.world_id = ? ORDER BY p.title`, ctx(res).world.id).map(ruleOut));
  });
  r.put('/rules/:pid', requireDM, (req, res) => {
    const w = ctx(res).world.id;
    const pid = String(req.params.pid);
    if (!one(db, 'SELECT 1 FROM pages WHERE id = ? AND world_id = ?', pid, w)) throw new HttpError(404, 'Page not found');
    const b = req.body ?? {};
    const knowledge = b.knowledge === null || b.knowledge === undefined || b.knowledge === '' ? null : oneOf(b.knowledge, 'knowledge', ['common', 'local', 'deep'] as const);
    const mult = b.multiplier === undefined ? 1 : Number(b.multiplier);
    if (!Number.isFinite(mult) || mult < 0 || mult > 100) throw new HttpError(400, 'multiplier must be between 0 and 100');
    run(db, `INSERT INTO broker_page_rules (world_id, page_id, knowledge, multiplier, never_sell, spoiler) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (world_id, page_id) DO UPDATE SET knowledge = excluded.knowledge, multiplier = excluded.multiplier, never_sell = excluded.never_sell, spoiler = excluded.spoiler`,
      w, pid, knowledge, mult, b.neverSell ? 1 : 0, b.spoiler ? 1 : 0);
    audit(db, w, me(res), 'broker.rule', pid);
    res.json(ruleOut(one(db, `SELECT r.*, p.title, p.visibility, p.knowledge AS page_knowledge FROM broker_page_rules r LEFT JOIN pages p ON p.id = r.page_id WHERE r.world_id = ? AND r.page_id = ?`, w, pid)));
  });
  r.delete('/rules/:pid', requireDM, (req, res) => {
    run(db, 'DELETE FROM broker_page_rules WHERE world_id = ? AND page_id = ?', ctx(res).world.id, String(req.params.pid));
    res.json({ ok: true });
  });

  // ---- Special offers the DM sends ----

  /** When an offer runs out: the end of the Nth session after it was made, else its fallback time. */
  function offerExpiry(o: any): string {
    if (o.expires_sessions) {
      const s = one<any>(db, `SELECT ends_at FROM cal_sessions WHERE world_id = ? AND status = 'scheduled' AND ends_at > ? ORDER BY starts_at LIMIT 1 OFFSET ?`, o.world_id, o.created_at, o.expires_sessions - 1);
      if (s) return s.ends_at;
    }
    return o.fallback_at;
  }
  const targetsOf = (o: any): string[] => JSON.parse(o.targets || '[]');
  const playerIds = (w: string) => memberIds(db, w, ['player']);
  const offerFor = (o: any, acc: string) => { const t = targetsOf(o); return t.includes(acc) || (t.includes('party') && playerIds(o.world_id).includes(acc)); };
  const offerAudience = (o: any) => { const t = targetsOf(o); return t.includes('party') ? dmAnd(...playerIds(o.world_id)) : dmAnd(...t); };
  function expireOffers(w: string) {
    for (const o of all<any>(db, `SELECT * FROM broker_offers WHERE world_id = ? AND status = 'open'`, w)) {
      if (offerExpiry(o) <= now()) {
        run(db, `UPDATE broker_offers SET status = 'expired' WHERE id = ?`, o.id);
        run(db, `UPDATE coin_requests SET status = 'cancelled' WHERE offer_id = ? AND status = 'open'`, o.id);
        d.hub.emit(w, 'broker-offer', { id: o.id, status: 'expired' }, offerAudience(o));
      }
    }
  }
  const offerTimer = setInterval(() => { for (const x of all<any>(db, `SELECT DISTINCT world_id FROM broker_offers WHERE status = 'open'`)) expireOffers(x.world_id); }, 30_000);
  offerTimer.unref();

  function offerOut(res: Response, o: any, nm: Record<string, string>) {
    const dm = isDM(res);
    const out: any = { id: o.id, title: o.title, teaser: o.teaser, price_cp: o.price_cp, status: o.status, expires_at: offerExpiry(o), expires_sessions: o.expires_sessions, created_at: o.created_at, paid_at: o.paid_at, paid_by: o.paid_by, paid_by_name: o.paid_by ? nm[o.paid_by] ?? null : null };
    if (o.status === 'paid' || dm) {
      out.info = o.info;
      const pg = o.page_id ? one<any>(db, 'SELECT id, title, visibility, player_body FROM pages WHERE id = ?', o.page_id) : null;
      // Link the page only if the viewer may open it.
      out.page = pg && (dm || (pg.visibility === 'party' && pg.player_body !== null)) ? { id: pg.id, title: pg.title } : null;
    }
    if (dm) { out.targets = targetsOf(o); out.declined_by = JSON.parse(o.declined_by); out.paid_from = o.paid_from; out.target_names = out.targets.map((t: string) => (t === 'party' ? 'The whole party' : nm[t] ?? 'Someone')); }
    else out.for_party = targetsOf(o).includes('party');
    return out;
  }
  const offerFind = (res: Response, oid: string) => {
    const o = one<any>(db, 'SELECT * FROM broker_offers WHERE id = ? AND world_id = ?', oid, ctx(res).world.id);
    if (!o || (!isDM(res) && (!offerFor(o, me(res)) || JSON.parse(o.declined_by).includes(me(res)) || !['open', 'paid'].includes(o.status)))) throw new HttpError(404, 'Offer not found');
    return o;
  };

  r.get('/offers', (_req, res) => {
    on(res);
    const w = ctx(res).world.id;
    expireOffers(w);
    const nm = names(db, w);
    if (isDM(res)) return res.json(all<any>(db, 'SELECT * FROM broker_offers WHERE world_id = ? ORDER BY created_at DESC LIMIT 200', w).map((o) => offerOut(res, o, nm)));
    const mine = all<any>(db, `SELECT * FROM broker_offers WHERE world_id = ? AND status IN ('open', 'paid') ORDER BY created_at DESC LIMIT 200`, w)
      .filter((o) => offerFor(o, me(res)) && !(o.status === 'open' && JSON.parse(o.declined_by).includes(me(res))));
    res.json(mine.map((o) => offerOut(res, o, nm)));
  });
  r.post('/offers', requireDM, (req, res) => {
    on(res);
    const w = ctx(res).world.id;
    const b = req.body ?? {};
    const players = playerIds(w);
    const raw = Array.isArray(b.targets) ? b.targets : [b.targets ?? 'party'];
    const targets = raw.includes('party') ? ['party'] : [...new Set(raw.map((t: unknown) => String(t)))] as string[];
    if (!targets.length || targets.some((t) => t !== 'party' && !players.includes(t))) throw new HttpError(400, 'targets must be "party" or player account ids');
    const sessions = b.expiresSessions === undefined || b.expiresSessions === null ? null : int(b.expiresSessions, 'expiresSessions', { min: 1, max: 20 })!;
    const hours = int(b.fallbackHours, 'fallbackHours', { min: 1, max: 24 * 365, optional: true }) ?? (sessions ? 24 * 14 : 72);
    const o = {
      id: id('bof_'), title: str(b.title, 'title', { max: 120 }), teaser: str(b.teaser, 'teaser', { max: 400, optional: true }), info: str(b.info, 'info', { max: 10_000 }),
      page_id: notePage(w, b.pageId), price_cp: int(b.priceCp, 'priceCp', { min: 0, max: 100_000_000 })!,
    };
    run(db, `INSERT INTO broker_offers (id, world_id, title, teaser, info, page_id, price_cp, targets, expires_sessions, fallback_at, status, by_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
      o.id, w, o.title, o.teaser, o.info, o.page_id, o.price_cp, JSON.stringify(targets), sessions, new Date(Date.now() + hours * 3600_000).toISOString(), me(res), now());
    const row = one<any>(db, 'SELECT * FROM broker_offers WHERE id = ?', o.id);
    audit(db, w, me(res), 'broker.offer', `${o.title} ${o.price_cp}`);
    d.hub.emit(w, 'broker-offer', { id: o.id, status: 'open' }, offerAudience(row));
    res.status(201).json(offerOut(res, row, names(db, w)));
  });
  r.post('/offers/:oid/pay', requirePlayerOrDM, (req, res) => {
    on(res);
    const w = ctx(res).world.id;
    expireOffers(w);
    const o = offerFind(res, String(req.params.oid));
    if (isDM(res)) throw new HttpError(403, 'Players pay for offers');
    if (o.status !== 'open') throw new HttpError(409, o.status === 'paid' ? 'Already paid' : 'This offer is gone');
    const s = settings(res);
    const from = req.body?.from === 'party' ? 'party' : me(res);
    if (from === 'party' && !s.partyPurse) throw new HttpError(400, 'The party pouch is off in this world');
    tx(db, () => {
      const bal = balance(db, w, from);
      if (bal < o.price_cp) throw new HttpError(402, `Not enough coin: this costs ${money(o.price_cp)} and ${from === 'party' ? 'the party pouch has' : 'you have'} ${money(Math.max(0, bal))}`);
      let lid: string | null = null;
      if (o.price_cp) {
        lid = id('led_');
        run(db, `INSERT INTO ledger (id, world_id, owner, amount_cp, note, by_id, at, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'approved')`, lid, w, from, -o.price_cp, `Broker offer: ${o.title}`.slice(0, 200), me(res), now());
      }
      run(db, `UPDATE broker_offers SET status = 'paid', paid_by = ?, paid_from = ?, ledger_id = ?, paid_at = ? WHERE id = ?`, me(res), from, lid, now(), o.id);
      run(db, `UPDATE coin_requests SET status = 'done' WHERE offer_id = ? AND status = 'open'`, o.id);
    });
    audit(db, w, me(res), 'broker.offer.pay', o.title);
    const row = one<any>(db, 'SELECT * FROM broker_offers WHERE id = ?', o.id);
    d.hub.emit(w, 'broker-offer', { id: o.id, status: 'paid' }, offerAudience(row));
    d.hub.emit(w, 'coin', { owner: from, balance: balance(db, w, from) }, from === 'party' ? () => true : dmAnd(from));
    res.json(offerOut(res, row, names(db, w)));
  });
  r.post('/offers/:oid/decline', requirePlayerOrDM, (req, res) => {
    const w = ctx(res).world.id;
    const o = offerFind(res, String(req.params.oid));
    if (isDM(res) || o.status !== 'open') throw new HttpError(409, 'Nothing to decline');
    const declined = [...new Set([...JSON.parse(o.declined_by), me(res)])];
    const t = targetsOf(o);
    const everyone = t.includes('party') ? playerIds(w) : t;
    const all_ = everyone.every((a) => declined.includes(a));
    run(db, 'UPDATE broker_offers SET declined_by = ?, status = ? WHERE id = ?', JSON.stringify(declined), all_ ? 'declined' : 'open', o.id);
    if (all_) run(db, `UPDATE coin_requests SET status = 'cancelled' WHERE offer_id = ? AND status = 'open'`, o.id);
    d.hub.emit(w, 'broker-offer', { id: o.id, status: all_ ? 'declined' : 'open' }, dmAnd(me(res)));
    res.json({ ok: true, status: all_ ? 'declined' : 'open' });
  });
  r.post('/offers/:oid/withdraw', requireDM, (req, res) => {
    const w = ctx(res).world.id;
    const o = offerFind(res, String(req.params.oid));
    if (o.status !== 'open') throw new HttpError(409, 'Only an open offer can be withdrawn');
    run(db, `UPDATE broker_offers SET status = 'withdrawn' WHERE id = ?`, o.id);
    run(db, `UPDATE coin_requests SET status = 'cancelled' WHERE offer_id = ? AND status = 'open'`, o.id);
    d.hub.emit(w, 'broker-offer', { id: o.id, status: 'withdrawn' }, offerAudience(o));
    res.json({ ok: true });
  });

  // Save a request's answer as a broker note, so later questions on the topic sell it too.
  r.post('/:id/note', requireDM, (req, res) => {
    const w = ctx(res).world.id;
    const q = reqFor(res, String(req.params.id));
    const text = req.body?.text !== undefined ? str(req.body.text, 'text', { max: 5000 }) : String(q.answer ?? '').trim();
    if (!text) throw new HttpError(400, 'Write the answer first');
    const { cfg } = loadConfig(db, w);
    const tierK = cfg.tiers.find((t) => t.id === q.tier)?.knowledge;
    const knowledge = oneOf(req.body?.knowledge ?? (tierK && tierK !== 'secret' ? tierK : 'deep'), 'knowledge', ['common', 'local', 'deep'] as const);
    const src = JSON.parse(q.sources || '[]').find((x: any) => x.id)?.id ?? null;
    const nid = id('bnt_');
    run(db, 'INSERT INTO broker_notes (id, world_id, page_id, topic, text, knowledge, active, from_request, by_id, at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)',
      nid, w, req.body?.pageId !== undefined ? notePage(w, req.body.pageId) : src, str(req.body?.topic ?? q.question, 'topic', { max: 200 }), text, knowledge, q.id, me(res), now());
    audit(db, w, me(res), 'broker.note', q.question);
    res.status(201).json(noteOut(one(db, 'SELECT * FROM broker_notes WHERE id = ?', nid)));
  });

  // DM prices a guarded secret (and writes the answer); the player then accepts or declines.
  r.post('/:id/price', requireDM, (req, res) => {
    const w = ctx(res).world.id;
    const q = reqFor(res, String(req.params.id));
    if (q.status !== 'pricing') throw new HttpError(409, 'This request is not waiting for a price');
    const cost = int(req.body?.costCp, 'costCp', { min: 0, max: 100_000_000 })!;
    const wait = { amount: int(req.body?.waitAmount, 'waitAmount', { min: 0, max: 100_000, optional: true }) ?? 0, unit: oneOf(req.body?.waitUnit, 'waitUnit', ['minutes', 'hours', 'days'] as const, 'hours'), clock: oneOf(req.body?.clock, 'clock', ['real', 'game'] as const, 'game') };
    const answer = str(req.body?.answer, 'answer', { max: 10_000 });
    run(db, `UPDATE broker_requests SET status = 'offered', dm_written = 1, cost_cp = ?, wait_clock = ?, ready_at = ?, answer = ?, dm_note = ? WHERE id = ?`,
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
  // Approve (a "DM reviews" answer) or deliver early: either way the DM decides, so it goes out now.
  const deliver = (req: any, res: Response) => {
    const w = ctx(res).world.id;
    const q = reqFor(res, String(req.params.id));
    if (q.status !== 'waiting') throw new HttpError(409, 'Only a waiting answer can be delivered early');
    run(db, `UPDATE broker_requests SET status = 'answered', needs_review = 0, delivered_at = ? WHERE id = ?`, now(), q.id);
    audit(db, w, me(res), 'broker.approve', q.id);
    back(res, q.id, w);
  };
  r.post('/:id/deliver', requireDM, deliver);
  r.post('/:id/approve', requireDM, deliver);
  // DM edits the prepared answer before it is revealed (or after).
  r.patch('/:id', requireDM, (req, res) => {
    const w = ctx(res).world.id;
    const q = reqFor(res, String(req.params.id));
    run(db, 'UPDATE broker_requests SET answer = ?, dm_written = ?, dm_note = ? WHERE id = ?', req.body?.answer !== undefined ? str(req.body.answer, 'answer', { max: 10_000 }) : q.answer, req.body?.answer !== undefined ? 1 : q.dm_written, req.body?.note !== undefined ? str(req.body.note, 'note', { max: 300, optional: true }) || null : q.dm_note, q.id);
    audit(db, w, me(res), 'broker.edit', q.id);
    back(res, q.id, w);
  });

  return r;
}

export const BROKER_DEFAULT_SETTINGS = { brokerEnabled: DEFAULT_SETTINGS.brokerEnabled, brokerPayer: DEFAULT_SETTINGS.brokerPayer };

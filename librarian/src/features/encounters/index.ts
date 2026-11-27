// NPC encounters: an NPC walks up to one player and a short talk plays out
// in that player's app. The DM sends one by hand (a quick line with answers,
// a saved encounter or a built-in starter) and can answer live; with the
// world setting encounterWander on, a player the DM is not busy with can go
// looking for one themselves. Options can give a little gold or a simple
// item, open a shop, or start a small game (coin toss, shell game, dice
// duel, skill check) played on the server. See docs/ENCOUNTERS.md.
//
// What a player gets: their own encounters only, and of each just the log,
// the NPC's current line and the option labels. Where an option leads, the
// DC, and the other nodes never leave the server. Coin paid out by one
// encounter stops at encounterRewardCapCp, so a loop ("Again!") cannot farm
// gold. Every change is a live `encounter` event {id} to the DM and that
// player; clients refetch.
import { Router, type Response } from 'express';
import type { Feature, McpTool } from '../types.ts';
import type { Deps } from '../../app.ts';
import { type DB, all, one, run, tx } from '../../core/db.ts';
import { requireDM, requirePlayerOrDM } from '../../core/auth.ts';
import { dmAnd } from '../../core/events.ts';
import { featureSetting } from '../../core/policy.ts';
import { balance, money, spendable } from '../../core/coin.ts';
import { HttpError, id as newId, int, now, parseJson, str } from '../../core/util.ts';
import { ctx, isDM, me, memberIds, names, settings } from '../../routes/_shared.ts';
import { playerVisible } from '../shop/shops.ts';
import { stateOf as minervaState } from '../minerva/store.ts';
import { memoryLog } from '../minerva/after.ts';
import { draftEncounter, fillEncounter } from './draft.ts';
import { GAME_LABEL, KINDS, LIMITS, PLACES, PLACE_LABEL, STARTERS, cleanPlaces, parseScript, play, quickScript, starter as npcStarter, type EncounterKind, type Effect, type Node, type Place, type Script, type Starter } from './script.ts';
import { EVENT_STARTERS } from './events.ts';

export { parseScript, play, STARTERS } from './script.ts';
export { EVENT_STARTERS } from './events.ts';

const starter = (id: string): Starter | null => npcStarter(id) ?? EVENT_STARTERS.find((s) => s.id === id) ?? null;
const kindOf = (v: unknown): EncounterKind => ((KINDS as readonly string[]).includes(v as string) ? v as EncounterKind : 'npc');

const schema = `
CREATE TABLE IF NOT EXISTS encounters (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  npc_name TEXT NOT NULL,
  npc_blurb TEXT NOT NULL DEFAULT '',
  template_id TEXT,
  template_name TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'dm' CHECK (source IN ('dm', 'wander')),
  script TEXT NOT NULL,
  node_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'cancelled')),
  log TEXT NOT NULL DEFAULT '[]',
  steps INTEGER NOT NULL DEFAULT 0,
  paid_cp INTEGER NOT NULL DEFAULT 0,
  shop_id TEXT,
  open_shop TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS encounters_world ON encounters (world_id, created_at);
CREATE INDEX IF NOT EXISTS encounters_player ON encounters (world_id, account_id, status);
CREATE TABLE IF NOT EXISTS encounter_templates (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  npc_name TEXT NOT NULL,
  npc_blurb TEXT NOT NULL DEFAULT '',
  script TEXT NOT NULL,
  wander INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS encounter_templates_world ON encounter_templates (world_id, name);
-- The DM's starred encounters and events: a saved one's id or a built-in one's (builtin:...).
CREATE TABLE IF NOT EXISTS encounter_favs (
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  template_id TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (world_id, template_id)
);
`;

interface Row {
  kind?: EncounterKind;
  id: string; world_id: string; account_id: string; npc_name: string; npc_blurb: string; template_id: string | null; template_name: string;
  source: 'dm' | 'wander'; script: string; node_id: string; status: 'open' | 'done' | 'cancelled'; log: string; steps: number; paid_cp: number;
  shop_id: string | null; open_shop: string | null; created_by: string; created_at: string; updated_at: string;
  /** When the player first saw the current step: a timed step's clock starts here. Null until then. */
  step_seen_at?: string | null;
}
interface TemplateRow { id: string; world_id: string; name: string; npc_name: string; npc_blurb: string; script: string; wander: number; kind: EncounterKind; places: string; created_at: string; updated_at: string }
/** One line of the talk. who: npc (the NPC speaks), you (the player's answer), game (a result), gain (coin or an item), loss (a lost stake), dm (the DM spoke live), note (anything else), secret (a DM-only note: never sent to the player). */
interface Line { who: 'npc' | 'you' | 'game' | 'gain' | 'loss' | 'dm' | 'note' | 'secret'; text: string; at: string }

const MAX_LOG = 120;

/** The audit log (features write it directly: importing app.ts from a feature would be an import cycle). */
const audit = (db: DB, worldId: string, accountId: string | null, action: string, detail = '') =>
  run(db, 'INSERT INTO audit (world_id, account_id, action, detail, at) VALUES (?, ?, ?, ?, ?)', worldId, accountId, action, detail.slice(0, 500), now());

const cfg = (res: Response) => {
  const s = settings(res);
  return {
    wander: featureSetting<boolean>(s, 'encounterWander') === true,
    wanderMinutes: Number(featureSetting<number>(s, 'encounterWanderMinutes') ?? 30),
    capCp: Number(featureSetting<number>(s, 'encounterRewardCapCp') ?? 1000),
    coins: String(s.coins ?? 'gsc'),
  };
};

const nodeOf = (sc: Script, nid: string): Node => sc.nodes.find((n) => n.id === nid) ?? sc.nodes[0];

/**
 * Which shop an option's "open a shop" means. The hook for the shop system:
 * a named shop, else the one the DM picked when sending, else any open shop
 * players can see. Only a shop a player could open on the Shop page counts.
 */
export function resolveShop(db: DB, worldId: string, effectShop: string, sentShop: string | null): { id: string; name: string } | null {
  const ok = (sid: string | null) => {
    if (!sid) return null;
    const s = one<{ id: string; name: string; status: string }>(db, 'SELECT id, name, status FROM shops WHERE id = ? AND world_id = ?', sid, worldId);
    return s && playerVisible(s as any) && s.status === 'open' ? { id: s.id, name: s.name } : null;
  };
  if (effectShop) return ok(effectShop);
  if (sentShop) return ok(sentShop);
  const open = all<{ id: string; name: string }>(db, `SELECT id, name FROM shops WHERE world_id = ? AND status = 'open' ORDER BY id`, worldId);
  return open.length ? open[Math.floor(Math.random() * open.length)] : null;
}

function routes(d: Deps) {
  const r = Router({ mergeParams: true });
  const { db } = d;
  const W = (res: Response) => ctx(res).world.id;
  // Guests are not at the table: nothing here for them.
  r.use(requirePlayerOrDM);

  // ---- live events ----
  const changed = (e: Pick<Row, 'id' | 'world_id' | 'account_id'>) => d.hub.emit(e.world_id, 'encounter', { id: e.id }, dmAnd(e.account_id));
  /** A finished talk goes into Minerva's notes for the session in progress (DM only), when Minerva is on. Never breaks the talk. */
  const remember = (e: Row, log: Line[]) => {
    try {
      if (!minervaState(db, e.world_id).enabled) return;
      const nm = names(db, e.world_id);
      const results = log.filter((l) => l.who === 'gain' || l.who === 'loss' || l.who === 'game' || l.who === 'secret').map((l) => l.text).slice(-5);
      const said = log.filter((l) => l.who === 'you').map((l) => `"${l.text}"`).slice(-3);
      const text = `${nm[e.account_id] ?? 'A player'} ${e.kind === 'event' ? `had a quick event: ${e.npc_name}` : `met ${e.npc_name}`}${e.source === 'wander' ? ' while wandering' : ''} (app ${e.kind === 'event' ? 'event' : 'encounter'}${e.template_name ? `: ${e.template_name}` : ''}).${said.length ? ` They answered ${said.join(', ')}.` : ''}${results.length ? ` ${results.join(' ')}` : ''}`;
      memoryLog(d, e.world_id, { text: text.slice(0, 1900), about: e.npc_name }, null);
    } catch (err) { console.error('encounters: could not log to Minerva', err); }
  };
  const coinChanged = (w: string, owner: string) => d.hub.emit(w, 'coin', { owner, balance: balance(db, w, owner) }, dmAnd(owner));
  const itemChanged = (w: string, owner: string, it: { id: string; name: string; qty: number }) =>
    d.hub.emit(w, 'item', { id: it.id, owner, name: it.name, qty: it.qty, status: 'approved' }, dmAnd(owner));

  // ---- views ----
  function view(e: Row, dm: boolean, nm: Record<string, string>) {
    const sc = parseScript(parseJson(e.script, {}));
    const n = nodeOf(sc, e.node_id);
    const shop = e.open_shop ? one<{ id: string; name: string }>(db, 'SELECT id, name FROM shops WHERE id = ? AND world_id = ?', e.open_shop, e.world_id) : null;
    const log = parseJson<Line[]>(e.log, []);
    const base = {
      id: e.id, kind: kindOf(e.kind), npc: { name: e.npc_name, blurb: e.npc_blurb }, status: e.status, source: e.source, createdAt: e.created_at, updatedAt: e.updated_at,
      // A DM note ("kept the stranger's purse") never reaches the player.
      log: dm ? log : log.filter((l) => l.who !== 'secret'),
      text: e.status === 'open' ? n.text : null,
      options: e.status === 'open' ? (n.game ? n.options : n.options.length ? n.options : [{ label: 'Farewell' }]).map((o) => ({ label: o.label })) : [],
      game: e.status === 'open' && n.game ? { kind: n.game.kind, label: GAME_LABEL[n.game.kind], stakeCp: n.game.stakeCp, winCp: n.game.winCp, skill: n.game.skill } : null,
      shop,
      // A timed step: endsAt is null until the player has seen it (the clock starts then).
      timer: e.status === 'open' && n.timer ? { secs: n.timer.secs, endsAt: e.step_seen_at ? new Date(Date.parse(e.step_seen_at) + n.timer.secs * 1000).toISOString() : null } : null,
    };
    if (!dm) return base;
    return { ...base, accountId: e.account_id, player: nm[e.account_id] ?? 'A player', templateId: e.template_id, templateName: e.template_name, nodeId: n.id, dc: n.game?.dc ?? null, dcMax: n.game?.dcMax ?? null, paidCp: e.paid_cp, script: sc };
  }
  /** The player is looking at their encounter: a timed step's clock starts now, if it has not already. */
  const seen = (e: Row): Row => {
    if (e.status !== 'open' || e.step_seen_at) return e;
    const n = nodeOf(parseScript(parseJson(e.script, {})), e.node_id);
    if (!n.timer) return e;
    const at = now();
    run(db, 'UPDATE encounters SET step_seen_at = ? WHERE id = ? AND step_seen_at IS NULL', at, e.id);
    changed(e); // the DM's watch shows the countdown
    return { ...e, step_seen_at: at };
  };
  const load = (res: Response, eid: string): Row => {
    const e = one<Row>(db, 'SELECT * FROM encounters WHERE id = ? AND world_id = ?', eid, W(res));
    // A player asking for someone else's encounter gets the same answer as for one that does not exist.
    if (!e || (!isDM(res) && e.account_id !== me(res))) throw new HttpError(404, 'Encounter not found');
    return e;
  };
  const reply = (res: Response, e: Row) => {
    const fresh = one<Row>(db, 'SELECT * FROM encounters WHERE id = ?', e.id)!;
    res.json(view(fresh, isDM(res), names(db, fresh.world_id)));
  };

  /** Start encounters for players. One NPC at a time: an open one the player still has is closed first. */
  function start(w: string, by: string, players: string[], src: { npcName: string; npcBlurb: string; script: Script; templateId: string | null; templateName: string; shopId: string | null; source: 'dm' | 'wander'; kind?: EncounterKind }): Row[] {
    const out: Row[] = [];
    const closed: Row[] = [];
    tx(db, () => {
      for (const p of players) {
        for (const old of all<Row>(db, `SELECT * FROM encounters WHERE world_id = ? AND account_id = ? AND status = 'open'`, w, p)) {
          const log = [...parseJson<Line[]>(old.log, []), { who: 'note', text: old.kind === 'event' ? 'The moment passes.' : `${old.npc_name} wanders off.`, at: now() } as Line];
          run(db, `UPDATE encounters SET status = 'cancelled', log = ?, updated_at = ? WHERE id = ?`, JSON.stringify(log), now(), old.id);
          closed.push(old);
        }
        const first = nodeOf(src.script, src.script.start);
        const e: Row = {
          kind: src.kind ?? 'npc',
          id: newId('enc_'), world_id: w, account_id: p, npc_name: src.npcName, npc_blurb: src.npcBlurb, template_id: src.templateId, template_name: src.templateName,
          source: src.source, script: JSON.stringify(src.script), node_id: first.id, status: 'open', log: JSON.stringify([{ who: 'npc', text: first.text, at: now() }]),
          steps: 0, paid_cp: 0, shop_id: src.shopId, open_shop: null, created_by: by, created_at: now(), updated_at: now(),
        };
        run(db, `INSERT INTO encounters (kind, id, world_id, account_id, npc_name, npc_blurb, template_id, template_name, source, script, node_id, status, log, steps, paid_cp, shop_id, open_shop, created_by, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, e.kind, e.id, e.world_id, e.account_id, e.npc_name, e.npc_blurb, e.template_id, e.template_name, e.source, e.script, e.node_id, e.status, e.log, e.steps, e.paid_cp, e.shop_id, e.open_shop, e.created_by, e.created_at, e.updated_at);
        out.push(e);
      }
    });
    for (const e of [...closed, ...out]) changed(e);
    return out;
  }

  /** Where a template comes from: the world's own (tpl_…) or a built-in starter (builtin:…). */
  function templateFor(w: string, tid: string) {
    const b = starter(tid);
    if (b) return { id: b.id, name: b.name, npcName: b.npcName, npcBlurb: b.npcBlurb, script: b.script, wander: true, builtin: true, kind: kindOf(b.kind), places: b.places ?? [] };
    const t = one<TemplateRow>(db, 'SELECT * FROM encounter_templates WHERE id = ? AND world_id = ?', tid, w);
    if (!t) throw new HttpError(404, 'Encounter template not found');
    return { id: t.id, name: t.name, npcName: t.npc_name, npcBlurb: t.npc_blurb, script: parseScript(parseJson(t.script, {})), wander: !!t.wander, builtin: false, kind: kindOf(t.kind), places: cleanPlaces(parseJson(t.places, [])) };
  }
  /** The quick events that fit a place: the world's own, and the built-in ones while the world has none for it. */
  const favsOf = (w: string) => new Set(all<{ template_id: string }>(db, 'SELECT template_id FROM encounter_favs WHERE world_id = ?', w).map((f) => f.template_id));
  /**
   * The events a random pick for a place chooses from. from: 'fav' (starred), 'mine' (saved in the world),
   * 'builtin', 'any' (all of them); left out: the world's own when it has some for the place, else the built-ins.
   */
  function eventsFor(w: string, place: Place | null, from?: string) {
    const fits = (places: string[] | undefined) => !place || (places ?? []).includes(place);
    const own = all<TemplateRow>(db, `SELECT * FROM encounter_templates WHERE world_id = ? AND kind = 'event'`, w).filter((t) => fits(cleanPlaces(parseJson(t.places, [])))).map((t) => t.id);
    const built = EVENT_STARTERS.filter((s) => fits(s.places)).map((s) => s.id);
    const ids = from === 'mine' ? own : from === 'builtin' ? built : from === 'any' ? [...own, ...built]
      : from === 'fav' ? (() => { const f = favsOf(w); return [...own, ...built].filter((id) => f.has(id)); })()
      : own.length ? own : built;
    return ids.map((id) => templateFor(w, id));
  }

  // ---- what the app needs to know ----
  r.get('/config', (_req, res) => {
    const c = cfg(res);
    const out: any = { wander: c.wander, wanderMinutes: c.wanderMinutes, capCp: c.capCp, coins: c.coins, games: GAME_LABEL, places: PLACES.map((p) => ({ id: p, label: PLACE_LABEL[p] })) };
    if (!isDM(res)) out.nextWanderAt = c.wander ? nextWander(W(res), me(res), c.wanderMinutes) : null;
    res.json(out);
  });
  const nextWander = (w: string, p: string, minutes: number): string | null => {
    const last = one<{ at: string }>(db, `SELECT created_at AS at FROM encounters WHERE world_id = ? AND account_id = ? AND source = 'wander' ORDER BY created_at DESC LIMIT 1`, w, p);
    if (!last) return null;
    const t = Date.parse(last.at) + minutes * 60_000;
    return t > Date.now() ? new Date(t).toISOString() : null;
  };

  // ---- encounters ----
  r.get('/', (req, res) => {
    const w = W(res);
    const dm = isDM(res);
    const nm = names(db, w);
    const status = String(req.query.status ?? '');
    const rows = dm
      ? all<Row>(db, `SELECT * FROM encounters WHERE world_id = ? ${status === 'open' ? `AND status = 'open'` : ''} ORDER BY created_at DESC LIMIT 60`, w)
      : all<Row>(db, 'SELECT * FROM encounters WHERE world_id = ? AND account_id = ? ORDER BY created_at DESC LIMIT 20', w, me(res));
    res.json(rows.map((e) => view(dm ? e : seen(e), dm, nm)));
  });

  r.get('/:eid', (req, res) => {
    const e = load(res, String(req.params.eid));
    res.json(view(isDM(res) ? e : seen(e), isDM(res), names(db, e.world_id)));
  });

  // DM sends. { accountIds: [...] | 'party', and one of: templateId; script (+ npcName, npcBlurb); line + answers (+ npcName) }. addToPeople: put the NPC on the party's People list. shopId: the shop "open a shop" options without their own shop open.
  r.post('/', requireDM, (req, res) => {
    const w = W(res);
    const b = req.body ?? {};
    const players = new Set(memberIds(db, w, ['player']));
    const to: string[] = b.accountIds === 'party' ? [...players] : Array.isArray(b.accountIds) ? [...new Set<string>(b.accountIds)] : [];
    if (!to.length || to.some((x) => typeof x !== 'string' || !players.has(x))) throw new HttpError(400, 'accountIds must be players in this world');
    const shopId = str(b.shopId, 'shopId', { max: 60, optional: true }) || null;
    if (shopId && !one(db, 'SELECT 1 FROM shops WHERE id = ? AND world_id = ?', shopId, w)) throw new HttpError(400, 'shopId is not a shop in this world');
    let src: Parameters<typeof start>[3];
    // place: a random quick event that fits it (town, road, cave ...), unless a template, script or line is given.
    const place = b.place === undefined || b.place === null || b.place === '' ? null : cleanPlaces([b.place])[0] ?? null;
    if (b.place && !place) throw new HttpError(400, `place must be one of: ${PLACES.join(', ')}`);
    // from: fav | mine | builtin | any, which events a random pick chooses among (see eventsFor).
    const from = ['fav', 'mine', 'builtin', 'any'].includes(b.from) ? String(b.from) : undefined;
    if (!b.templateId && !b.script && !b.line && (place || from)) {
      const pool = eventsFor(w, place, from);
      if (!pool.length) throw new HttpError(404, from === 'fav' ? `No starred events${place ? ` fit ${PLACE_LABEL[place].toLowerCase()}` : ''} yet. Star some first` : `No quick events fit ${place ? PLACE_LABEL[place].toLowerCase() : 'there'} yet. Make one, or tag one with this place`);
      b.templateId = pool[Math.floor(Math.random() * pool.length)].id;
    }
    if (b.templateId) {
      const t = templateFor(w, str(b.templateId, 'templateId', { max: 60 }));
      src = { npcName: str(b.npcName, 'npcName', { max: 80, optional: true }).trim() || t.npcName, npcBlurb: t.npcBlurb, script: t.script, templateId: t.id, templateName: t.name, shopId, source: 'dm', kind: t.kind };
    } else {
      const kind = kindOf(b.kind);
      const npcName = str(b.npcName, 'npcName', { max: 80, optional: true }).trim() || (kind === 'event' ? 'Something happens' : 'A stranger');
      const npcBlurb = str(b.npcBlurb, 'npcBlurb', { max: 300, optional: true }).trim();
      let script: Script;
      if (b.script) script = parseScript(b.script);
      else {
        const line = str(b.line, 'line', { max: LIMITS.text }).trim();
        if (!line) throw new HttpError(400, 'line is required');
        const answers = Array.isArray(b.answers) ? b.answers.filter((a: unknown) => typeof a === 'string' && a.trim()).map((a: string) => a.trim()) : [];
        script = quickScript(line, answers);
      }
      src = { npcName, npcBlurb, script, templateId: null, templateName: str(b.name, 'name', { max: 120, optional: true }).trim(), shopId, source: 'dm', kind };
    }
    const made = start(w, me(res), to, src);
    // "Add to People": the NPC joins the party's People list once, the first time anyone meets them (never for an event).
    if (b.addToPeople === true && src.kind !== 'event' && !one(db, 'SELECT 1 FROM people WHERE world_id = ? AND name = ? COLLATE NOCASE', w, src.npcName)) {
      const nm0 = names(db, w);
      const p = { id: newId('ppl_'), name: src.npcName.slice(0, 120), role: src.npcBlurb.slice(0, 120), attitude: '', kind: 'neutral', page_id: null, met: `Met by ${to.map((x) => nm0[x] ?? 'a player').join(', ')}`.slice(0, 60), visibility: 'party' };
      run(db, 'INSERT INTO people (id, world_id, name, role, attitude, kind, page_id, met, visibility) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', p.id, w, p.name, p.role, p.attitude, p.kind, p.page_id, p.met, p.visibility);
      d.hub.emit(w, 'person', p, () => true);
    }
    audit(db, w, me(res), src.kind === 'event' ? 'encounter.event' : 'encounter.send', `${src.npcName} to ${made.length} player${made.length === 1 ? '' : 's'}`);
    const nm = names(db, w);
    res.status(201).json(made.map((e) => view(e, true, nm)));
  });

  // A player wanders off looking for something to do: a random encounter from the world's wander pool.
  r.post('/wander', (_req, res) => {
    const w = W(res);
    if (isDM(res)) throw new HttpError(400, 'Wandering is for players; send the DM an encounter instead');
    const c = cfg(res);
    if (!c.wander) throw new HttpError(403, 'Your DM has not turned on wandering');
    if (one(db, `SELECT 1 FROM encounters WHERE world_id = ? AND account_id = ? AND status = 'open'`, w, me(res))) throw new HttpError(409, 'Finish the talk you are in first');
    const wait = nextWander(w, me(res), c.wanderMinutes);
    if (wait) throw new HttpError(429, `Nothing stirs yet. Try again after ${new Date(wait).toISOString().slice(11, 16)} UTC`);
    const own = all<TemplateRow>(db, 'SELECT * FROM encounter_templates WHERE world_id = ? AND wander = 1', w);
    const pool = own.length
      ? own.map((t) => ({ id: t.id, name: t.name, npcName: t.npc_name, npcBlurb: t.npc_blurb, script: parseScript(parseJson(t.script, {})), kind: kindOf(t.kind) }))
      : STARTERS.map((t) => ({ ...t, kind: 'npc' as EncounterKind }));
    const t = pool[Math.floor(Math.random() * pool.length)];
    const [e] = start(w, me(res), [me(res)], { npcName: t.npcName, npcBlurb: t.npcBlurb, script: t.script, templateId: t.id, templateName: t.name, shopId: null, source: 'wander', kind: t.kind });
    audit(db, w, me(res), 'encounter.wander', t.name);
    res.status(201).json(view(e, false, {}));
  });

  /**
   * The player picks. { option: i } for an answer; { play: true, pick?, roll?, modifier? } to play the node's game.
   * Everything (coin, items, the next node) happens in one transaction.
   */
  r.post('/:eid/choose', (req, res) => {
    const e = load(res, String(req.params.eid));
    if (e.account_id !== me(res)) throw new HttpError(403, 'Only the player the NPC is talking to can answer');
    if (e.status !== 'open') throw new HttpError(409, 'This talk is over');
    const w = e.world_id;
    const c = cfg(res);
    const sc = parseScript(parseJson(e.script, {}));
    const n = nodeOf(sc, e.node_id);
    const b = req.body ?? {};
    const log = parseJson<Line[]>(e.log, []);
    const say = (who: Line['who'], text: string) => log.push({ who, text, at: now() });
    let paid = e.paid_cp;
    let openShop = e.open_shop;
    const coinMoves: string[] = [];
    const items: { id: string; name: string; qty: number }[] = [];

    const credit = (want: number, note: string): number => {
      const cp = Math.max(0, Math.min(want, c.capCp - paid));
      if (cp > 0) {
        run(db, `INSERT INTO ledger (id, world_id, owner, amount_cp, note, by_id, at, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'approved')`, newId('led_'), w, e.account_id, cp, note.slice(0, 200), e.account_id, now());
        paid += cp;
        coinMoves.push(e.account_id);
      }
      return cp;
    };
    /** Coin out of the player's purse (pay, lose): it hands that much back to the cap, like a lost stake. */
    const debit = (cp: number, note: string) => {
      if (cp <= 0) return;
      run(db, `INSERT INTO ledger (id, world_id, owner, amount_cp, note, by_id, at, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'approved')`, newId('led_'), w, e.account_id, -cp, note.slice(0, 200), e.account_id, now());
      paid = Math.max(0, paid - cp);
      coinMoves.push(e.account_id);
    };
    const apply = (fx: Effect) => {
      if (fx.kind === 'pay') { debit(fx.cp, `Paid ${e.npc_name}`); say('loss', `You pay ${money(fx.cp)}.`); return; }
      if (fx.kind === 'lose') {
        const cp = Math.min(fx.cp, Math.max(0, spendable(db, w, e.account_id)));
        debit(cp, `Lost: ${e.npc_name}`);
        say('loss', cp ? `You lose ${money(cp)}.` : 'Luckily your purse was empty.');
        return;
      }
      if (fx.kind === 'dmnote') { say('secret', fx.text); return; }
      if (fx.kind === 'gold') {
        const cp = credit(fx.cp, `From ${e.npc_name}`);
        say('gain', cp ? `You get ${money(cp)}.` : `${e.npc_name} has nothing more to give.`);
      } else if (fx.kind === 'item') {
        const ex = one<any>(db, `SELECT id, qty FROM items WHERE world_id = ? AND owner = ? AND name = ? AND status = 'approved' AND dm_note = '' AND image IS NULL LIMIT 1`, w, e.account_id, fx.name);
        if (ex) {
          run(db, 'UPDATE items SET qty = qty + ?, updated_at = ?, updated_by = ? WHERE id = ?', fx.qty, now(), e.account_id, ex.id);
          items.push({ id: ex.id, name: fx.name, qty: ex.qty + fx.qty });
        } else {
          const iid = newId('itm_');
          run(db, `INSERT INTO items (id, world_id, owner, name, qty, weight, note, dm_note, link, image, updated_at, updated_by, status) VALUES (?, ?, ?, ?, ?, NULL, ?, '', NULL, NULL, ?, ?, 'approved')`, iid, w, e.account_id, fx.name, fx.qty, (fx.note || `From ${e.npc_name}`).slice(0, 500), now(), e.account_id);
          items.push({ id: iid, name: fx.name, qty: fx.qty });
        }
        say('gain', `You get ${fx.qty > 1 ? `${fx.qty} × ` : ''}${fx.name}.`);
      } else {
        const s = resolveShop(db, w, fx.shopId, e.shop_id);
        if (s) { openShop = s.id; say('note', `${e.npc_name} shows you their wares: ${s.name}.`); } else say('note', `${e.npc_name} has nothing to sell right now.`);
      }
    };

    // A timed step: past the clock (a few seconds' grace for the network), the fallback answer is taken for them.
    // { timeout: true } is the player's app saying the countdown hit zero.
    let timedOut = false;
    if (n.timer) {
      const started = Date.parse(e.step_seen_at ?? now());
      const left = started + n.timer.secs * 1000 - Date.now();
      if (b.timeout === true) { if (left > 2000) throw new HttpError(409, 'There is still time to answer'); timedOut = true; }
      else if (left < -3000) timedOut = true;
    } else if (b.timeout === true) throw new HttpError(400, 'This step has no timer');

    let next: string | null;
    if (timedOut) {
      const t = n.timer!;
      say('note', 'Time is up!');
      if (t.fallback === -1 && n.game) {
        say('game', `Too slow${n.game.skill ? ` for ${n.game.skill}` : ''}. That counts as a failure.`);
        next = n.game.lose;
      } else {
        const o = n.options[Math.min(t.fallback, n.options.length - 1)];
        say('you', `${o.label} (out of time)`);
        // Out of time, they cannot afford to pay: the paying part is skipped, the rest happens.
        const cost = o.effects.reduce((a, fx) => a + (fx.kind === 'pay' ? fx.cp : 0), 0);
        const afford = cost <= 0 || spendable(db, w, e.account_id) >= cost;
        tx(db, () => { for (const fx of o.effects) if (afford || fx.kind !== 'pay') apply(fx); });
        next = o.next;
      }
    } else if (b.play === true) {
      if (!n.game) throw new HttpError(400, 'There is no game to play here');
      const g = n.game;
      if (g.stakeCp > 0 && spendable(db, w, e.account_id) < g.stakeCp) throw new HttpError(409, `You need ${money(g.stakeCp)} to play`);
      if (g.kind === 'check' && kindOf(e.kind) === 'event' && (b.total === undefined || b.total === null || b.total === '') && b.crit !== 'high' && b.crit !== 'low') throw new HttpError(400, `Roll${g.skill ? ` ${g.skill}` : ''} and send your total`);
      const result = play(g, { pick: b.pick, roll: b.roll, modifier: b.modifier, total: b.total, crit: b.crit });
      say('game', result.crit ? result.text : `${result.text} ${g.kind === 'check' ? (result.won ? 'Success!' : 'Not enough.') : result.won ? 'You win!' : 'You lose.'}`);
      if (g.kind === 'check' && result.dc !== undefined) say('secret', `DC ${result.dc}${g.dcMax ? ` (picked from ${g.dc}–${g.dcMax})` : ''}: ${result.crit ? `natural ${result.crit === 'high' ? 20 : 1}, ` : ''}${result.won ? 'passed' : 'failed'}.`);
      tx(db, () => {
        if (result.won) {
          if (g.winCp > 0) { const cp = credit(g.winCp, `Won at ${GAME_LABEL[g.kind].toLowerCase()} with ${e.npc_name}`); if (cp) say('gain', `You win ${money(cp)}.`); else say('note', `${e.npc_name} is out of coin to pay you.`); }
        } else if (g.stakeCp > 0) {
          run(db, `INSERT INTO ledger (id, world_id, owner, amount_cp, note, by_id, at, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'approved')`, newId('led_'), w, e.account_id, -g.stakeCp, `Lost at ${GAME_LABEL[g.kind].toLowerCase()} to ${e.npc_name}`.slice(0, 200), e.account_id, now());
          // Losing hands coin back to the cap: the encounter only ever pays out its winnings net.
          paid = Math.max(0, paid - g.stakeCp);
          coinMoves.push(e.account_id);
          say('loss', `You lose ${money(g.stakeCp)}.`);
        }
      });
      next = result.won ? g.win : g.lose;
    } else {
      const opts = n.options.length || n.game ? n.options : [{ label: 'Farewell', next: null, effects: [] as Effect[] }];
      const i = int(b.option, 'option', { min: 0, max: Math.max(0, opts.length - 1) })!;
      if (!opts.length) throw new HttpError(400, 'Play the game or leave');
      const o = opts[i];
      // Paying for something needs the coin first; nothing happens when they cannot afford it.
      const cost = o.effects.reduce((a, fx) => a + (fx.kind === 'pay' ? fx.cp : 0), 0);
      if (cost > 0 && spendable(db, w, e.account_id) < cost) throw new HttpError(409, `You need ${money(cost)} for that`);
      say('you', o.label);
      tx(db, () => { for (const fx of o.effects) apply(fx); });
      next = o.next;
    }

    const steps = e.steps + 1;
    let status: Row['status'] = 'open';
    let nodeId = e.node_id;
    if (!next) status = 'done';
    else if (steps >= LIMITS.steps) { status = 'done'; say('note', `${e.npc_name} has to go.`); }
    else { nodeId = next; say('npc', nodeOf(sc, next).text); }
    // The player is looking at the next step as this answer comes back, so a timed step's clock starts now.
    run(db, 'UPDATE encounters SET node_id = ?, status = ?, log = ?, steps = ?, paid_cp = ?, open_shop = ?, updated_at = ?, step_seen_at = ? WHERE id = ?',
      nodeId, status, JSON.stringify(log.slice(-MAX_LOG)), steps, paid, openShop, now(), status === 'open' ? now() : null, e.id);
    if (status === 'done') remember(e, log);
    for (const o of new Set(coinMoves)) coinChanged(w, o);
    for (const it of items) itemChanged(w, e.account_id, it);
    changed(e);
    reply(res, e);
  });

  // The player walks away.
  r.post('/:eid/leave', (req, res) => {
    const e = load(res, String(req.params.eid));
    if (e.account_id !== me(res)) throw new HttpError(403, 'Only the player the NPC is talking to can leave');
    if (e.status === 'open') {
      const log = [...parseJson<Line[]>(e.log, []), { who: 'note', text: 'You walk away.', at: now() } as Line];
      run(db, `UPDATE encounters SET status = 'done', log = ?, updated_at = ? WHERE id = ?`, JSON.stringify(log), now(), e.id);
      remember(e, log);
      changed(e);
    }
    reply(res, e);
  });

  // The DM speaks as the NPC, live: { text, answers? }. The player's next answer ends the talk unless the DM speaks again.
  r.post('/:eid/say', requireDM, (req, res) => {
    const e = load(res, String(req.params.eid));
    if (e.status !== 'open') throw new HttpError(409, 'This talk is over');
    const text = str(req.body?.text, 'text', { max: LIMITS.text }).trim();
    if (!text) throw new HttpError(400, 'text is required');
    const answers: string[] = Array.isArray(req.body?.answers) ? req.body.answers.filter((a: unknown) => typeof a === 'string' && a.trim()).slice(0, LIMITS.options).map((a: string) => a.trim().slice(0, LIMITS.label)) : [];
    const sc = parseScript(parseJson(e.script, {}));
    if (sc.nodes.length >= LIMITS.nodes) throw new HttpError(409, 'This talk is too long to add to; send a new one');
    const nid = `dm-${sc.nodes.length + 1}-${newId().slice(0, 4).replace(/[^\w-]/g, 'x')}`;
    sc.nodes.push({ id: nid, text, options: answers.map((label) => ({ label, next: null, effects: [] })), game: null });
    const log = [...parseJson<Line[]>(e.log, []), { who: 'dm', text, at: now() } as Line].slice(-MAX_LOG);
    run(db, 'UPDATE encounters SET script = ?, node_id = ?, log = ?, updated_at = ?, step_seen_at = NULL WHERE id = ?', JSON.stringify(parseScript(sc)), nid, JSON.stringify(log), now(), e.id);
    changed(e);
    reply(res, e);
  });

  r.post('/:eid/end', requireDM, (req, res) => {
    const e = load(res, String(req.params.eid));
    if (e.status === 'open') {
      const log = [...parseJson<Line[]>(e.log, []), { who: 'note', text: e.kind === 'event' ? 'The DM moves the story on.' : `${e.npc_name} takes their leave.`, at: now() } as Line];
      run(db, `UPDATE encounters SET status = 'cancelled', log = ?, updated_at = ? WHERE id = ?`, JSON.stringify(log), now(), e.id);
      changed(e);
    }
    reply(res, e);
  });

  // ---- templates (DM only) ----
  const tview = (t: TemplateRow) => ({ id: t.id, kind: kindOf(t.kind), places: cleanPlaces(parseJson(t.places, [])), name: t.name, npcName: t.npc_name, npcBlurb: t.npc_blurb, script: parseScript(parseJson(t.script, {})), wander: !!t.wander, builtin: false, updatedAt: t.updated_at });
  const tbody = (b: any) => {
    const kind = kindOf(b?.kind);
    const name = str(b?.name, 'name', { max: 120 }).trim();
    // An event's "NPC" is whoever or whatever it is about; its name is enough.
    const npcName = str(b?.npcName, 'npcName', { max: 80, optional: true }).trim() || (kind === 'event' ? name.slice(0, 80) : '');
    if (!name || !npcName) throw new HttpError(400, 'name and npcName are required');
    return { kind, places: JSON.stringify(cleanPlaces(b?.places)), name, npcName, npcBlurb: str(b?.npcBlurb, 'npcBlurb', { max: 300, optional: true }).trim(), script: parseScript(b?.script), wander: b?.wander === true ? 1 : 0 };
  };
  const matches = (q: { kind?: unknown; place?: unknown }) => {
    const kind = q.kind === 'npc' || q.kind === 'event' ? q.kind : null;
    const place = typeof q.place === 'string' ? cleanPlaces([q.place])[0] ?? null : null;
    return (t: { kind: EncounterKind; places: string[] }) => (!kind || t.kind === kind) && (!place || t.places.includes(place));
  };
  // Draft an encounter from a description with the chat model; the DM edits and saves it like any other.
  // { prompt, kind?: 'npc' | 'event', places?, guide?: a quick event DM template's id (its words steer the draft) }.
  r.post('/templates/draft', requireDM, async (req, res) => {
    const prompt = str(req.body?.prompt, 'prompt', { max: 3000 }).trim();
    if (!prompt) throw new HttpError(400, 'Describe the encounter first');
    const kind = kindOf(req.body?.kind);
    let guide = '';
    let places = cleanPlaces(req.body?.places);
    if (typeof req.body?.guide === 'string' && req.body.guide) {
      const { getTemplate } = await import('../templates/store.ts');
      const { guideText } = await import('../templates/spec.ts');
      const g = getTemplate(db, W(res), req.body.guide);
      if (!g) throw new HttpError(404, 'Template not found');
      guide = guideText(g);
      if (!places.length && g.kind === 'event') places = cleanPlaces((g.spec as any).places);
    }
    res.json(await draftEncounter(d, prompt, ctx(res).world.name, { kind, guide, places }));
  });
  // Fill the blanks of a half-written event with the chat model; what the DM wrote stays.
  // { script, name?, npcName?, npcBlurb?, kind?, hint?, step?: one step's id to fill only that step }.
  r.post('/templates/fill', requireDM, async (req, res) => {
    const b = req.body ?? {};
    if (!b.script || typeof b.script !== 'object') throw new HttpError(400, 'Send the event to fill in');
    const opt = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : undefined);
    res.json(await fillEncounter(d, ctx(res).world.name, { script: b.script, name: opt(b.name, 120), npcName: opt(b.npcName, 80), npcBlurb: opt(b.npcBlurb, 300), kind: kindOf(b.kind), hint: opt(b.hint, 500), step: opt(b.step, 40) ?? null }));
  });
  // ?kind=npc|event, ?place=woods: only those.
  r.get('/templates/all', requireDM, (req, res) => {
    const want = matches(req.query);
    const own = all<TemplateRow>(db, 'SELECT * FROM encounter_templates WHERE world_id = ? ORDER BY name COLLATE NOCASE', W(res)).map(tview);
    const anyWander = own.some((t) => t.wander);
    const favs = favsOf(W(res));
    res.json({
      templates: own.filter(want).map((t) => ({ ...t, fav: favs.has(t.id) })),
      starters: [...STARTERS.map((s) => ({ ...s, kind: 'npc' as EncounterKind, places: [] as Place[], wander: !anyWander })), ...EVENT_STARTERS.map((s) => ({ ...s, kind: 'event' as EncounterKind, places: s.places ?? [], wander: false }))]
        .map((s) => ({ ...s, builtin: true, fav: favs.has(s.id) })).filter(want),
      places: PLACES.map((p) => ({ id: p, label: PLACE_LABEL[p] })),
    });
  });
  r.post('/templates/all', requireDM, (req, res) => {
    const t = tbody(req.body);
    const row: TemplateRow = { id: newId('tpl_'), world_id: W(res), name: t.name, npc_name: t.npcName, npc_blurb: t.npcBlurb, script: JSON.stringify(t.script), wander: t.wander, kind: t.kind, places: t.places, created_at: now(), updated_at: now() };
    if ((one<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM encounter_templates WHERE world_id = ?', row.world_id)!.n) >= 300) throw new HttpError(409, 'A world can keep at most 300 encounters');
    run(db, 'INSERT INTO encounter_templates (id, world_id, name, npc_name, npc_blurb, script, wander, kind, places, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', row.id, row.world_id, row.name, row.npc_name, row.npc_blurb, row.script, row.wander, row.kind, row.places, row.created_at, row.updated_at);
    audit(db, row.world_id, me(res), row.kind === 'event' ? 'encounter.event.create' : 'encounter.template.create', row.name);
    res.status(201).json(tview(row));
  });
  // Star or unstar one: { fav: true | false }. Works for saved and built-in ones.
  r.put('/templates/fav/:tid', requireDM, (req, res) => {
    const w = W(res);
    const t = templateFor(w, String(req.params.tid));
    if (req.body?.fav === false) run(db, 'DELETE FROM encounter_favs WHERE world_id = ? AND template_id = ?', w, t.id);
    else run(db, 'INSERT OR IGNORE INTO encounter_favs (world_id, template_id, at) VALUES (?, ?, ?)', w, t.id, now());
    res.json({ id: t.id, fav: req.body?.fav !== false });
  });
  r.put('/templates/all/:tid', requireDM, (req, res) => {
    const old = one<TemplateRow>(db, 'SELECT * FROM encounter_templates WHERE id = ? AND world_id = ?', String(req.params.tid), W(res));
    if (!old) throw new HttpError(404, 'Encounter template not found');
    const t = tbody(req.body);
    run(db, 'UPDATE encounter_templates SET name = ?, npc_name = ?, npc_blurb = ?, script = ?, wander = ?, kind = ?, places = ?, updated_at = ? WHERE id = ?', t.name, t.npcName, t.npcBlurb, JSON.stringify(t.script), t.wander, t.kind, t.places, now(), old.id);
    res.json(tview(one<TemplateRow>(db, 'SELECT * FROM encounter_templates WHERE id = ?', old.id)!));
  });
  r.delete('/templates/all/:tid', requireDM, (req, res) => {
    const n = run(db, 'DELETE FROM encounter_templates WHERE id = ? AND world_id = ?', String(req.params.tid), W(res));
    if (!n) throw new HttpError(404, 'Encounter template not found');
    run(db, 'DELETE FROM encounter_favs WHERE world_id = ? AND template_id = ?', W(res), String(req.params.tid));
    res.json({ ok: true });
  });

  return r;
}

const S = (description: string) => ({ type: 'string', description });
const enc = encodeURIComponent;
const tools: McpTool[] = [
  { name: 'list_encounters', dmOnly: true, description: 'DM: recent NPC encounters with players (open ones first to act on): the NPC, the player, the talk so far and where it stands.', props: { status: { type: 'string', enum: ['open', 'all'] } }, call: (a) => ({ method: 'GET', path: `/encounters${a.status === 'open' ? '?status=open' : ''}` }) },
  {
    name: 'list_encounter_templates', dmOnly: true,
    description: `DM: saved NPC encounters and quick events, and the built-in starters (NPCs: coin toss, shell game, arm-wrestling, dice duel, lost child, peddler; quick events: pickpocket, undervalued gem, lost purse, rope bridge, shrine ...), with ids for send_encounter. kind npc or event; place one of ${PLACES.join(', ')}.`,
    props: { kind: { type: 'string', enum: [...KINDS] }, place: { type: 'string', enum: [...PLACES] } },
    call: (a) => { const q = new URLSearchParams(); if (a?.kind) q.set('kind', String(a.kind)); if (a?.place) q.set('place', String(a.place)); const s = q.toString(); return { method: 'GET', path: `/encounters/templates/all${s ? `?${s}` : ''}` }; },
  },
  {
    name: 'send_encounter', write: true,
    description: "DM: have an NPC walk up to one or more players in their app, or a quick event happen to them. Either templateId (from list_encounter_templates), or place alone for a random quick event that fits it (town, road, woods, cave, dungeon ...), or npcName + line + answers for a quick one (kind 'event' for something that happens rather than someone talking). accountIds: player account ids, or 'party'. shopId: the shop a 'show me your wares' option opens.",
    props: { accountIds: { description: "Player account ids, or 'party'" }, templateId: S('Template or starter id'), place: { type: 'string', enum: [...PLACES], description: 'A random quick event for this place' }, from: { type: 'string', enum: ['fav', 'mine', 'builtin', 'any'], description: "With place (or alone): pick the random event from the DM's starred ones (fav), their saved ones (mine), the built-ins, or any" }, kind: { type: 'string', enum: [...KINDS] }, npcName: S('NPC name'), npcBlurb: S('What they look like'), line: S('What the NPC says (quick encounter)'), answers: { type: 'array', items: { type: 'string' }, description: 'Answers the player can pick (quick encounter)' }, shopId: S('Shop id'), addToPeople: { type: 'boolean', description: "Also put the NPC on the party's People list" } },
    required: ['accountIds'],
    call: (a) => ({ method: 'POST', path: '/encounters', body: { accountIds: a.accountIds, templateId: a.templateId, place: a.place, from: a.from, kind: a.kind, npcName: a.npcName, npcBlurb: a.npcBlurb, line: a.line, answers: a.answers, shopId: a.shopId, addToPeople: a.addToPeople } }),
  },
  {
    name: 'save_encounter_template', write: true,
    description: `DM: save a new NPC encounter or quick event for later (it does not send it). kind 'event' for a quick event: something that happens to a player (a thief, a find, a hazard), with places it fits (${PLACES.join(', ')}). script: {start, nodes: [{id, text, options: [{label, next: node id or null to end, effects: [{kind: gold|pay|lose, cp} | {kind: item, name, qty, note} | {kind: dmnote, text} | {kind: shop, shopId}]}], game: null or {kind: check, skill, dc, dcMax (optional: the DC is picked from dc..dcMax when the player rolls), stakeCp, winCp, win, lose}, timer (optional, only for urgent moments): {secs: 10-60, fallback: the option index picked when time runs out, or -1 to fail the check}}]}. Keep coin small (1 to 100 copper).`,
    props: { kind: { type: 'string', enum: [...KINDS] }, name: S('Short title'), npcName: S('Who or what it is about'), npcBlurb: S('One line: how it looks'), places: { type: 'array', items: { type: 'string', enum: [...PLACES] } }, script: { type: 'object', description: 'The steps (see the description)' }, wander: { type: 'boolean', description: 'Wandering players can meet it' } },
    required: ['name', 'script'],
    call: (a) => ({ method: 'POST', path: '/encounters/templates/all', body: { kind: a.kind, name: a.name, npcName: a.npcName, npcBlurb: a.npcBlurb, places: a.places, script: a.script, wander: a.wander } }),
  },
  { name: 'encounter_say', write: true, description: 'DM: speak as the NPC in an open encounter, with new answers for the player.', props: { id: S('Encounter id'), text: S('What the NPC says'), answers: { type: 'array', items: { type: 'string' } } }, required: ['id', 'text'], call: (a) => ({ method: 'POST', path: `/encounters/${enc(a.id)}/say`, body: { text: a.text, answers: a.answers } }) },
  { name: 'end_encounter', write: true, description: 'DM: end an open NPC encounter.', props: { id: S('Encounter id') }, required: ['id'], call: (a) => ({ method: 'POST', path: `/encounters/${enc(a.id)}/end`, body: {} }) },
];

const feature: Feature = {
  id: 'encounters',
  schema,
  migrate: (db) => {
    const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as any[]).map((c) => c.name);
    const ec = cols('encounters');
    if (!ec.includes('kind')) db.exec(`ALTER TABLE encounters ADD COLUMN kind TEXT NOT NULL DEFAULT 'npc'`);
    if (!ec.includes('step_seen_at')) db.exec(`ALTER TABLE encounters ADD COLUMN step_seen_at TEXT`);
    const tc = cols('encounter_templates');
    if (!tc.includes('kind')) db.exec(`ALTER TABLE encounter_templates ADD COLUMN kind TEXT NOT NULL DEFAULT 'npc'`);
    if (!tc.includes('places')) db.exec(`ALTER TABLE encounter_templates ADD COLUMN places TEXT NOT NULL DEFAULT '[]'`);
  },
  settings: {
    encounterWander: { type: 'boolean', default: false },
    encounterWanderMinutes: { type: 'int', default: 30, min: 0, max: 1440 },
    encounterRewardCapCp: { type: 'int', default: 1000, min: 0, max: 100_000 },
  },
  worldMount: 'encounters',
  worldRoutes: routes,
  mcpTools: tools,
};
export default feature;

// Roll20: keep a Roll20 game and this world in step.
//
// Roll20 has no public API, and its Mod (API) scripts run in a sandbox that
// cannot make network calls. So two small scripts carry the data:
//   - the Alexandria Mod script, installed in the Roll20 game (needs the
//     game creator's Pro plan). It is the only thing that reads and changes
//     the game: character HP, token status markers, rolls, handouts.
//   - the bridge, a userscript in the GM's browser on the Roll20 tab. It
//     talks to this server with a bridge key and to the Mod through chat
//     (hidden "!alx-in" commands one way, GM whispers the other way).
// Both are served by this feature (GET /files/...), so the GM installs them
// from the Roll20 page in Alexandria.
//
// What moves: HP, max HP and temporary HP of linked player characters (both
// ways), conditions ↔ token status markers (both ways), Roll20 rolls into the
// table chat (and table chat rolls into Roll20, if on), and library pages
// sent to Roll20 as handouts.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router, type Express, type Request, type Response } from 'express';
import { marked } from 'marked';
import type { Deps } from '../../app.ts';
import { requireDM } from '../../core/auth.ts';
import { combatViewFor } from '../../core/combatView.ts';
import { type DB, all, one, run, tx } from '../../core/db.ts';
import { dmAnd, only } from '../../core/events.ts';
import { DEFAULT_SETTINGS, featureSetting, type WorldSettings } from '../../core/policy.ts';
import { HttpError, now, parseJson, secret, sha256 } from '../../core/util.ts';
import { ctx, me, names, settings } from '../../routes/_shared.ts';
import { addMessage, canRead, currentSession, viewMessage } from '../sessionchat/chat.ts';
import { changeVitals, vitalsOf, type VitalsChange } from '../sheet/vitals.ts';
import type { Feature } from '../types.ts';
import {
  activity, agree, conditionsFromMarkers, firstTime, forget, guessAccount, linkOf, linksOf, markerMap, pendingPushes,
  rollFrom, validateMarkers, type R20Roll,
} from './sync.ts';

export const MOD_VERSION = '1.0.0';
const here = path.dirname(fileURLToPath(import.meta.url));
const FILES: Record<string, string> = { 'alexandria.mod.js': 'alexandria.mod.js', 'alexandria-bridge.user.js': 'alexandria-bridge.user.js' };
const KEY_PREFIX = 'alx_r20_';
/** A bridge seen within this long is "connected". */
const ONLINE_MS = 30_000;

const settingsOf = (db: DB, worldId: string): WorldSettings => ({ ...DEFAULT_SETTINGS, ...parseJson(one<any>(db, 'SELECT settings FROM worlds WHERE id = ?', worldId)?.settings ?? '{}', {}) });
const opt = <T,>(s: WorldSettings, k: string) => featureSetting<T>(s, k);

/** What the Mod needs to know to apply pushes and read the game. */
function modConfig(s: WorldSettings) {
  const map = markerMap(opt(s, 'roll20Markers'));
  return {
    hpAttr: opt<string>(s, 'roll20HpAttr') || 'hp',
    tempAttr: opt<string>(s, 'roll20TempAttr') || 'hp_temp',
    bar: opt<string>(s, 'roll20HpBar'),
    managed: [...new Set(Object.values(map))],
    rollsIn: opt<boolean>(s, 'roll20RollsIn'),
    hp: opt<boolean>(s, 'roll20Hp'),
    conditions: opt<boolean>(s, 'roll20Conditions'),
  };
}

const int = (v: unknown): number | null | undefined => (v === undefined ? undefined : v === null || v === '' ? null : Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : undefined);
const strList = (v: unknown, max = 40) => (Array.isArray(v) ? v.slice(0, max).map((x) => String(x ?? '').trim().slice(0, 60)).filter(Boolean) : []);

/** Sheet and combat screens refresh after a change from Roll20. */
function changed(d: Deps, worldId: string, aid: string, combat: boolean) {
  d.hub.emit(worldId, 'sheet', { accountId: aid }, dmAnd(aid));
  if (combat) { const s = settingsOf(d.db, worldId); d.hub.emitPer(worldId, 'combat', (v) => combatViewFor(d.db, worldId, v, s)); }
}

/** A Roll20 character (from a snapshot or a change) gets its link row; new ones are linked by name when that is clear. */
function upsertLink(db: DB, worldId: string, id: string, name: string, controlledBy: string[]) {
  const l = linkOf(db, worldId, id);
  if (l) {
    run(db, 'UPDATE roll20_links SET r20_name = ?, controlled_by = ?, seen_at = ? WHERE world_id = ? AND r20_id = ?', name || l.r20_name, JSON.stringify(controlledBy.length ? controlledBy : parseJson(l.controlled_by, [])), now(), worldId, id);
    return { link: linkOf(db, worldId, id)!, isNew: false };
  }
  const aid = guessAccount(db, worldId, name, controlledBy);
  run(db, 'INSERT INTO roll20_links (world_id, r20_id, r20_name, controlled_by, account_id, seen_at) VALUES (?, ?, ?, ?, ?, ?)', worldId, id, name.slice(0, 120), JSON.stringify(controlledBy), aid, now());
  if (aid) activity(db, worldId, 'in', `Linked ${name} to ${names(db, worldId)[aid] ?? 'a player'}`);
  return { link: linkOf(db, worldId, id)!, isNew: true };
}

/** One event from the Mod. Returns a short line for the activity list, or ''. */
function applyEvent(d: Deps, worldId: string, owner: string, s: WorldSettings, e: any): string {
  const db = d.db;
  const map = markerMap(opt(s, 'roll20Markers'));
  switch (e?.t) {
    case 'characters': {
      const list = Array.isArray(e.list) ? e.list.slice(0, 200) : [];
      for (const c of list) {
        if (typeof c?.id !== 'string' || !c.id) continue;
        const { link, isNew } = upsertLink(db, worldId, c.id, String(c.name ?? ''), strList(c.controlledBy));
        if (!isNew || !link.account_id) continue;
        // A new link: Roll20 fills in what Alexandria does not know yet; then Alexandria's numbers are pushed.
        const v = vitalsOf(db, worldId, link.account_id);
        const ch: VitalsChange = {};
        if (v.hp === null && int(c.hp) != null) ch.hp = int(c.hp)!;
        if (v.maxHp === null && int(c.maxHp) != null) ch.maxHp = int(c.maxHp)!;
        if (Object.keys(ch).length) { const out = changeVitals(db, worldId, link.account_id, ch, 'roll20', owner, 'From Roll20'); changed(d, worldId, link.account_id, out.combat); }
        forget(db, worldId, c.id);
      }
      return `Roll20 listed ${list.length} character${list.length === 1 ? '' : 's'}`;
    }
    case 'vitals':
    case 'markers': {
      if (typeof e.id !== 'string' || !e.id) return '';
      const { link } = upsertLink(db, worldId, e.id, String(e.name ?? ''), strList(e.controlledBy));
      if (!link.account_id) return '';
      const ch: VitalsChange = {};
      if (e.t === 'vitals' && opt<boolean>(s, 'roll20Hp')) {
        const hp = int(e.hp), max = int(e.maxHp), temp = int(e.tempHp);
        if (hp !== undefined) ch.hp = hp;
        if (max !== undefined) ch.maxHp = max;
        if (temp !== undefined && temp !== null) ch.setTempHp = Math.max(0, temp);
      }
      if (e.t === 'markers' && opt<boolean>(s, 'roll20Conditions')) {
        const cur = vitalsOf(db, worldId, link.account_id).conditions;
        const next = conditionsFromMarkers(cur, strList(e.markers), map);
        if (next.join('\n') !== cur.join('\n')) ch.conditions = next;
      }
      if (!Object.keys(ch).length) return '';
      const before = vitalsOf(db, worldId, link.account_id);
      const out = changeVitals(db, worldId, link.account_id, ch, 'roll20', owner, 'Roll20');
      // What Roll20 just told us is agreed: it is not sent back.
      agree(db, worldId, link.r20_id, out.after);
      changed(d, worldId, link.account_id, out.combat);
      const who = link.r20_name;
      if (e.t === 'markers') return `${who}: conditions ${out.after.conditions.join(', ') || 'none'}`;
      return `${who}: HP ${before.hp ?? '?'} → ${out.after.hp ?? '?'}${out.after.maxHp !== null ? `/${out.after.maxHp}` : ''}${out.after.tempHp ? ` (+${out.after.tempHp} temp)` : ''}`;
    }
    case 'roll': {
      if (!opt<boolean>(s, 'roll20RollsIn')) return '';
      const rolls: R20Roll[] = (Array.isArray(e.rolls) ? e.rolls : []).slice(0, 10)
        .map((r: any) => ({ expr: String(r?.expr ?? '').replace(/\s+/g, '').slice(0, 80), total: Number(r?.total), dice: (Array.isArray(r?.dice) ? r.dice : []).map(Number).filter(Number.isFinite).slice(0, 100) }))
        .filter((r: R20Roll) => r.expr && Number.isFinite(r.total));
      if (!rolls.length) return '';
      const sess = currentSession(db, worldId);
      if (!sess) return '';
      // The roller: the linked character's player, else a player with that display name, else the GM (named in the text).
      let author = (typeof e.characterId === 'string' && linkOf(db, worldId, e.characterId)?.account_id) || null;
      const who = String(e.who ?? '').slice(0, 60);
      if (!author) {
        const n = String(e.player ?? '').trim().toLowerCase();
        const p = all<any>(db, "SELECT m.account_id, a.display_name, m.character_name FROM members m JOIN accounts a ON a.id = m.account_id WHERE m.world_id = ? AND m.role = 'player'", worldId)
          .filter((m) => [m.display_name, m.character_name].some((x) => typeof x === 'string' && x.trim().toLowerCase() === (n || who.toLowerCase())));
        if (p.length === 1) author = p[0].account_id;
      }
      const label = String(e.label ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
      const roll = rollFrom(rolls, [author ? '' : who, label, 'Roll20'].filter(Boolean).join(' · '));
      const role = author ? 'player' : 'dm';
      const row = addMessage(db, worldId, { sessionId: sess.id, channel: 'table', authorId: author ?? owner, role, body: `/roll ${roll.expr} ${roll.note}`.slice(0, 2000), roll });
      firstTime(db, worldId, `msg:${row.id}`);
      for (const m of all<any>(db, 'SELECT account_id, role FROM members WHERE world_id = ?', worldId)) {
        const v = { accountId: m.account_id, role: m.role };
        if (canRead(v, 'table')) d.hub.emit(worldId, 'chat', { type: 'new', channel: 'table', sessionId: row.session_id, message: viewMessage(db, row, v, worldId) }, only(v.accountId));
      }
      return `${who || 'Someone'} rolled ${roll.expr} = ${roll.total}${label ? ` (${label})` : ''}`;
    }
    default:
      return '';
  }
}

/** Table chat rolls made in Alexandria since the last sync (not the ones that came from Roll20). */
function rollsOut(db: DB, worldId: string, cursor: string | null) {
  if (!cursor) return { rolls: [] as any[], cursor: now() };
  const rows = all<any>(db, `SELECT * FROM sessionchat_messages WHERE world_id = ? AND channel = 'table' AND kind = 'roll' AND deleted_at IS NULL AND hidden_at IS NULL AND at > ?
    AND NOT EXISTS (SELECT 1 FROM roll20_seen s WHERE s.world_id = ? AND s.key = 'msg:' || sessionchat_messages.id) ORDER BY at LIMIT 20`, worldId, cursor, worldId);
  if (!rows.length) return { rolls: [], cursor };
  const nm = names(db, worldId);
  return {
    rolls: rows.map((m) => { const r = parseJson<any>(m.roll, {}); return { who: nm[m.author_id] ?? 'Someone', expr: r.expr, total: r.total, note: r.note ?? '', dice: (r.terms ?? []).flatMap((t: any) => t.dice ?? []) }; }),
    cursor: rows[rows.length - 1].at as string,
  };
}

/** A library page as handout HTML. Wiki links become plain text (Roll20 cannot open them). */
const pageHtml = (md: string) => String(marked.parse(md.replace(/\[\[(?:page:)?([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, a, b) => b || a), { async: false }));

function queue(db: DB, worldId: string, kind: string, payload: unknown) {
  run(db, 'INSERT INTO roll20_outbox (world_id, kind, payload, created_at) VALUES (?, ?, ?, ?)', worldId, kind, JSON.stringify(payload), now());
}

function bridgeOf(db: DB, req: Request) {
  const h = req.get('authorization') ?? '';
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (!token.startsWith(KEY_PREFIX)) throw new HttpError(401, 'Send the Roll20 bridge key');
  const b = one<any>(db, 'SELECT * FROM roll20_bridges WHERE key_hash = ?', sha256(token));
  if (!b) throw new HttpError(401, 'That Roll20 bridge key is not valid (made a new one?)');
  // The key belongs to a GM; a GM who lost the world loses the bridge.
  if (!one(db, "SELECT 1 FROM members WHERE world_id = ? AND account_id = ? AND role = 'dm'", b.world_id, b.created_by)) throw new HttpError(403, 'The GM who made this key no longer runs the world');
  run(db, 'UPDATE roll20_bridges SET last_seen_at = ? WHERE world_id = ?', now(), b.world_id);
  return b;
}

function bridgeRoutes(app: Express, d: Deps) {
  const { db } = d;
  const r = Router();

  r.post('/hello', (req, res) => {
    const b = bridgeOf(db, req);
    const w = one<any>(db, 'SELECT name FROM worlds WHERE id = ?', b.world_id);
    const mod = String(req.body?.modVersion ?? '').slice(0, 20) || null;
    const campaign = String(req.body?.campaign ?? '').slice(0, 120) || null;
    // 'mod': the Alexandria Mod script does the work (Roll20 Pro); 'free': the bridge does it alone in the GM's tab.
    const mode = req.body?.mode === 'mod' || req.body?.mode === 'free' ? req.body.mode : null;
    run(db, 'UPDATE roll20_bridges SET mod_version = CASE WHEN ? = \'free\' THEN NULL ELSE COALESCE(?, mod_version) END, campaign = COALESCE(?, campaign), mode = COALESCE(?, mode) WHERE world_id = ?', mode, mod, campaign, mode, b.world_id);
    d.hub.emit(b.world_id, 'roll20', {}, (v) => v.role === 'dm');
    res.json({ world: w?.name ?? '', modVersion: MOD_VERSION, config: modConfig(settingsOf(db, b.world_id)) });
  });

  // Events from the Mod, in order: { instance, events: [{ seq, t, ... }] }.
  r.post('/events', (req, res) => {
    const b = bridgeOf(db, req);
    const instance = String(req.body?.instance ?? '').slice(0, 40);
    const events = Array.isArray(req.body?.events) ? req.body.events.slice(0, 100) : [];
    if (!instance) throw new HttpError(400, 'instance is required');
    const s = settingsOf(db, b.world_id);
    let acked = 0;
    let lines = 0;
    for (const e of events) {
      const seq = Number(e?.seq);
      if (!Number.isInteger(seq) || seq < 0) continue;
      acked = Math.max(acked, seq);
      try {
        const line = tx(db, () => (firstTime(db, b.world_id, `ev:${instance}:${seq}`) ? applyEvent(d, b.world_id, b.created_by, s, e) : ''));
        if (line) { activity(db, b.world_id, 'in', line); lines++; }
      } catch (err: any) {
        activity(db, b.world_id, 'in', `Skipped a ${String(e?.t ?? 'bad')} event: ${err?.message ?? err}`);
      }
    }
    if (lines) d.hub.emit(b.world_id, 'roll20', {}, (v) => v.role === 'dm');
    res.json({ acked });
  });

  // What Roll20 should do now: HP and marker pushes, handouts, chat lines and rolls.
  r.post('/sync', (req, res) => {
    const b = bridgeOf(db, req);
    const w = b.world_id;
    const s = settingsOf(db, w);
    const out = tx(db, () => {
      const pushes = pendingPushes(db, w, markerMap(opt(s, 'roll20Markers')), { hp: opt<boolean>(s, 'roll20Hp'), conditions: opt<boolean>(s, 'roll20Conditions') });
      const items = all<any>(db, 'SELECT * FROM roll20_outbox WHERE world_id = ? AND sent_at IS NULL ORDER BY id LIMIT 20', w)
        .map((x) => ({ id: x.id, kind: x.kind, ...parseJson<any>(x.payload, {}) }));
      for (const x of items) run(db, 'UPDATE roll20_outbox SET sent_at = ? WHERE id = ?', now(), x.id);
      run(db, 'DELETE FROM roll20_outbox WHERE world_id = ? AND sent_at IS NOT NULL AND sent_at < ?', w, new Date(Date.now() - 864e5).toISOString());
      let rolls: any[] = [];
      if (opt<boolean>(s, 'roll20RollsOut')) {
        const r = rollsOut(db, w, b.roll_cursor);
        rolls = r.rolls;
        run(db, 'UPDATE roll20_bridges SET roll_cursor = ? WHERE world_id = ?', r.cursor, w);
      } else run(db, 'UPDATE roll20_bridges SET roll_cursor = ? WHERE world_id = ?', now(), w);
      return { pushes, items, rolls };
    });
    for (const p of out.pushes) activity(db, w, 'out', `${p.name}: ${[p.hp !== undefined ? `HP ${p.hp}${p.maxHp != null ? `/${p.maxHp}` : ''}` : p.maxHp !== undefined ? `max HP ${p.maxHp}` : '', p.markers ? `markers ${p.markers.join(', ') || 'none'}` : ''].filter(Boolean).join(', ') || 'temporary HP'}`);
    for (const x of out.items) activity(db, w, 'out', x.kind === 'handout' ? `Handout "${x.name}"` : `Said: ${String(x.text ?? '').slice(0, 80)}`);
    if (out.pushes.length || out.items.length) d.hub.emit(w, 'roll20', {}, (v) => v.role === 'dm');
    res.json({ config: modConfig(s), ...out });
  });

  app.use('/api/roll20/bridge', r);
}

function worldRoutes(d: Deps) {
  const r = Router({ mergeParams: true });
  const { db } = d;
  const W = (res: Response) => ctx(res).world.id;
  r.use(requireDM);

  r.get('/', (_req, res) => {
    const w = W(res);
    const b = one<any>(db, 'SELECT prefix, created_at, last_seen_at, mod_version, campaign, mode FROM roll20_bridges WHERE world_id = ?', w);
    const nm = names(db, w);
    res.json({
      key: b ? { prefix: b.prefix, createdAt: b.created_at } : null,
      lastSeen: b?.last_seen_at ?? null,
      online: !!b?.last_seen_at && Date.now() - new Date(b.last_seen_at).getTime() < ONLINE_MS,
      modVersion: b?.mod_version ?? null,
      mode: (b?.mode ?? null) as 'mod' | 'free' | null,
      latestModVersion: MOD_VERSION,
      campaign: b?.campaign ?? null,
      links: linksOf(db, w).map((l) => ({ id: l.r20_id, name: l.r20_name, controlledBy: parseJson(l.controlled_by, []), accountId: l.account_id, player: l.account_id ? nm[l.account_id] ?? null : null, seenAt: l.seen_at })),
      markers: markerMap(opt(settings(res), 'roll20Markers')),
      activity: all<any>(db, 'SELECT dir, text, at FROM roll20_activity WHERE world_id = ? ORDER BY id DESC LIMIT 50', w),
    });
  });

  // A new bridge key (shown once). It replaces the old one, which stops working.
  r.post('/key', (_req, res) => {
    const w = W(res);
    const key = secret(KEY_PREFIX);
    run(db, `INSERT INTO roll20_bridges (world_id, key_hash, prefix, created_by, created_at, roll_cursor) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (world_id) DO UPDATE SET key_hash = excluded.key_hash, prefix = excluded.prefix, created_by = excluded.created_by, created_at = excluded.created_at, last_seen_at = NULL, roll_cursor = excluded.roll_cursor`,
    w, sha256(key), key.slice(0, KEY_PREFIX.length + 4), me(res), now(), now());
    run(db, 'INSERT INTO audit (world_id, account_id, action, detail, at) VALUES (?, ?, ?, ?, ?)', w, me(res), 'roll20.key', '', now());
    res.status(201).json({ key });
  });

  r.delete('/key', (_req, res) => {
    run(db, 'DELETE FROM roll20_bridges WHERE world_id = ?', W(res));
    res.json({ ok: true });
  });

  // Link a Roll20 character to a player (or null to unlink). Alexandria's numbers are pushed to it next.
  r.put('/links/:id', (req, res) => {
    const w = W(res);
    const l = linkOf(db, w, String(req.params.id));
    if (!l) throw new HttpError(404, 'Roll20 has not told us about that character yet');
    const aid = req.body?.accountId === null || req.body?.accountId === '' ? null : String(req.body?.accountId ?? '');
    if (aid && !one(db, "SELECT 1 FROM members WHERE world_id = ? AND account_id = ? AND role = 'player'", w, aid)) throw new HttpError(400, 'Pick a player of this world');
    run(db, 'UPDATE roll20_links SET account_id = ? WHERE world_id = ? AND r20_id = ?', aid, w, l.r20_id);
    forget(db, w, l.r20_id);
    d.hub.emit(w, 'roll20', {}, (v) => v.role === 'dm');
    res.json({ ok: true });
  });

  // Send Alexandria's HP and conditions to Roll20 again (all linked characters, or one).
  r.post('/push', (req, res) => {
    forget(db, W(res), typeof req.body?.id === 'string' ? req.body.id : undefined);
    res.json({ ok: true, queued: linksOf(db, W(res)).filter((l) => l.account_id).length });
  });

  // A library page as a Roll20 handout. players: in every player's journal (needs the page's player copy).
  r.post('/handout', (req, res) => {
    const w = W(res);
    const ref = String(req.body?.page ?? '').trim();
    if (!ref) throw new HttpError(400, 'page is required (its id or title)');
    const pg = one<any>(db, 'SELECT * FROM pages WHERE world_id = ? AND id = ?', w, ref)
      ?? one<any>(db, 'SELECT * FROM pages WHERE world_id = ? AND title = ? COLLATE NOCASE ORDER BY updated_at DESC LIMIT 1', w, ref);
    if (!pg) throw new HttpError(404, 'No page with that id or title');
    const players = req.body?.players === true;
    const shared = pg.visibility === 'party' && pg.player_body !== null;
    if (players && !shared) throw new HttpError(409, 'Share the page with the players first: the handout shows them their copy');
    queue(db, w, 'handout', {
      name: String(req.body?.name ?? pg.title).slice(0, 120),
      notes: pageHtml(players ? pg.player_body : pg.body),
      gmnotes: players ? pageHtml(pg.body) : '',
      players,
    });
    run(db, 'INSERT INTO audit (world_id, account_id, action, detail, at) VALUES (?, ?, ?, ?, ?)', w, me(res), 'roll20.handout', pg.title, now());
    res.status(202).json({ queued: true, name: pg.title, players });
  });

  // A line in the Roll20 chat, from "Alexandria".
  r.post('/say', (req, res) => {
    const text = String(req.body?.text ?? '').trim();
    if (!text || text.length > 1000) throw new HttpError(400, 'text must be 1 to 1000 characters');
    queue(db, W(res), 'say', { text, as: String(req.body?.as ?? '').slice(0, 60) || null });
    res.status(202).json({ queued: true });
  });

  // The two scripts the GM installs, as text.
  r.get('/files/:name', (req, res) => {
    const f = FILES[String(req.params.name)];
    if (!f) throw new HttpError(404, 'No such file');
    res.json({ name: f, text: fs.readFileSync(path.join(here, 'client', f), 'utf8') });
  });

  return r;
}

const feature: Feature = {
  id: 'roll20',
  schema: `
    CREATE TABLE IF NOT EXISTS roll20_bridges (
      world_id TEXT PRIMARY KEY REFERENCES worlds(id) ON DELETE CASCADE,
      key_hash TEXT NOT NULL UNIQUE,
      prefix TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_seen_at TEXT,
      mod_version TEXT,
      campaign TEXT,
      roll_cursor TEXT,
      mode TEXT
    );
    CREATE TABLE IF NOT EXISTS roll20_links (
      world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
      r20_id TEXT NOT NULL,
      r20_name TEXT NOT NULL DEFAULT '',
      controlled_by TEXT NOT NULL DEFAULT '[]',
      account_id TEXT,
      last_hp INTEGER,
      last_max INTEGER,
      last_temp INTEGER,
      last_conditions TEXT,
      seen_at TEXT NOT NULL,
      PRIMARY KEY (world_id, r20_id)
    );
    CREATE TABLE IF NOT EXISTS roll20_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      sent_at TEXT
    );
    CREATE INDEX IF NOT EXISTS roll20_outbox_world ON roll20_outbox(world_id, sent_at, id);
    CREATE TABLE IF NOT EXISTS roll20_seen (
      world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      at TEXT NOT NULL,
      PRIMARY KEY (world_id, key)
    );
    CREATE TABLE IF NOT EXISTS roll20_activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
      dir TEXT NOT NULL,
      text TEXT NOT NULL,
      at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS roll20_activity_world ON roll20_activity(world_id, id);
  `,
  settings: {
    roll20Hp: { type: 'boolean', default: true },
    roll20Conditions: { type: 'boolean', default: true },
    roll20RollsIn: { type: 'boolean', default: true },
    roll20RollsOut: { type: 'boolean', default: false },
    roll20HpAttr: { type: 'string', default: 'hp', max: 60 },
    roll20TempAttr: { type: 'string', default: 'hp_temp', max: 60 },
    roll20HpBar: { type: 'enum', default: 'bar1', values: ['bar1', 'bar2', 'bar3'] },
    roll20Markers: { type: 'json', default: {}, validate: validateMarkers },
  },
  migrate: (db) => {
    const cols = all<any>(db, 'PRAGMA table_info(roll20_bridges)').map((c) => c.name);
    if (!cols.includes('mode')) db.exec('ALTER TABLE roll20_bridges ADD COLUMN mode TEXT');
  },
  worldMount: 'roll20',
  worldRoutes,
  appRoutes: bridgeRoutes,
  mcpTools: [
    {
      name: 'roll20_status', dmOnly: true,
      description: 'The Roll20 connection: whether the bridge is online, which Roll20 characters are linked to which players, and the latest things that moved between Roll20 and Alexandria.',
      props: {}, call: () => ({ method: 'GET', path: '/roll20' }),
    },
    {
      name: 'roll20_send_handout', write: true,
      description: 'Send a library page to the Roll20 game as a handout. players true puts it in every player\'s journal (the page must be shared with players; they see the player copy); false makes it a GM-only handout.',
      props: { page: { type: 'string', description: 'The page id or exact title' }, players: { type: 'boolean', default: false } },
      required: ['page'],
      call: (a) => ({ method: 'POST', path: '/roll20/handout', body: { page: a.page, players: a.players === true } }),
    },
    {
      name: 'roll20_say', write: true,
      description: 'Post a line in the Roll20 game chat, from "Alexandria" (or a name given in as, e.g. an NPC).',
      props: { text: { type: 'string' }, as: { type: 'string', description: 'Speaker name shown in Roll20 (optional)' } },
      required: ['text'],
      call: (a) => ({ method: 'POST', path: '/roll20/say', body: { text: a.text, as: a.as } }),
    },
  ],
};
export default feature;

// Foundry VTT: keep a Foundry world and this world in step.
//
// Foundry is self-hosted and its modules run in the browser with full network
// access, so one small module does it all: the Alexandria Bridge module,
// served by this feature as a Foundry manifest (GET /api/foundry/module.json)
// so the GM installs it in Foundry by URL. In the GM's Foundry tab it talks to
// this server with a bridge key (/api/foundry/bridge/*, open to any origin:
// the key is the only way in, no cookies). In every player's tab it only
// draws Alexandria's fog over the scene.
//
// What moves:
//   - HP, max HP and temporary HP of linked actors, both ways; conditions ↔
//     actor status effects, both ways.
//   - Maps: a Foundry scene's picture comes into the library as a map (and the
//     scene is linked to that Alexandria map), or an Alexandria map picture
//     becomes a new Foundry scene.
//   - Tokens on a linked scene show on the Alexandria map (moved live, hidden
//     ones only for the GM, fog hides the rest like any mark). The GM, or a
//     player for their own character, can move a token from Alexandria.
//   - Fog: Alexandria's fog of the linked map picture is drawn over the scene
//     in Foundry; player tokens that move in Foundry uncover fog around them.
//   - Rolls in the Foundry chat → table chat (and back, if on), library pages
//     → journal entries, chat lines.
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import express, { Router, type Express, type Request, type Response } from 'express';
import { marked } from 'marked';
import type { Deps } from '../../app.ts';
import { requireGM, requirePlayerOrGM } from '../../core/auth.ts';
import { combatViewFor } from '../../core/combatView.ts';
import { type DB, all, one, run, tx } from '../../core/db.ts';
import { gmAnd, only } from '../../core/events.ts';
import { FOG_ASPECT, fogLayers, markUnderFog } from '../../core/fog.ts';
import { safePagePath } from '../../core/library.ts';
import { DEFAULT_SETTINGS, featureSetting, type Viewer, type WorldSettings } from '../../core/policy.ts';
import { HttpError, id as newId, now, parseJson, secret, sha256 } from '../../core/util.ts';
import { writeZip } from '../../core/zipstream.ts';
import { imageVisibleTo } from '../../intake/records.ts';
import { ctx, isGM, me, names, settings } from '../../routes/_shared.ts';
import { fogOf, saveFog } from '../fog/index.ts';
import { maxBytes, mayRead } from '../libfiles/index.ts';
import { sniffFile } from '../libfiles/sniff.ts';
import { addMessage, canRead, currentSession, viewMessage } from '../sessionchat/chat.ts';
import { changeVitals, vitalsOf, type VitalsChange } from '../sheet/vitals.ts';
import type { Feature } from '../types.ts';
import {
  activity, agree, conditionsFromStatuses, firstTime, forget, guessAccount, linkOf, linksOf, mapIdFor, pendingPushes, pos,
  revealAround, rollFrom, samePos, statusMap, validateStatuses, type FRoll,
} from './sync.ts';

export const MODULE_ID = 'alexandria-bridge';
export const MODULE_VERSION = '1.0.0';
const here = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.join(here, 'client');
const KEY_PREFIX = 'alx_fvtt_';
/** A bridge seen within this long is "connected". */
const ONLINE_MS = 30_000;
const PIC_RE = /^(lib|imp):[A-Za-z0-9_-]{1,80}$/;

const settingsOf = (db: DB, worldId: string): WorldSettings => ({ ...DEFAULT_SETTINGS, ...parseJson(one<any>(db, 'SELECT settings FROM worlds WHERE id = ?', worldId)?.settings ?? '{}', {}) });
const opt = <T,>(s: WorldSettings, k: string) => featureSetting<T>(s, k);
const gmOnly = (v: { role: string }) => v.role === 'gm';

const int = (v: unknown): number | null | undefined => (v === undefined ? undefined : v === null || v === '' ? null : Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : undefined);
const strList = (v: unknown, max = 40) => (Array.isArray(v) ? v.slice(0, max).map((x) => String(x ?? '').trim().slice(0, 60)).filter(Boolean) : []);
const text = (v: unknown, max: number) => String(v ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, max);

interface SceneRow { world_id: string; scene_id: string; name: string; img: string | null; width: number | null; height: number | null; grid_frac: number | null; active: number; map_id: string | null; pic: string | null; fog_sent: number; seen_at: string }
const sceneOf = (db: DB, w: string, id: string) => one<SceneRow>(db, 'SELECT * FROM foundry_scenes WHERE world_id = ? AND scene_id = ?', w, id);
const scenesOf = (db: DB, w: string) => all<SceneRow>(db, 'SELECT * FROM foundry_scenes WHERE world_id = ? ORDER BY active DESC, name COLLATE NOCASE', w);

/** What the module needs to know to apply pushes and read the game. */
function moduleConfig(db: DB, w: string, s: WorldSettings) {
  const map = statusMap(opt(s, 'foundryStatuses'));
  return {
    hpPath: opt<string>(s, 'foundryHpPath') || 'system.attributes.hp.value',
    maxPath: opt<string>(s, 'foundryMaxPath') || 'system.attributes.hp.max',
    tempPath: opt<string>(s, 'foundryTempPath') || 'system.attributes.hp.temp',
    managed: [...new Set(Object.values(map))],
    hp: opt<boolean>(s, 'foundryHp'),
    conditions: opt<boolean>(s, 'foundryConditions'),
    tokens: opt<boolean>(s, 'foundryTokens'),
    fog: opt<boolean>(s, 'foundryFog'),
    rollsIn: opt<boolean>(s, 'foundryRollsIn'),
    /** Scenes linked to an Alexandria map: the module sends their tokens. */
    scenes: scenesOf(db, w).filter((x) => x.map_id).map((x) => x.scene_id),
  };
}

/** Sheet and combat screens refresh after a change from Foundry. */
function changed(d: Deps, worldId: string, aid: string, combat: boolean) {
  d.hub.emit(worldId, 'sheet', { accountId: aid }, gmAnd(aid));
  if (combat) { const s = settingsOf(d.db, worldId); d.hub.emitPer(worldId, 'combat', (v) => combatViewFor(d.db, worldId, v, s)); }
}
const ping = (d: Deps, w: string) => d.hub.emit(w, 'foundry', {}, gmOnly);

function queue(db: DB, worldId: string, kind: string, payload: unknown): number {
  run(db, 'INSERT INTO foundry_outbox (world_id, kind, payload, created_at) VALUES (?, ?, ?, ?)', worldId, kind, JSON.stringify(payload), now());
  return Number(one<any>(db, 'SELECT last_insert_rowid() AS id')!.id);
}

/** A Foundry actor (from a snapshot or a change) gets its link row; new ones are linked by name when that is clear. */
function upsertActor(db: DB, worldId: string, id: string, name: string, owners: string[]) {
  const l = linkOf(db, worldId, id);
  if (l) {
    run(db, 'UPDATE foundry_actors SET name = ?, owners = ?, seen_at = ? WHERE world_id = ? AND actor_id = ?', name || l.name, JSON.stringify(owners.length ? owners : parseJson(l.owners, [])), now(), worldId, id);
    return { link: linkOf(db, worldId, id)!, isNew: false };
  }
  const aid = guessAccount(db, worldId, name, owners);
  run(db, 'INSERT INTO foundry_actors (world_id, actor_id, name, owners, account_id, seen_at) VALUES (?, ?, ?, ?, ?, ?)', worldId, id, name.slice(0, 120), JSON.stringify(owners), aid, now());
  if (aid) activity(db, worldId, 'in', `Linked ${name} to ${names(db, worldId)[aid] ?? 'a player'}`);
  return { link: linkOf(db, worldId, id)!, isNew: true };
}

// ---- tokens: map marks (kind 'pin' with data.token) on the linked map ----

interface TokenRow { world_id: string; scene_id: string; token_id: string; mark_id: string; want_x: number | null; want_y: number | null }

/** Tell the screens a token mark changed: the GM always, players only when it is not hidden and not under fog (before or after). */
function emitMark(d: Deps, w: string, mapId: string, markId: string, hidden: boolean, at: { x: number; y: number }[]) {
  const fog = fogLayers(d.db, w, mapId);
  const seen = !hidden && at.some((p) => !markUnderFog(fog, { kind: 'pin', data: p }));
  d.hub.emit(w, 'map-mark', { id: markId, map_id: mapId }, (v) => v.role === 'gm' || seen);
}

function dropToken(d: Deps, w: string, t: TokenRow) {
  const m = one<any>(d.db, 'SELECT map_id FROM map_marks WHERE id = ?', t.mark_id);
  run(d.db, 'DELETE FROM map_marks WHERE id = ?', t.mark_id);
  run(d.db, 'DELETE FROM foundry_tokens WHERE world_id = ? AND scene_id = ? AND token_id = ?', w, t.scene_id, t.token_id);
  if (m) d.hub.emit(w, 'map-mark-removed', { id: t.mark_id }, () => true);
}

/** Every token mark of a scene goes (the scene was unlinked, relinked or deleted). */
function dropTokens(d: Deps, w: string, sceneId: string) {
  for (const t of all<TokenRow>(d.db, 'SELECT * FROM foundry_tokens WHERE world_id = ? AND scene_id = ?', w, sceneId)) dropToken(d, w, t);
}

/** Uncover the fog around a player token, when the GM turned that on. */
function reveal(d: Deps, w: string, sc: SceneRow, p: { x: number; y: number }, s: WorldSettings): boolean {
  if (!opt<boolean>(s, 'foundryFog') || !sc.map_id || !sc.pic) return false;
  const op = revealAround(p, opt<number>(s, 'foundryRevealSquares') ?? 0, sc.grid_frac);
  if (!op) return false;
  const f = fogOf(d, w, sc.map_id, sc.pic);
  if (!f.enabled) return false;
  saveFog(d, w, sc.map_id, sc.pic, { enabled: true, base: f.base, ops: [...f.ops, op] });
  return true;
}

/** One token from Foundry onto the map. Returns whether it moved (or is new). */
function upsertToken(d: Deps, w: string, owner: string, sc: SceneRow, t: any, s: WorldSettings): { moved: boolean; name: string } | null {
  const db = d.db;
  if (!sc.map_id || typeof t?.id !== 'string' || !t.id) return null;
  const p = pos(t.x, t.y);
  if (!p) return null;
  const row = one<TokenRow>(db, 'SELECT * FROM foundry_tokens WHERE world_id = ? AND scene_id = ? AND token_id = ?', w, sc.scene_id, t.id);
  const actor = typeof t.actorId === 'string' && t.actorId ? t.actorId.slice(0, 60) : null;
  const link = actor ? linkOf(db, w, actor) : null;
  const name = text(t.name, 80) || 'Token';
  const size = Math.min(1, Math.max(0, Number(t.w) || 0));
  const disposition = [-1, 0, 1].includes(Number(t.disposition)) ? Number(t.disposition) : 0;
  const hidden = t.hidden === true;
  const mark = row ? one<any>(db, 'SELECT * FROM map_marks WHERE id = ?', row.mark_id) : null;
  // A move Alexandria asked for and Foundry has not made yet wins over an older position from Foundry.
  const at = row && row.want_x !== null && row.want_y !== null ? { x: row.want_x, y: row.want_y } : p;
  const data = { x: at.x, y: at.y, label: name, token: { scene: sc.scene_id, id: t.id, actor, account: link?.account_id ?? null, size, disposition, player: t.player === true } };
  if (mark) {
    const old = parseJson<any>(mark.data, {});
    const moved = !samePos(old, at);
    if (JSON.stringify(old) === JSON.stringify(data) && !!mark.hidden_by_gm === hidden && mark.map_id === sc.map_id) return { moved: false, name };
    run(db, 'UPDATE map_marks SET data = ?, hidden_by_gm = ?, map_id = ? WHERE id = ?', JSON.stringify(data), hidden ? 1 : 0, sc.map_id, mark.id);
    emitMark(d, w, sc.map_id, mark.id, hidden && !!mark.hidden_by_gm, [old, at]);
    return { moved, name };
  }
  if (row) run(db, 'DELETE FROM foundry_tokens WHERE world_id = ? AND scene_id = ? AND token_id = ?', w, sc.scene_id, t.id);
  const id = newId('mk_');
  run(db, "INSERT INTO map_marks (id, world_id, map_id, author_id, kind, data, visibility, hidden_by_gm, created_at) VALUES (?, ?, ?, ?, 'pin', ?, 'party', ?, ?)", id, w, sc.map_id, owner, JSON.stringify(data), hidden ? 1 : 0, now());
  run(db, 'INSERT INTO foundry_tokens (world_id, scene_id, token_id, mark_id) VALUES (?, ?, ?, ?)', w, sc.scene_id, t.id, id);
  emitMark(d, w, sc.map_id, id, hidden, [at]);
  return { moved: true, name };
}

/** One event from the module. Returns a short line for the activity list, or ''. */
function applyEvent(d: Deps, w: string, owner: string, s: WorldSettings, e: any): string {
  const db = d.db;
  const map = statusMap(opt(s, 'foundryStatuses'));
  switch (e?.t) {
    case 'actors': {
      const list = Array.isArray(e.list) ? e.list.slice(0, 300) : [];
      for (const a of list) {
        if (typeof a?.id !== 'string' || !a.id) continue;
        const { link, isNew } = upsertActor(db, w, a.id.slice(0, 60), text(a.name, 120), strList(a.owners));
        if (!isNew || !link.account_id) continue;
        // A new link: Foundry fills in what Alexandria does not know yet; then Alexandria's numbers are pushed.
        const v = vitalsOf(db, w, link.account_id);
        const ch: VitalsChange = {};
        if (v.hp === null && int(a.hp) != null) ch.hp = int(a.hp)!;
        if (v.maxHp === null && int(a.maxHp) != null) ch.maxHp = int(a.maxHp)!;
        if (Object.keys(ch).length) { const out = changeVitals(db, w, link.account_id, ch, 'foundry', owner, 'From Foundry'); changed(d, w, link.account_id, out.combat); }
        forget(db, w, link.actor_id);
      }
      return `Foundry listed ${list.length} actor${list.length === 1 ? '' : 's'}`;
    }
    case 'actor': {
      if (typeof e.id !== 'string' || !e.id) return '';
      const { link } = upsertActor(db, w, e.id.slice(0, 60), text(e.name, 120), strList(e.owners));
      if (!link.account_id) return '';
      const cur = vitalsOf(db, w, link.account_id);
      const ch: VitalsChange = {};
      if (opt<boolean>(s, 'foundryHp')) {
        const hp = int(e.hp), max = int(e.maxHp), temp = int(e.tempHp);
        if (hp !== undefined && hp !== null && hp !== cur.hp) ch.hp = hp;
        if (max !== undefined && max !== null && max !== cur.maxHp) ch.maxHp = max;
        if (temp !== undefined && temp !== null && Math.max(0, temp) !== cur.tempHp) ch.setTempHp = Math.max(0, temp);
      }
      if (opt<boolean>(s, 'foundryConditions') && Array.isArray(e.statuses)) {
        const next = conditionsFromStatuses(cur.conditions, strList(e.statuses, 80), map);
        if (next.join('\n') !== cur.conditions.join('\n')) ch.conditions = next;
      }
      if (!Object.keys(ch).length) return '';
      const out = changeVitals(db, w, link.account_id, ch, 'foundry', owner, 'Foundry');
      // What Foundry just told us is agreed: it is not sent back.
      agree(db, w, link.actor_id, out.after);
      changed(d, w, link.account_id, out.combat);
      const parts = [
        ch.hp !== undefined || ch.maxHp !== undefined || ch.setTempHp !== undefined ? `HP ${cur.hp ?? '?'} → ${out.after.hp ?? '?'}${out.after.maxHp !== null ? `/${out.after.maxHp}` : ''}${out.after.tempHp ? ` (+${out.after.tempHp} temp)` : ''}` : '',
        ch.conditions ? `conditions ${out.after.conditions.join(', ') || 'none'}` : '',
      ].filter(Boolean);
      return `${link.name}: ${parts.join(', ')}`;
    }
    case 'scenes': {
      const list = (Array.isArray(e.list) ? e.list.slice(0, 300) : []).filter((x: any) => typeof x?.id === 'string' && x.id);
      const ids = new Set<string>();
      for (const x of list) {
        const id = String(x.id).slice(0, 60);
        ids.add(id);
        const gf = Number(x.gridFrac);
        const vals = [text(x.name, 120) || 'Scene', typeof x.img === 'string' ? x.img.slice(0, 500) : null, int(x.width) ?? null, int(x.height) ?? null, Number.isFinite(gf) && gf > 0 && gf <= 1 ? gf : null, x.active === true ? 1 : 0, now()];
        if (sceneOf(db, w, id)) run(db, 'UPDATE foundry_scenes SET name = ?, img = ?, width = ?, height = ?, grid_frac = ?, active = ?, seen_at = ? WHERE world_id = ? AND scene_id = ?', ...vals, w, id);
        else run(db, 'INSERT INTO foundry_scenes (name, img, width, height, grid_frac, active, seen_at, world_id, scene_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', ...vals, w, id);
      }
      // Scenes deleted in Foundry go, with their tokens.
      if (e.complete !== false) for (const sc of scenesOf(db, w)) if (!ids.has(sc.scene_id)) { dropTokens(d, w, sc.scene_id); run(db, 'DELETE FROM foundry_scenes WHERE world_id = ? AND scene_id = ?', w, sc.scene_id); }
      return '';
    }
    case 'tokens':
    case 'token': {
      if (!opt<boolean>(s, 'foundryTokens')) return '';
      const sc = typeof e.scene === 'string' ? sceneOf(db, w, e.scene) : null;
      if (!sc?.map_id) return '';
      const list = e.t === 'tokens' ? (Array.isArray(e.list) ? e.list.slice(0, 400) : []) : [e];
      let revealed = false;
      let moved = '';
      for (const t of list) {
        const r = upsertToken(d, w, owner, sc, t, s);
        if (r?.moved && t.player === true && reveal(d, w, sc, pos(t.x, t.y)!, s)) revealed = true;
        if (r?.moved && e.t === 'token') moved = r.name;
      }
      if (e.t === 'tokens') {
        const have = new Set(list.map((t: any) => String(t?.id ?? '')));
        for (const t of all<TokenRow>(db, 'SELECT * FROM foundry_tokens WHERE world_id = ? AND scene_id = ?', w, sc.scene_id)) if (!have.has(t.token_id)) dropToken(d, w, t);
        return `${sc.name}: ${list.length} token${list.length === 1 ? '' : 's'}`;
      }
      return moved ? `${moved} moved on ${sc.name}${revealed ? ' (fog uncovered)' : ''}` : '';
    }
    case 'tokenGone': {
      const t = one<TokenRow>(db, 'SELECT * FROM foundry_tokens WHERE world_id = ? AND scene_id = ? AND token_id = ?', w, String(e.scene ?? ''), String(e.id ?? ''));
      if (t) dropToken(d, w, t);
      return '';
    }
    case 'roll': {
      if (!opt<boolean>(s, 'foundryRollsIn')) return '';
      const rolls: FRoll[] = (Array.isArray(e.rolls) ? e.rolls : []).slice(0, 10)
        .map((r: any) => ({ expr: String(r?.expr ?? '').replace(/\s+/g, '').slice(0, 80), total: Number(r?.total), dice: (Array.isArray(r?.dice) ? r.dice : []).map(Number).filter(Number.isFinite).slice(0, 100) }))
        .filter((r: FRoll) => r.expr && Number.isFinite(r.total));
      if (!rolls.length) return '';
      const sess = currentSession(db, w);
      if (!sess) return '';
      // The roller: the linked actor's player, else a player with that display name, else the GM (named in the text).
      let author = (typeof e.actorId === 'string' && linkOf(db, w, e.actorId)?.account_id) || null;
      const who = text(e.who, 60);
      if (!author) {
        const n = text(e.player, 60).toLowerCase();
        const p = all<any>(db, "SELECT m.account_id, a.display_name, m.character_name FROM members m JOIN accounts a ON a.id = m.account_id WHERE m.world_id = ? AND m.role = 'player'", w)
          .filter((m) => [m.display_name, m.character_name].some((x) => typeof x === 'string' && x.trim().toLowerCase() === (n || who.toLowerCase())));
        if (p.length === 1) author = p[0].account_id;
      }
      const label = text(e.label, 60);
      const roll = rollFrom(rolls, [author ? '' : who, label, 'Foundry'].filter(Boolean).join(' · '));
      const row = addMessage(db, w, { sessionId: sess.id, channel: 'table', authorId: author ?? owner, role: author ? 'player' : 'gm', body: `/roll ${roll.expr} ${roll.note}`.slice(0, 2000), roll });
      firstTime(db, w, `msg:${row.id}`);
      for (const m of all<any>(db, 'SELECT account_id, role FROM members WHERE world_id = ?', w)) {
        const v = { accountId: m.account_id, role: m.role };
        if (canRead(v, 'table')) d.hub.emit(w, 'chat', { type: 'new', channel: 'table', sessionId: row.session_id, message: viewMessage(db, row, v, w) }, only(v.accountId));
      }
      return `${who || 'Someone'} rolled ${roll.expr} = ${roll.total}${label ? ` (${label})` : ''}`;
    }
    case 'sceneMade': {
      // A scene the module made from an Alexandria map picture: link it to that map.
      const item = one<any>(db, "SELECT * FROM foundry_outbox WHERE world_id = ? AND id = ? AND kind = 'scene'", w, Number(e.ref));
      if (!item || typeof e.sceneId !== 'string' || !e.sceneId) return '';
      const p = parseJson<any>(item.payload, {});
      const id = e.sceneId.slice(0, 60);
      if (!sceneOf(db, w, id)) run(db, 'INSERT INTO foundry_scenes (world_id, scene_id, name, active, seen_at) VALUES (?, ?, ?, 0, ?)', w, id, text(p.name, 120) || 'Scene', now());
      run(db, 'UPDATE foundry_scenes SET map_id = ?, pic = ?, fog_sent = -1 WHERE world_id = ? AND scene_id = ?', p.mapId, p.pic, w, id);
      return `Made the Foundry scene "${p.name}" from the map ${p.mapId}`;
    }
    default:
      return '';
  }
}

/** Table chat rolls made in Alexandria since the last sync (not the ones that came from Foundry). */
function rollsOut(db: DB, worldId: string, cursor: string | null) {
  if (!cursor) return { rolls: [] as any[], cursor: now() };
  const rows = all<any>(db, `SELECT * FROM sessionchat_messages WHERE world_id = ? AND channel = 'table' AND kind = 'roll' AND deleted_at IS NULL AND hidden_at IS NULL AND at > ?
    AND NOT EXISTS (SELECT 1 FROM foundry_seen s WHERE s.world_id = ? AND s.key = 'msg:' || sessionchat_messages.id) ORDER BY at LIMIT 20`, worldId, cursor, worldId);
  if (!rows.length) return { rolls: [], cursor };
  const nm = names(db, worldId);
  return {
    rolls: rows.map((m) => { const r = parseJson<any>(m.roll, {}); return { who: nm[m.author_id] ?? 'Someone', expr: r.expr, total: r.total, note: r.note ?? '' }; }),
    cursor: rows[rows.length - 1].at as string,
  };
}

/** A library page as journal HTML. Wiki links become plain text (Foundry cannot open them). */
const pageHtml = (md: string) => String(marked.parse(md.replace(/\[\[(?:page:)?([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, a, b) => b || a), { async: false }));

// ---- map pictures ----

/** A map picture's bytes, name and type: a library file (lib:<id>) or a picture from a source (imp:<id>). */
function pictureOf(d: Deps, w: string, pic: string, viewer: Viewer): { name: string; mime: string; bytes: Buffer } | null {
  if (!PIC_RE.test(pic)) return null;
  const ref = pic.slice(4);
  if (pic.startsWith('lib:')) {
    const f = one<any>(d.db, "SELECT * FROM libfiles_files WHERE id = ? AND world_id = ? AND family = 'image'", ref, w);
    if (!f || !mayRead(d, f, viewer) || !d.dataDir) return null;
    try { return { name: f.name, mime: f.mime, bytes: fs.readFileSync(path.join(d.dataDir, 'libfiles', w, f.id)) }; } catch { return null; }
  }
  const img = one<any>(d.db, 'SELECT * FROM intake_images WHERE id = ? AND world_id = ?', ref, w);
  if (!img || !imageVisibleTo(d.db, img, viewer.role)) return null;
  return { name: img.name || 'map', mime: img.mime, bytes: Buffer.from(img.data) };
}

/** May this viewer see a map picture (for the Map page's list of linked maps)? */
function pictureVisible(d: Deps, w: string, pic: string, viewer: Viewer): boolean {
  const ref = pic.slice(4);
  if (pic.startsWith('lib:')) { const f = one<any>(d.db, 'SELECT * FROM libfiles_files WHERE id = ? AND world_id = ?', ref, w); return !!f && mayRead(d, f, viewer); }
  const img = one<any>(d.db, 'SELECT world_id, source_id, visibility, page_external FROM intake_images WHERE id = ? AND world_id = ?', ref, w);
  return !!img && imageVisibleTo(d.db, img, viewer.role);
}

/** A scene's picture into the library: a map file on a page under Foundry/. Returns the file id. */
function storeMap(d: Deps, w: string, by: string, sceneName: string, fileName: string, bytes: Buffer, level: string): string {
  if (!d.dataDir) throw new HttpError(503, 'This server has no data folder for files');
  const name = (fileName.replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').trim() || 'scene.webp').slice(0, 120);
  const sniffed = sniffFile(bytes, name);
  if ('error' in sniffed) throw new HttpError(415, sniffed.error);
  if (sniffed.family !== 'image') throw new HttpError(415, 'A map must be a picture');
  const title = `${sceneName.replace(/[\\/]+/g, ' ').trim() || 'Scene'}`.slice(0, 180);
  const p = safePagePath(`Foundry/${title}.md`);
  let pg = one<any>(d.db, 'SELECT id FROM pages WHERE world_id = ? AND path = ?', w, p);
  if (!pg) {
    d.library.save(w, { path: p, title, body: `A map from the Foundry scene "${title}".`, frontmatter: { tags: ['file', 'map', 'foundry'] }, visibility: level as any }, by);
    pg = one<any>(d.db, 'SELECT id FROM pages WHERE world_id = ? AND path = ?', w, p);
  }
  const fid = newId('lf_');
  const dir = path.join(d.dataDir, 'libfiles', w);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, fid), bytes);
  run(d.db, "INSERT INTO libfiles_files (id, world_id, page_id, name, kind, level, mime, family, size, by_id, at) VALUES (?, ?, ?, ?, 'map', ?, ?, ?, ?, ?, ?)",
    fid, w, pg.id, name, level, sniffed.mime, sniffed.family, bytes.length, by, now());
  run(d.db, 'INSERT INTO audit (world_id, account_id, action, detail, at) VALUES (?, ?, ?, ?, ?)', w, by, 'foundry.map_in', `${name} ${p}`, now());
  const row = one<any>(d.db, 'SELECT * FROM libfiles_files WHERE id = ?', fid);
  d.hub.emit(w, 'libfile', { pageId: pg.id }, (v) => mayRead(d, row, v));
  return fid;
}

/** Link a scene to an Alexandria map (or unlink: mapId null). Its tokens start again on the new map. */
function linkScene(d: Deps, w: string, sceneId: string, mapId: string | null, pic: string | null) {
  const sc = sceneOf(d.db, w, sceneId);
  if (!sc) throw new HttpError(404, 'Foundry has not told us about that scene yet');
  if (sc.map_id !== mapId || sc.pic !== pic) dropTokens(d, w, sceneId);
  run(d.db, 'UPDATE foundry_scenes SET map_id = ?, pic = ?, fog_sent = -1 WHERE world_id = ? AND scene_id = ?', mapId, pic, w, sceneId);
  // The module sends the scene's tokens again (and leaves an unlinked scene's fog off).
  queue(d.db, w, 'refresh', {});
  ping(d, w);
}

function bridgeOf(db: DB, req: Request) {
  const h = req.get('authorization') ?? '';
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (!token.startsWith(KEY_PREFIX)) throw new HttpError(401, 'Send the Foundry bridge key');
  const b = one<any>(db, 'SELECT * FROM foundry_bridges WHERE key_hash = ?', sha256(token));
  if (!b) throw new HttpError(401, 'That Foundry bridge key is not valid (made a new one?)');
  // The key belongs to a GM; a GM who lost the world loses the bridge.
  if (!one(db, "SELECT 1 FROM members WHERE world_id = ? AND account_id = ? AND role = 'gm'", b.world_id, b.created_by)) throw new HttpError(403, 'The GM who made this key no longer runs the world');
  run(db, 'UPDATE foundry_bridges SET last_seen_at = ? WHERE world_id = ?', now(), b.world_id);
  return b;
}
const bridgeViewer = (b: any): Viewer => ({ accountId: b.created_by, role: 'gm' } as Viewer);

/** Where this server is reached, for the manifest's links. ALX_PUBLIC_URL wins over what the request says. */
const baseUrl = (d: Deps, req: Request) => d.env.ALX_PUBLIC_URL?.replace(/\/+$/, '') || `${req.protocol}://${req.get('host')}`;

function manifest(base: string) {
  return {
    id: MODULE_ID,
    title: 'Alexandria Bridge',
    description: 'Keeps this Foundry world and an Alexandria world in step: HP and conditions, maps, tokens, fog of war, rolls and journal entries.',
    version: MODULE_VERSION,
    compatibility: { minimum: '12', verified: '13' },
    authors: [{ name: 'Alexandria' }],
    esmodules: ['scripts/alexandria.js'],
    styles: ['styles/alexandria.css'],
    url: base,
    manifest: `${base}/api/foundry/module.json`,
    download: `${base}/api/foundry/module.zip`,
  };
}

function appRoutes(app: Express, d: Deps) {
  const { db } = d;

  // The module, for Foundry's "Install Module → Manifest URL". Public: there is nothing secret in it (the key is typed in Foundry).
  app.get('/api/foundry/module.json', (req, res) => { res.setHeader('Cache-Control', 'no-cache'); res.json(manifest(baseUrl(d, req))); });
  app.get('/api/foundry/module.zip', async (req, res) => {
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${MODULE_ID}.zip"`);
    const out = new PassThrough();
    out.pipe(res);
    await writeZip(out, [
      { name: 'module.json', data: Buffer.from(JSON.stringify(manifest(baseUrl(d, req)), null, 2)) },
      { name: 'scripts/alexandria.js', data: fs.readFileSync(path.join(CLIENT, 'alexandria.js')) },
      { name: 'styles/alexandria.css', data: fs.readFileSync(path.join(CLIENT, 'alexandria.css')) },
    ]).catch(() => undefined);
    out.end();
  });

  // The bridge is called from the Foundry page, whatever its address. Only the bridge key opens it (no cookies), so any origin may call.
  app.use('/api/foundry/bridge', (req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
    res.setHeader('Access-Control-Max-Age', '600');
    // A Foundry on a public address calling a server on the home network (Chrome's private network checks).
    if (req.get('access-control-request-private-network') === 'true') res.setHeader('Access-Control-Allow-Private-Network', 'true');
    if (req.method === 'OPTIONS') { res.status(204).end(); return; }
    next();
  });

  const r = Router();

  r.post('/hello', (req, res) => {
    const b = bridgeOf(db, req);
    const w = b.world_id;
    const wn = one<any>(db, 'SELECT name FROM worlds WHERE id = ?', w);
    const ids = strList(req.body?.statusIds, 200);
    run(db, `UPDATE foundry_bridges SET module_version = COALESCE(?, module_version), foundry_world = COALESCE(?, foundry_world), system = COALESCE(?, system),
      foundry_version = COALESCE(?, foundry_version), status_ids = COALESCE(?, status_ids) WHERE world_id = ?`,
    text(req.body?.moduleVersion, 20) || null, text(req.body?.world, 120) || null, text(req.body?.system, 60) || null, text(req.body?.foundryVersion, 20) || null, ids.length ? JSON.stringify(ids) : null, w);
    // A new connection: everything is sent again.
    forget(db, w);
    run(db, 'UPDATE foundry_scenes SET fog_sent = -1 WHERE world_id = ?', w);
    ping(d, w);
    res.json({ world: wn?.name ?? '', moduleVersion: MODULE_VERSION, config: moduleConfig(db, w, settingsOf(db, w)) });
  });

  // Events from the module, in order: { instance, events: [{ seq, t, ... }] }.
  r.post('/events', (req, res) => {
    const b = bridgeOf(db, req);
    const instance = text(req.body?.instance, 40);
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
        activity(db, b.world_id, 'in', `Skipped a ${text(e?.t, 20) || 'bad'} event: ${err?.message ?? err}`);
      }
    }
    if (lines || events.some((e: any) => e?.t === 'scenes')) ping(d, b.world_id);
    res.json({ acked });
  });

  // What Foundry should do now: HP and status pushes, token moves, fog, and queued items (scenes, journal entries, chat lines, rolls).
  r.post('/sync', (req, res) => {
    const b = bridgeOf(db, req);
    const w = b.world_id;
    const s = settingsOf(db, w);
    const out = tx(db, () => {
      const pushes = pendingPushes(db, w, statusMap(opt(s, 'foundryStatuses')), { hp: opt<boolean>(s, 'foundryHp'), conditions: opt<boolean>(s, 'foundryConditions'), pushMax: opt<boolean>(s, 'foundryPushMax') });
      const moves = all<any>(db, 'SELECT * FROM foundry_tokens WHERE world_id = ? AND want_x IS NOT NULL AND want_y IS NOT NULL', w)
        .map((t) => ({ scene: t.scene_id, id: t.token_id, x: t.want_x, y: t.want_y }));
      run(db, 'UPDATE foundry_tokens SET want_x = NULL, want_y = NULL WHERE world_id = ? AND want_x IS NOT NULL', w);
      const fog: any[] = [];
      for (const sc of scenesOf(db, w)) {
        if (sc.map_id && sc.pic && opt<boolean>(s, 'foundryFog')) {
          const f = fogOf(d, w, sc.map_id, sc.pic);
          if (f.version !== sc.fog_sent) { fog.push({ scene: sc.scene_id, enabled: f.enabled, base: f.base, ops: f.ops, aspect: FOG_ASPECT }); run(db, 'UPDATE foundry_scenes SET fog_sent = ? WHERE world_id = ? AND scene_id = ?', f.version, w, sc.scene_id); }
        } else if (sc.fog_sent !== -2) {
          // Not linked (or fog sync off): the scene shows no Alexandria fog.
          fog.push({ scene: sc.scene_id, enabled: false, base: null, ops: [], aspect: FOG_ASPECT });
          run(db, 'UPDATE foundry_scenes SET fog_sent = -2 WHERE world_id = ? AND scene_id = ?', w, sc.scene_id);
        }
      }
      const items = all<any>(db, 'SELECT * FROM foundry_outbox WHERE world_id = ? AND sent_at IS NULL ORDER BY id LIMIT 20', w)
        .map((x) => ({ id: x.id, kind: x.kind, ...parseJson<any>(x.payload, {}) }));
      for (const x of items) run(db, 'UPDATE foundry_outbox SET sent_at = ? WHERE id = ?', now(), x.id);
      run(db, 'DELETE FROM foundry_outbox WHERE world_id = ? AND sent_at IS NOT NULL AND sent_at < ?', w, new Date(Date.now() - 864e5).toISOString());
      let rolls: any[] = [];
      if (opt<boolean>(s, 'foundryRollsOut')) {
        const r = rollsOut(db, w, b.roll_cursor);
        rolls = r.rolls;
        run(db, 'UPDATE foundry_bridges SET roll_cursor = ? WHERE world_id = ?', r.cursor, w);
      } else run(db, 'UPDATE foundry_bridges SET roll_cursor = ? WHERE world_id = ?', now(), w);
      return { pushes, moves, fog, items, rolls };
    });
    for (const p of out.pushes) activity(db, w, 'out', `${p.name}: ${[p.hp !== undefined ? `HP ${p.hp}` : '', p.maxHp !== undefined ? `max HP ${p.maxHp}` : '', p.statuses ? `statuses ${p.statuses.join(', ') || 'none'}` : ''].filter(Boolean).join(', ') || 'temporary HP'}`);
    for (const x of out.items) {
      if (x.kind === 'handout') activity(db, w, 'out', `Journal entry "${x.name}"`);
      else if (x.kind === 'say') activity(db, w, 'out', `Said: ${String(x.text ?? '').slice(0, 80)}`);
      else if (x.kind === 'scene') activity(db, w, 'out', `New scene "${x.name}" from the map ${x.mapId}`);
      else if (x.kind === 'fetchScene') activity(db, w, 'out', `Asked Foundry for the picture of "${x.name}"`);
    }
    if (out.pushes.length || out.items.some((x) => x.kind !== 'refresh')) ping(d, w);
    res.json({ config: moduleConfig(db, w, s), ...out });
  });

  // A map picture for a scene the module is making (an outbox "scene" item).
  r.get('/pictures/:ref', (req, res) => {
    const b = bridgeOf(db, req);
    const item = one<any>(db, "SELECT * FROM foundry_outbox WHERE world_id = ? AND id = ? AND kind = 'scene'", b.world_id, Number(req.params.ref));
    const p = item ? parseJson<any>(item.payload, {}) : null;
    const pic = p ? pictureOf(d, b.world_id, String(p.pic), bridgeViewer(b)) : null;
    if (!pic) throw new HttpError(404, 'No such picture');
    res.setHeader('Content-Type', pic.mime);
    res.setHeader('Cache-Control', 'no-store');
    res.end(pic.bytes);
  });

  // A scene's picture from Foundry (the GM asked to bring the scene in): it becomes a library map and the scene is linked to it.
  r.post('/scenes/:id/image', express.raw({ type: () => true, limit: maxBytes(d) }), (req, res) => {
    const b = bridgeOf(db, req);
    const w = b.world_id;
    const sc = sceneOf(db, w, String(req.params.id));
    if (!sc) throw new HttpError(404, 'Send the scene list first');
    const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!bytes.length) throw new HttpError(400, 'Send the picture as the request body');
    const s = settingsOf(db, w);
    const file = text(req.query.name, 120) || path.basename(sc.img ?? 'scene.webp');
    const fid = storeMap(d, w, b.created_by, sc.name, file, bytes, opt<string>(s, 'foundryMapLevel') || 'party');
    const mapId = sc.map_id ?? mapIdFor(sc.name);
    linkScene(d, w, sc.scene_id, mapId, `lib:${fid}`);
    activity(db, w, 'in', `Brought "${sc.name}" in as the map ${mapId}`);
    ping(d, w);
    res.status(201).json({ mapId, pic: `lib:${fid}` });
  });

  app.use('/api/foundry/bridge', r);
}

function worldRoutes(d: Deps) {
  const r = Router({ mergeParams: true });
  const { db } = d;
  const W = (res: Response) => ctx(res).world.id;

  // Maps linked to Foundry scenes, for the Map page's list (everyone; only pictures the viewer may see).
  r.get('/maps', (_req, res) => {
    const w = W(res);
    const v = ctx(res).viewer;
    res.json(scenesOf(db, w).filter((x) => x.map_id && x.pic && pictureVisible(d, w, x.pic, v)).map((x) => ({ mapId: x.map_id, pic: x.pic, name: x.name })));
  });

  // Move a token from Alexandria (its mark id, or its name on a linked scene). The GM any token; a player their own character's.
  r.put('/tokens/:ref', requirePlayerOrGM, (req, res) => {
    const w = W(res);
    const s = settings(res);
    const ref = String(req.params.ref);
    let t = one<TokenRow>(db, 'SELECT * FROM foundry_tokens WHERE world_id = ? AND mark_id = ?', w, ref);
    if (!t) {
      const hits = all<any>(db, "SELECT t.* FROM foundry_tokens t JOIN map_marks m ON m.id = t.mark_id WHERE t.world_id = ? AND lower(json_extract(m.data, '$.label')) = lower(?)", w, ref);
      if (hits.length > 1) throw new HttpError(409, `${hits.length} tokens are called that: use the token's id`);
      t = hits[0];
    }
    const mark = t ? one<any>(db, 'SELECT * FROM map_marks WHERE id = ?', t.mark_id) : null;
    if (!t || !mark || (!isGM(res) && mark.hidden_by_gm)) throw new HttpError(404, 'No such token');
    const data = parseJson<any>(mark.data, {});
    if (!isGM(res)) {
      if (!opt<boolean>(s, 'foundryPlayersMove')) throw new HttpError(403, 'Only the GM moves tokens in this world');
      if (!data.token?.account || data.token.account !== me(res)) throw new HttpError(403, 'You can only move your own character’s token');
    }
    const p = pos(req.body?.x, req.body?.y);
    if (!p) throw new HttpError(400, 'x and y must be numbers from 0 to 100');
    const before = { x: data.x, y: data.y };
    run(db, 'UPDATE map_marks SET data = ? WHERE id = ?', JSON.stringify({ ...data, x: p.x, y: p.y }), mark.id);
    run(db, 'UPDATE foundry_tokens SET want_x = ?, want_y = ? WHERE world_id = ? AND scene_id = ? AND token_id = ?', p.x, p.y, w, t.scene_id, t.token_id);
    const sc = sceneOf(db, w, t.scene_id);
    const uncovered = !!sc && data.token?.player === true && reveal(d, w, sc, p, s);
    emitMark(d, w, mark.map_id, mark.id, !!mark.hidden_by_gm, [before, p]);
    activity(db, w, 'out', `${data.label ?? 'A token'} moved from Alexandria${uncovered ? ' (fog uncovered)' : ''}`);
    ping(d, w);
    res.json({ ok: true, x: p.x, y: p.y, uncovered });
  });

  r.use(requireGM);

  r.get('/', (_req, res) => {
    const w = W(res);
    const b = one<any>(db, 'SELECT * FROM foundry_bridges WHERE world_id = ?', w);
    const nm = names(db, w);
    const s = settings(res);
    const picName = (pic: string | null) => {
      if (!pic) return null;
      if (pic.startsWith('lib:')) return one<any>(db, 'SELECT name FROM libfiles_files WHERE id = ? AND world_id = ?', pic.slice(4), w)?.name ?? null;
      return one<any>(db, 'SELECT name FROM intake_images WHERE id = ? AND world_id = ?', pic.slice(4), w)?.name ?? null;
    };
    res.json({
      key: b ? { prefix: b.prefix, createdAt: b.created_at } : null,
      lastSeen: b?.last_seen_at ?? null,
      online: !!b?.last_seen_at && Date.now() - new Date(b.last_seen_at).getTime() < ONLINE_MS,
      moduleVersion: b?.module_version ?? null,
      latestModuleVersion: MODULE_VERSION,
      foundryWorld: b?.foundry_world ?? null,
      system: b?.system ?? null,
      foundryVersion: b?.foundry_version ?? null,
      statusIds: parseJson<string[]>(b?.status_ids, []),
      actors: linksOf(db, w).map((l) => ({ id: l.actor_id, name: l.name, owners: parseJson(l.owners, []), accountId: l.account_id, player: l.account_id ? nm[l.account_id] ?? null : null, seenAt: l.seen_at })),
      scenes: scenesOf(db, w).map((x) => ({
        id: x.scene_id, name: x.name, active: !!x.active, hasPicture: !!x.img, mapId: x.map_id, pic: x.pic, picName: picName(x.pic),
        tokens: x.map_id ? all<any>(db, 'SELECT m.id, m.data, m.hidden_by_gm FROM foundry_tokens t JOIN map_marks m ON m.id = t.mark_id WHERE t.world_id = ? AND t.scene_id = ? ORDER BY m.created_at', w, x.scene_id)
          .map((m) => { const dd = parseJson<any>(m.data, {}); return { id: m.id, name: dd.label, x: dd.x, y: dd.y, hidden: !!m.hidden_by_gm, player: dd.token?.account ? nm[dd.token.account] ?? null : null }; }) : [],
      })),
      statuses: statusMap(opt(s, 'foundryStatuses')),
      activity: all<any>(db, 'SELECT dir, text, at FROM foundry_activity WHERE world_id = ? ORDER BY id DESC LIMIT 50', w),
    });
  });

  // A new bridge key (shown once). It replaces the old one, which stops working.
  r.post('/key', (_req, res) => {
    const w = W(res);
    const key = secret(KEY_PREFIX);
    run(db, `INSERT INTO foundry_bridges (world_id, key_hash, prefix, created_by, created_at, roll_cursor) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (world_id) DO UPDATE SET key_hash = excluded.key_hash, prefix = excluded.prefix, created_by = excluded.created_by, created_at = excluded.created_at, last_seen_at = NULL, roll_cursor = excluded.roll_cursor`,
    w, sha256(key), key.slice(0, KEY_PREFIX.length + 4), me(res), now(), now());
    run(db, 'INSERT INTO audit (world_id, account_id, action, detail, at) VALUES (?, ?, ?, ?, ?)', w, me(res), 'foundry.key', '', now());
    res.status(201).json({ key });
  });

  r.delete('/key', (_req, res) => {
    run(db, 'DELETE FROM foundry_bridges WHERE world_id = ?', W(res));
    res.json({ ok: true });
  });

  // Link a Foundry actor to a player (or null to unlink). Alexandria's numbers are pushed to it next.
  r.put('/actors/:id', (req, res) => {
    const w = W(res);
    const l = linkOf(db, w, String(req.params.id));
    if (!l) throw new HttpError(404, 'Foundry has not told us about that actor yet');
    const aid = req.body?.accountId === null || req.body?.accountId === '' ? null : String(req.body?.accountId ?? '');
    if (aid && !one(db, "SELECT 1 FROM members WHERE world_id = ? AND account_id = ? AND role = 'player'", w, aid)) throw new HttpError(400, 'Pick a player of this world');
    run(db, 'UPDATE foundry_actors SET account_id = ? WHERE world_id = ? AND actor_id = ?', aid, w, l.actor_id);
    forget(db, w, l.actor_id);
    ping(d, w);
    res.json({ ok: true });
  });

  // Send Alexandria's HP and conditions to Foundry again (all linked actors, or one).
  r.post('/push', (req, res) => {
    forget(db, W(res), typeof req.body?.id === 'string' ? req.body.id : undefined);
    res.json({ ok: true, queued: linksOf(db, W(res)).filter((l) => l.account_id).length });
  });

  // Link a scene to an Alexandria map and picture, or unlink it ({ mapId: null }).
  r.put('/scenes/:id', (req, res) => {
    const w = W(res);
    const b = req.body ?? {};
    if (b.mapId === null || b.mapId === '') { linkScene(d, w, String(req.params.id), null, null); res.json({ ok: true }); return; }
    const mapId = mapIdFor(String(b.mapId ?? ''));
    const pic = String(b.pic ?? '');
    if (!PIC_RE.test(pic) || !pictureVisible(d, w, pic, ctx(res).viewer)) throw new HttpError(400, 'pic must be a map picture of this world (lib:<file id> or imp:<picture id>)');
    linkScene(d, w, String(req.params.id), mapId, pic);
    activity(db, w, 'out', `Linked the scene to the map ${mapId}`);
    res.json({ ok: true, mapId, pic });
  });

  // Bring a Foundry scene's picture into the library as a map (the module uploads it on its next sync).
  r.post('/scenes/:id/import', (req, res) => {
    const w = W(res);
    const sc = sceneOf(db, w, String(req.params.id));
    if (!sc) throw new HttpError(404, 'Foundry has not told us about that scene yet');
    if (!sc.img) throw new HttpError(409, 'That scene has no background picture');
    queue(db, w, 'fetchScene', { sceneId: sc.scene_id, name: sc.name });
    run(db, 'INSERT INTO audit (world_id, account_id, action, detail, at) VALUES (?, ?, ?, ?, ?)', w, me(res), 'foundry.import', sc.name, now());
    res.status(202).json({ queued: true, name: sc.name });
  });

  // An Alexandria map picture as a new Foundry scene, linked to the map.
  r.post('/scenes', (req, res) => {
    const w = W(res);
    const b = req.body ?? {};
    const pic = String(b.pic ?? '');
    if (!PIC_RE.test(pic)) throw new HttpError(400, 'pic must be a map picture (lib:<file id> or imp:<picture id>)');
    const p = pictureOf(d, w, pic, ctx(res).viewer);
    if (!p) throw new HttpError(404, 'No such map picture');
    const name = text(b.name, 120) || p.name.replace(/\.[A-Za-z0-9]{1,8}$/, '') || 'Map';
    const mapId = mapIdFor(String(b.mapId ?? '') || name);
    const ref = queue(db, w, 'scene', { name, mapId, pic, file: p.name });
    run(db, 'INSERT INTO audit (world_id, account_id, action, detail, at) VALUES (?, ?, ?, ?, ?)', w, me(res), 'foundry.scene', `${name} ${pic}`, now());
    res.status(202).json({ queued: true, ref, name, mapId });
  });

  // A library page as a Foundry journal entry. players: every player can read it (needs the page's player copy).
  r.post('/handout', (req, res) => {
    const w = W(res);
    const ref = String(req.body?.page ?? '').trim();
    if (!ref) throw new HttpError(400, 'page is required (its id or title)');
    const pg = one<any>(db, 'SELECT * FROM pages WHERE world_id = ? AND id = ?', w, ref)
      ?? one<any>(db, 'SELECT * FROM pages WHERE world_id = ? AND title = ? COLLATE NOCASE ORDER BY updated_at DESC LIMIT 1', w, ref);
    if (!pg) throw new HttpError(404, 'No page with that id or title');
    const players = req.body?.players === true;
    const shared = pg.visibility === 'party' && pg.player_body !== null;
    if (players && !shared) throw new HttpError(409, 'Share the page with the players first: the journal entry shows them their copy');
    queue(db, w, 'handout', {
      name: text(req.body?.name, 120) || pg.title,
      html: pageHtml(players ? pg.player_body : pg.body),
      gmnotes: players ? pageHtml(pg.body) : '',
      players,
    });
    run(db, 'INSERT INTO audit (world_id, account_id, action, detail, at) VALUES (?, ?, ?, ?, ?)', w, me(res), 'foundry.handout', pg.title, now());
    res.status(202).json({ queued: true, name: pg.title, players });
  });

  // A line in the Foundry chat, from "Alexandria" (or a name given in as).
  r.post('/say', (req, res) => {
    const t = String(req.body?.text ?? '').trim();
    if (!t || t.length > 1000) throw new HttpError(400, 'text must be 1 to 1000 characters');
    queue(db, W(res), 'say', { text: t, as: text(req.body?.as, 60) || null });
    res.status(202).json({ queued: true });
  });

  return r;
}

const feature: Feature = {
  id: 'foundry',
  schema: `
    CREATE TABLE IF NOT EXISTS foundry_bridges (
      world_id TEXT PRIMARY KEY REFERENCES worlds(id) ON DELETE CASCADE,
      key_hash TEXT NOT NULL UNIQUE,
      prefix TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_seen_at TEXT,
      module_version TEXT,
      foundry_world TEXT,
      system TEXT,
      foundry_version TEXT,
      status_ids TEXT,
      roll_cursor TEXT
    );
    CREATE TABLE IF NOT EXISTS foundry_actors (
      world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
      actor_id TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      owners TEXT NOT NULL DEFAULT '[]',
      account_id TEXT,
      last_hp INTEGER,
      last_max INTEGER,
      last_temp INTEGER,
      last_conditions TEXT,
      seen_at TEXT NOT NULL,
      PRIMARY KEY (world_id, actor_id)
    );
    CREATE TABLE IF NOT EXISTS foundry_scenes (
      world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
      scene_id TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      img TEXT,
      width INTEGER,
      height INTEGER,
      grid_frac REAL,
      active INTEGER NOT NULL DEFAULT 0,
      map_id TEXT,
      pic TEXT,
      fog_sent INTEGER NOT NULL DEFAULT -1,
      seen_at TEXT NOT NULL,
      PRIMARY KEY (world_id, scene_id)
    );
    CREATE TABLE IF NOT EXISTS foundry_tokens (
      world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
      scene_id TEXT NOT NULL,
      token_id TEXT NOT NULL,
      mark_id TEXT NOT NULL,
      want_x REAL,
      want_y REAL,
      PRIMARY KEY (world_id, scene_id, token_id)
    );
    CREATE INDEX IF NOT EXISTS foundry_tokens_mark ON foundry_tokens(world_id, mark_id);
    CREATE TABLE IF NOT EXISTS foundry_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      sent_at TEXT
    );
    CREATE INDEX IF NOT EXISTS foundry_outbox_world ON foundry_outbox(world_id, sent_at, id);
    CREATE TABLE IF NOT EXISTS foundry_seen (
      world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      at TEXT NOT NULL,
      PRIMARY KEY (world_id, key)
    );
    CREATE TABLE IF NOT EXISTS foundry_activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
      dir TEXT NOT NULL,
      text TEXT NOT NULL,
      at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS foundry_activity_world ON foundry_activity(world_id, id);
  `,
  settings: {
    foundryHp: { type: 'boolean', default: true },
    foundryConditions: { type: 'boolean', default: true },
    foundryTokens: { type: 'boolean', default: true },
    foundryFog: { type: 'boolean', default: true },
    foundryRevealSquares: { type: 'int', default: 6, min: 0, max: 60 },
    foundryPlayersMove: { type: 'boolean', default: true },
    foundryRollsIn: { type: 'boolean', default: true },
    foundryRollsOut: { type: 'boolean', default: false },
    foundryPushMax: { type: 'boolean', default: false },
    foundryMapLevel: { type: 'enum', default: 'party', values: ['party', 'gm'] },
    foundryHpPath: { type: 'string', default: 'system.attributes.hp.value', max: 120 },
    foundryMaxPath: { type: 'string', default: 'system.attributes.hp.max', max: 120 },
    foundryTempPath: { type: 'string', default: 'system.attributes.hp.temp', max: 120 },
    foundryStatuses: { type: 'json', default: {}, validate: validateStatuses },
  },
  worldMount: 'foundry',
  worldRoutes,
  appRoutes,
  mcpTools: [
    {
      name: 'foundry_status', gmOnly: true,
      description: 'The Foundry VTT connection: whether the bridge is online, which Foundry actors are linked to which players, the Foundry scenes (and the Alexandria map each is linked to, with its tokens and their positions on the 0-100 map grid), and the latest things that moved between Foundry and Alexandria.',
      props: {}, call: () => ({ method: 'GET', path: '/foundry' }),
    },
    {
      name: 'foundry_move_token', write: true,
      description: 'Move a token on a Foundry scene linked to an Alexandria map. token is the token\'s id from foundry_status, or its exact name. x and y are the new center on the 0-100 map grid (0,0 top left). A player token that moves uncovers fog around it when that is on.',
      props: { token: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' } },
      required: ['token', 'x', 'y'],
      call: (a) => ({ method: 'PUT', path: `/foundry/tokens/${encodeURIComponent(String(a.token ?? ''))}`, body: { x: a.x, y: a.y } }),
    },
    {
      name: 'foundry_send_map', write: true,
      description: 'Make a new Foundry scene from an Alexandria map picture (pic is lib:<file id> from the library\'s maps, or imp:<picture id> from a source). The scene is linked to the Alexandria map, so its tokens and fog follow.',
      props: { pic: { type: 'string' }, name: { type: 'string', description: 'Scene name (optional)' } },
      required: ['pic'],
      call: (a) => ({ method: 'POST', path: '/foundry/scenes', body: { pic: a.pic, name: a.name } }),
    },
    {
      name: 'foundry_send_handout', write: true,
      description: 'Send a library page to the Foundry world as a journal entry. players true lets every player read it (the page must be shared with players; they see the player copy); false makes it GM-only.',
      props: { page: { type: 'string', description: 'The page id or exact title' }, players: { type: 'boolean', default: false } },
      required: ['page'],
      call: (a) => ({ method: 'POST', path: '/foundry/handout', body: { page: a.page, players: a.players === true } }),
    },
    {
      name: 'foundry_say', write: true,
      description: 'Post a line in the Foundry chat, from "Alexandria" (or a name given in as, e.g. an NPC).',
      props: { text: { type: 'string' }, as: { type: 'string', description: 'Speaker name shown in Foundry (optional)' } },
      required: ['text'],
      call: (a) => ({ method: 'POST', path: '/foundry/say', body: { text: a.text, as: a.as } }),
    },
  ],
};
export default feature;

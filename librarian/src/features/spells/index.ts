// Spells: the Codex (the SRD 5.2.1 spells plus the world's own, searchable by
// every field), mana instead of spell slots (optional), and spell crafting
// (optional): learning a spell by combining spells a character knows. See
// docs/SPELLS.md.
//
// Who sees what (fails closed):
//   - a player reads a spell's card only when they know it or the DM made it public;
//   - DM notes on spells and recipes, drafts, and recipes the DM hides never reach a player
//     (a hidden recipe is at most an anonymous "???");
//   - a player's sheet, mana, log and requests reach that player and the DM only.
import { Router, type Response } from 'express';
import type { Deps } from '../../app.ts';
import { type DB, all, one, run, tx } from '../../core/db.ts';
import { requireDM, requirePlayerOrDM } from '../../core/auth.ts';
import { dmAnd, everyone } from '../../core/events.ts';
import { DEFAULT_SETTINGS, featureSetting, type WorldSettings } from '../../core/policy.ts';
import { HttpError, id, now, parseJson } from '../../core/util.ts';
import { ctx, isDM, me, memberIds, settings } from '../../routes/_shared.ts';
import type { Feature } from '../types.ts';
import { ABILITIES, ABILITY_NAMES, componentsText, normalizeSpell, spellLine, toCsv, type Ability } from './format.ts';
import { DEFAULT_COSTS, DEFAULT_MAX_LEVEL, DEFAULT_POOL, DEFAULT_REST, castCost, checkCosts, checkMaxLevel, checkPool, checkRest, maxCastLevel, poolMax, poolNow, restGain, type ManaRules, type RestGain } from './mana.ts';
import { checkSpellRules, preview, resolveRules } from './rules.ts';
import { eligibility, holding, normalizeRecipe, recipeById, recipes, tiers, type Eligibility, type Recipe } from './craft.ts';
import { readImport, saveImport } from './importers.ts';
import { facets, queryFrom, search } from './search.ts';
import { SCHEMA, addKnown, catalog, character, findSpell, knownIds, knownRows, logEntry, playerIds, saveCharacter, saveCustom, setMeta, spellById, srd, type Character, type WorldSpell } from './store.ts';

// (app.ts imports the feature registry, so features write the audit row themselves.)
const audit = (db: DB, worldId: string, accountId: string, action: string, detail = '') => run(db, 'INSERT INTO audit (world_id, account_id, action, detail, at) VALUES (?, ?, ?, ?, ?)', worldId, accountId, action, detail.slice(0, 500), now());

// ---- settings --------------------------------------------------------------------------------------------

export const manaRules = (s: WorldSettings): ManaRules => ({
  on: featureSetting<boolean>(s, 'spellMana') === true,
  costs: featureSetting<number[]>(s, 'spellManaCosts') ?? DEFAULT_COSTS,
  pool: featureSetting<typeof DEFAULT_POOL>(s, 'spellManaPool') ?? DEFAULT_POOL,
  rest: featureSetting<typeof DEFAULT_REST>(s, 'spellManaRest') ?? DEFAULT_REST,
  maxLevel: featureSetting<typeof DEFAULT_MAX_LEVEL>(s, 'spellManaMaxLevel') ?? DEFAULT_MAX_LEVEL,
  overdraw: featureSetting<boolean>(s, 'spellManaOverdraw') === true,
});
const craftOn = (s: WorldSettings) => featureSetting<boolean>(s, 'spellCrafting') === true;
const publicSrd = (s: WorldSettings) => featureSetting<boolean>(s, 'spellsPublicSrd') === true;
const settingsOf = (db: DB, worldId: string): WorldSettings => ({ ...DEFAULT_SETTINGS, ...parseJson(one<any>(db, 'SELECT settings FROM worlds WHERE id = ?', worldId)?.settings ?? '{}', {}) });

// ---- shapes ----------------------------------------------------------------------------------------------

/** A spell as a viewer gets it. Only the DM gets notes, the public flag and the source of a cost. */
function spellOut(s: WorldSpell, dm: boolean, r: ManaRules, known = false) {
  const base = {
    id: s.id, name: s.name, level: s.level, school: s.school, classes: s.classes, castingTime: s.castingTime, ritual: s.ritual, range: s.range,
    components: s.components, componentsText: componentsText(s), material: s.material, materialCost: s.materialCost, materialConsumed: s.materialConsumed,
    duration: s.duration, concentration: s.concentration, damageTypes: s.damageTypes, saves: s.saves, attack: s.attack, text: s.text,
    source: s.source, builtin: s.builtin, attribution: s.attribution, line: spellLine(s), manaCost: castCost(s, s.level, r), known,
  };
  return dm ? { ...base, kind: s.kind, public: s.public, manaOverride: s.manaOverride, dmNotes: s.dmNotes } : base;
}
/** Just enough to name a spell a player may not read in full. */
const spellStub = (s: WorldSpell | null, ref: string) => (s ? { id: s.id, name: s.name, level: s.level, school: s.school, line: spellLine(s) } : { id: ref, name: 'Unknown spell', level: 0, school: '', line: '' });

function charOut(db: DB, worldId: string, c: Character, r: ManaRules) {
  const max = poolMax(c, r);
  return { ...c, mana: r.on ? { on: true, now: poolNow(c, max), max, manual: c.manaMax !== null, maxCastLevel: maxCastLevel(c, r) } : { on: false } };
}

function emitChar(d: Deps, worldId: string, accountId: string) {
  d.hub.emit(worldId, 'spells-char', { accountId }, dmAnd(accountId));
}

// ---- the routes ------------------------------------------------------------------------------------------

function routes(d: Deps) {
  const r = Router({ mergeParams: true });
  const { db } = d;
  const W = (res: Response) => ctx(res).world.id;
  const S = (res: Response) => settings(res);
  const R = (res: Response) => manaRules(S(res));

  // A rest taken on the world clock gives mana back (features/clock emits `rest` to server listeners only).
  d.hub.tap((worldId, type, data: any) => {
    if (type !== 'rest' || (data?.kind !== 'long' && data?.kind !== 'short')) return;
    const rules = manaRules(settingsOf(db, worldId));
    if (rules.on) applyRest(worldId, data.kind, rules, null);
  });

  function applyRest(worldId: string, kind: 'long' | 'short', rules: ManaRules, by: string | null, only?: string[]): { accountId: string; before: number | null; after: number | null }[] {
    const gain: RestGain = kind === 'long' ? rules.rest.long : rules.rest.short;
    const out: { accountId: string; before: number | null; after: number | null }[] = [];
    for (const aid of only ?? playerIds(db, worldId)) {
      const c = character(db, worldId, aid);
      const max = poolMax(c, rules);
      if (max === null) continue;
      const cur = poolNow(c, max) ?? max;
      const next = restGain(gain, cur, max);
      if (next !== cur) {
        saveCharacter(db, worldId, aid, { mana: next });
        logEntry(db, worldId, aid, 'rest', by, { amount: next - cur, manaAfter: next, note: kind === 'long' ? 'Long rest' : 'Short rest' });
        emitChar(d, worldId, aid);
      }
      out.push({ accountId: aid, before: cur, after: next });
    }
    return out;
  }

  /** The account a request is about: `me`, or (for the DM) any player. Players may only name themselves. */
  function who(res: Response, raw: unknown): string {
    const v = String(raw ?? 'me');
    const aid = v === 'me' ? me(res) : v;
    if (!isDM(res) && aid !== me(res)) throw new HttpError(404, 'Character not found');
    if (!memberIds(db, W(res), ['player', 'dm']).includes(aid)) throw new HttpError(404, 'Character not found');
    return aid;
  }

  /** What a viewer may read of the catalog: all for the DM; for anyone else, the spells they know and the public ones. */
  function visibleCatalog(res: Response): { list: WorldSpell[]; known: Set<string> } {
    const list = catalog(db, W(res), publicSrd(S(res)));
    if (isDM(res)) return { list, known: new Set() };
    const known = knownIds(db, W(res), me(res));
    return { list: list.filter((s) => s.public || known.has(s.id)), known };
  }

  r.get('/', (_req, res) => {
    const s = S(res);
    const b = srd();
    const custom = all<any>(db, 'SELECT source, attribution, COUNT(*) AS n FROM spells_custom WHERE world_id = ? GROUP BY source, attribution ORDER BY source', W(res));
    const rules = R(res);
    res.json({
      srd: { name: b.name, version: b.version, license: b.license, attribution: b.attribution, count: b.spells.length },
      sources: isDM(res) ? custom.map((x) => ({ source: x.source, attribution: x.attribution, count: x.n })) : [...new Set(custom.map((x) => x.attribution).filter(Boolean))].map((a) => ({ attribution: a })),
      mana: { on: rules.on, costs: rules.costs, rest: rules.rest, maxLevel: rules.maxLevel.on, overdraw: rules.overdraw },
      crafting: { on: craftOn(s), approval: featureSetting<string>(s, 'spellCraftApproval'), hidden: featureSetting<string>(s, 'spellCraftHidden') },
      playerStats: featureSetting<boolean>(s, 'spellPlayerStats') !== false,
      publicSrd: publicSrd(s),
    });
  });

  // The spell rules engine's settings (Spell_Plan.md) and the preview tables. Nothing secret: players read it too.
  r.get('/rules', (_req, res) => {
    const s = S(res);
    const rules = resolveRules(featureSetting(s, 'spellRules'));
    res.json({ rules, preview: preview(R(res).costs, rules) });
  });

  r.get('/list', (req, res) => {
    const { list, known } = visibleCatalog(res);
    const f = queryFrom(req.query as Record<string, unknown>);
    let found = search(list, f);
    if (req.query.known === '1' && !isDM(res)) found = found.filter((s) => known.has(s.id));
    if (isDM(res) && req.query.public === '1') found = found.filter((s) => s.public);
    if (isDM(res) && req.query.public === '0') found = found.filter((s) => !s.public);
    const limit = Math.max(1, Math.min(5000, Number(req.query.limit) || 100));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const rules = R(res);
    const full = req.query.full === '1';
    res.json({
      total: found.length,
      spells: found.slice(offset, offset + limit).map((s) => {
        const o: any = spellOut(s, isDM(res), rules, known.has(s.id));
        if (!full) delete o.text;
        return o;
      }),
    });
  });

  r.get('/facets', (_req, res) => res.json(facets(visibleCatalog(res).list)));

  r.get('/s/:id', (req, res) => {
    const s = spellById(db, W(res), String(req.params.id), publicSrd(S(res)));
    if (!s) throw new HttpError(404, 'Spell not found');
    const known = !isDM(res) && knownIds(db, W(res), me(res)).has(s.id);
    if (!isDM(res) && !s.public && !known) throw new HttpError(404, 'Spell not found');
    res.json(spellOut(s, isDM(res), R(res), known));
  });

  // ---- the DM's own spells, settings per spell, import and export ----
  const changed = (res: Response) => d.hub.emit(W(res), 'spells', {}, everyone);

  r.post('/s', requireDM, (req, res) => {
    const s = normalizeSpell({ ...(req.body ?? {}), source: req.body?.source || 'Homebrew' }, 'Homebrew');
    const sid = saveCustom(db, W(res), s, 'homebrew');
    applyMeta(res, sid, req.body ?? {});
    audit(db, W(res), me(res), 'spells.create', s.name);
    changed(res);
    res.json(spellOut(spellById(db, W(res), sid, publicSrd(S(res)))!, true, R(res)));
  });

  r.put('/s/:id', requireDM, (req, res) => {
    const cur = spellById(db, W(res), String(req.params.id));
    if (!cur) throw new HttpError(404, 'Spell not found');
    if (cur.builtin) throw new HttpError(400, 'SRD spells cannot be edited; change their mana cost, notes or who may read them, or make a homebrew copy');
    const s = normalizeSpell({ ...cur, ...(req.body ?? {}), source: req.body?.source ?? cur.source }, cur.source);
    saveCustom(db, W(res), s, cur.kind === 'import' ? 'import' : 'homebrew', cur.attribution, cur.id);
    applyMeta(res, cur.id, req.body ?? {});
    audit(db, W(res), me(res), 'spells.edit', s.name);
    changed(res);
    res.json(spellOut(spellById(db, W(res), cur.id, publicSrd(S(res)))!, true, R(res)));
  });

  r.delete('/s/:id', requireDM, (req, res) => {
    const cur = spellById(db, W(res), String(req.params.id));
    if (!cur || cur.builtin) throw new HttpError(cur ? 400 : 404, cur ? 'SRD spells cannot be removed' : 'Spell not found');
    const used = recipes(db, W(res)).filter((x) => x.resultId === cur.id || x.prereqs.includes(cur.id));
    if (used.length) throw new HttpError(409, `${cur.name} is used by ${used.length} recipe${used.length === 1 ? '' : 's'}; change those first`);
    tx(db, () => {
      run(db, 'DELETE FROM spells_custom WHERE world_id = ? AND id = ?', W(res), cur.id);
      run(db, 'DELETE FROM spells_meta WHERE world_id = ? AND spell_id = ?', W(res), cur.id);
      run(db, 'DELETE FROM spells_known WHERE world_id = ? AND spell_id = ?', W(res), cur.id);
    });
    audit(db, W(res), me(res), 'spells.delete', cur.name);
    changed(res);
    res.json({ ok: true });
  });

  function applyMeta(res: Response, sid: string, b: any) {
    const patch: any = {};
    if (b.public !== undefined) patch.public = b.public === true;
    if (b.manaOverride !== undefined) {
      const n = b.manaOverride === null || b.manaOverride === '' ? null : Number(b.manaOverride);
      if (n !== null && (!Number.isInteger(n) || n < 0 || n > 999)) throw new HttpError(400, 'The mana cost must be 0 to 999, or empty for the table');
      patch.manaCost = n;
    }
    if (b.dmNotes !== undefined) patch.dmNotes = String(b.dmNotes ?? '').slice(0, 4000);
    if (Object.keys(patch).length) setMeta(db, W(res), sid, patch);
  }

  r.put('/s/:id/meta', requireDM, (req, res) => {
    const s = spellById(db, W(res), String(req.params.id));
    if (!s) throw new HttpError(404, 'Spell not found');
    applyMeta(res, s.id, req.body ?? {});
    changed(res);
    res.json(spellOut(spellById(db, W(res), s.id, publicSrd(S(res)))!, true, R(res)));
  });

  r.post('/public', requireDM, (req, res) => {
    const b = req.body ?? {};
    const ids: string[] = Array.isArray(b.ids) ? b.ids.map(String).slice(0, 5000) : [];
    const on = b.public === true;
    let n = 0;
    tx(db, () => { for (const sid of ids) if (spellById(db, W(res), sid)) { setMeta(db, W(res), sid, { public: on }); n++; } });
    changed(res);
    res.json({ changed: n });
  });

  r.get('/export', requireDM, (req, res) => {
    const own = catalog(db, W(res)).filter((s) => !s.builtin);
    if (req.query.format === 'csv') { res.type('text/csv').send(toCsv(own)); return; }
    res.json({ spells: own.map((s) => ({ ...spellOut(s, true, R(res)), id: undefined, line: undefined, componentsText: undefined })) });
  });

  r.post('/import/preview', requireDM, (req, res) => {
    const read = readImport(d, W(res), req.body ?? {});
    const dupes = read.spells.filter((s) => findDup(res, s.name, s.source)).length;
    res.json({ source: read.source, attribution: read.attribution, count: read.spells.length, duplicates: dupes, sample: read.spells.slice(0, 5).map((s) => ({ name: s.name, level: s.level, school: s.school, source: s.source, line: spellLine(s) })), warnings: read.warnings });
  });
  const findDup = (res: Response, name: string, source: string) => !!one(db, 'SELECT 1 FROM spells_custom WHERE world_id = ? AND name = ? COLLATE NOCASE AND source = ? COLLATE NOCASE', W(res), name, source) || (source === 'SRD 5.2.1' && srd().spells.some((x) => x.name.toLowerCase() === name.toLowerCase()));

  r.post('/import', requireDM, (req, res) => {
    const read = readImport(d, W(res), req.body ?? {});
    const out = tx(db, () => saveImport(d, W(res), read, req.body?.replace === true));
    if (req.body?.public === true) for (const a of [...out.added, ...out.replaced]) setMeta(db, W(res), a.id, { public: true });
    audit(db, W(res), me(res), 'spells.import', `${read.source}: ${out.added.length} added, ${out.replaced.length} replaced, ${out.skipped.length} skipped`);
    changed(res);
    res.json({ ...out, warnings: read.warnings });
  });

  // ---- characters: sheet, known spells, mana ----
  r.get('/characters', requireDM, (_req, res) => {
    const rules = R(res);
    res.json({ characters: playerIds(db, W(res)).map((aid) => ({ ...charOut(db, W(res), character(db, W(res), aid), rules), known: knownRows(db, W(res), aid).length })) });
  });

  r.get('/characters/:aid', (req, res) => {
    const aid = who(res, req.params.aid);
    const rules = R(res);
    const list = catalog(db, W(res), publicSrd(S(res)));
    const known = knownRows(db, W(res), aid);
    const kset = new Set(known.map((k) => k.spellId));
    res.json({ ...charOut(db, W(res), character(db, W(res), aid), rules), known: list.filter((s) => kset.has(s.id)).map((s) => ({ ...spellOut(s, isDM(res), rules, true), how: known.find((k) => k.spellId === s.id)?.how ?? '' })) });
  });

  r.put('/characters/:aid', requirePlayerOrDM, (req, res) => {
    const aid = who(res, req.params.aid);
    const b = req.body ?? {};
    const dm = isDM(res);
    if (!dm && featureSetting<boolean>(S(res), 'spellPlayerStats') === false) throw new HttpError(403, 'The DM keeps your ability scores in this world');
    const patch: Parameters<typeof saveCharacter>[3] = {};
    if (b.class !== undefined) patch.class = String(b.class ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (b.level !== undefined) {
      const n = b.level === null || b.level === '' ? null : Number(b.level);
      if (n !== null && (!Number.isInteger(n) || n < 1 || n > 20)) throw new HttpError(400, 'The level must be 1 to 20');
      patch.level = n;
    }
    if (b.abilities !== undefined) {
      if (!b.abilities || typeof b.abilities !== 'object') throw new HttpError(400, 'abilities must be an object like {"int": 13}');
      const ab: any = {};
      for (const [k, v] of Object.entries(b.abilities)) {
        if (!(ABILITIES as readonly string[]).includes(k)) throw new HttpError(400, `Unknown ability: ${k.slice(0, 20)}`);
        const n = v === null || v === '' ? null : Number(v);
        if (n !== null && (!Number.isInteger(n) || n < 1 || n > 30)) throw new HttpError(400, `${ABILITY_NAMES[k as Ability]} must be 1 to 30`);
        ab[k] = n;
      }
      patch.abilities = ab;
    }
    if (b.castingAbility !== undefined) {
      if (b.castingAbility && !['int', 'wis', 'cha'].includes(b.castingAbility)) throw new HttpError(400, 'The spellcasting ability must be int, wis or cha');
      patch.castingAbility = b.castingAbility || '';
    }
    if (b.manaMax !== undefined) {
      if (!dm) throw new HttpError(403, 'Only the DM sets a mana maximum by hand');
      const n = b.manaMax === null || b.manaMax === '' ? null : Number(b.manaMax);
      if (n !== null && (!Number.isInteger(n) || n < 0 || n > 9999)) throw new HttpError(400, 'The mana maximum must be 0 to 9999, or empty for the formula');
      patch.manaMax = n;
    }
    saveCharacter(db, W(res), aid, patch);
    if (!dm) audit(db, W(res), me(res), 'spells.sheet', JSON.stringify(patch).slice(0, 300));
    emitChar(d, W(res), aid);
    res.json(charOut(db, W(res), character(db, W(res), aid), R(res)));
  });

  r.post('/characters/:aid/known', requireDM, (req, res) => {
    const aid = who(res, req.params.aid);
    const s = findSpell(db, W(res), String(req.body?.spellId ?? req.body?.spell ?? ''));
    if (!s) throw new HttpError(404, 'Spell not found');
    if (addKnown(db, W(res), aid, s.id, 'dm')) logEntry(db, W(res), aid, 'learn', me(res), { spellId: s.id, note: `Given by the DM: ${s.name}` });
    emitChar(d, W(res), aid);
    res.json({ ok: true, spellId: s.id });
  });

  r.delete('/characters/:aid/known/:sid', requireDM, (req, res) => {
    const aid = who(res, req.params.aid);
    const sid = String(req.params.sid);
    if (!run(db, 'DELETE FROM spells_known WHERE world_id = ? AND account_id = ? AND spell_id = ?', W(res), aid, sid)) throw new HttpError(404, 'Not a known spell');
    logEntry(db, W(res), aid, 'forget', me(res), { spellId: sid, note: `Removed by the DM: ${spellById(db, W(res), sid)?.name ?? sid}` });
    emitChar(d, W(res), aid);
    res.json({ ok: true });
  });

  r.post('/characters/:aid/mana', requireDM, (req, res) => {
    const aid = who(res, req.params.aid);
    const rules = R(res);
    if (!rules.on) throw new HttpError(409, 'Mana is off in this world');
    const b = req.body ?? {};
    const c = character(db, W(res), aid);
    const max = poolMax(c, rules);
    const cur = poolNow(c, max) ?? 0;
    let next: number;
    if (b.full === true) next = max ?? cur;
    else if (b.set !== undefined) next = Number(b.set);
    else next = cur + Number(b.delta);
    if (!Number.isInteger(next) || next < -9999 || next > 99999) throw new HttpError(400, 'Send delta (a whole number), set (the new amount) or full: true');
    saveCharacter(db, W(res), aid, { mana: next });
    logEntry(db, W(res), aid, 'adjust', me(res), { amount: next - cur, manaAfter: next, note: String(b.note ?? '').slice(0, 200) || 'Adjusted by the DM' });
    audit(db, W(res), me(res), 'spells.mana', `${aid} ${cur} -> ${next}`);
    emitChar(d, W(res), aid);
    res.json(charOut(db, W(res), character(db, W(res), aid), rules));
  });

  r.post('/cast', requirePlayerOrDM, (req, res) => {
    const b = req.body ?? {};
    const aid = who(res, b.accountId ?? 'me');
    const rules = R(res);
    const s = spellById(db, W(res), String(b.spellId ?? ''));
    if (!s) throw new HttpError(404, 'Spell not found');
    const known = knownIds(db, W(res), aid);
    if (!isDM(res) && !known.has(s.id)) throw new HttpError(s.public ? 403 : 404, s.public ? 'You do not know this spell' : 'Spell not found');
    const at = b.level === undefined || b.level === null || b.level === '' ? s.level : Number(b.level);
    if (!Number.isInteger(at) || at < s.level || at > 9) throw new HttpError(400, `Cast it at level ${s.level} to 9`);
    if (!rules.on) {
      logEntry(db, W(res), aid, 'cast', me(res), { spellId: s.id, note: `${s.name}${at > s.level ? ` at level ${at}` : ''}` });
      emitChar(d, W(res), aid);
      return res.json({ ok: true, cost: 0, mana: null });
    }
    const out = tx(db, () => {
      const c = character(db, W(res), aid);
      const max = poolMax(c, rules);
      if (max === null) throw new HttpError(409, 'Set the character level (or a mana maximum) first');
      const lim = maxCastLevel(c, rules);
      if (lim !== null && at > lim && at > 0) throw new HttpError(409, `At level ${c.level ?? '?'} mana casts spells of level ${lim} or lower`);
      const cur = poolNow(c, max) ?? max;
      const cost = castCost(s, at, rules);
      if (cur - cost < 0 && !rules.overdraw) throw new HttpError(409, `Not enough mana: ${s.name}${at > s.level ? ` at level ${at}` : ''} costs ${cost}, you have ${cur}`);
      saveCharacter(db, W(res), aid, { mana: cur - cost });
      logEntry(db, W(res), aid, 'cast', me(res), { spellId: s.id, amount: -cost, manaAfter: cur - cost, note: `${s.name}${at > s.level ? ` at level ${at}` : ''}` });
      return { cost, mana: cur - cost, max };
    });
    emitChar(d, W(res), aid);
    res.json({ ok: true, ...out });
  });

  r.post('/rest', requireDM, (req, res) => {
    const kind = req.body?.kind === 'short' ? 'short' : req.body?.kind === 'long' ? 'long' : null;
    if (!kind) throw new HttpError(400, 'kind must be long or short');
    const rules = R(res);
    if (!rules.on) throw new HttpError(409, 'Mana is off in this world');
    const only = Array.isArray(req.body?.accountIds) ? req.body.accountIds.map(String).filter((x: string) => playerIds(db, W(res)).includes(x)) : undefined;
    res.json({ characters: applyRest(W(res), kind, rules, me(res), only) });
  });

  r.get('/log', (req, res) => {
    const aid = isDM(res) ? (req.query.account ? who(res, req.query.account) : null) : me(res);
    const rows = all<any>(db, `SELECT * FROM spells_log WHERE world_id = ? ${aid ? 'AND account_id = ?' : ''} ORDER BY at DESC, rowid DESC LIMIT 200`, W(res), ...(aid ? [aid] : []));
    res.json({ log: rows.map((x) => ({ id: x.id, accountId: x.account_id, kind: x.kind, spellId: x.spell_id, amount: x.amount, manaAfter: x.mana_after, note: x.note, by: x.by_id, at: x.at })) });
  });

  // ---- crafting: recipes ----
  const nameOf = (res: Response) => { const m = new Map(catalog(db, W(res)).map((s) => [s.id, s.name])); return (sid: string) => m.get(sid) ?? 'Unknown spell'; };
  const recipesChanged = (res: Response) => d.hub.emit(W(res), 'spells-recipes', {}, everyone);

  function recipeOut(res: Response, rc: Recipe, tier: number, el: Eligibility | null, holdings?: (n: string) => number) {
    const pub = publicSrd(S(res));
    const result = spellById(db, W(res), rc.resultId, pub);
    const base = {
      id: rc.id, tier,
      result: spellStub(result, rc.resultId),
      prereqs: rc.prereqs.map((p) => spellStub(spellById(db, W(res), p, pub), p)),
      items: rc.items.map((it) => ({ ...it, ...(holdings ? { have: holdings(it.name) } : {}) })),
      stats: rc.stats, minLevel: rc.minLevel, manaCost: rc.manaCost,
      ...(el ? { status: el.status, missing: el.missing, met: el.met, total: el.total } : {}),
    };
    return isDM(res) ? { ...base, visibility: rc.visibility, dmNotes: rc.dmNotes, draft: rc.draft, createdBy: rc.createdBy, createdAt: rc.createdAt, updatedAt: rc.updatedAt } : base;
  }

  r.get('/recipes', (req, res) => {
    const all_ = recipes(db, W(res));
    const t = tiers(all_.filter((x) => !x.draft));
    if (isDM(res)) {
      const tAll = tiers(all_);
      return res.json({ recipes: all_.map((x) => recipeOut(res, x, tAll.get(x.id) ?? 1, null)) });
    }
    if (!craftOn(S(res))) return res.json({ enabled: false, recipes: [], mystery: 0 });
    const live = all_.filter((x) => !x.draft);
    const hidden = live.filter((x) => x.visibility === 'hidden');
    res.json({ enabled: true, recipes: live.filter((x) => x.visibility === 'visible').map((x) => recipeOut(res, x, t.get(x.id) ?? 1, null)), mystery: featureSetting<string>(S(res), 'spellCraftHidden') === 'hide' ? 0 : hidden.length });
    void req;
  });

  const resolver = (res: Response) => (ref: string) => findSpell(db, W(res), ref);

  r.post('/recipes', requireDM, (req, res) => {
    const x = normalizeRecipe(req.body ?? {}, resolver(res));
    const rid = id('rcp_');
    run(db, 'INSERT INTO spells_recipes (id, world_id, result_id, prereqs, items, stats, min_level, mana_cost, visibility, dm_notes, draft, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      rid, W(res), x.resultId, JSON.stringify(x.prereqs), JSON.stringify(x.items), JSON.stringify(x.stats), x.minLevel, x.manaCost, x.visibility, x.dmNotes, x.draft ? 1 : 0, req.body?.createdBy === 'assistant' ? 'assistant' : me(res), now(), now());
    audit(db, W(res), me(res), x.draft ? 'spells.recipe.draft' : 'spells.recipe.create', nameOf(res)(x.resultId));
    recipesChanged(res);
    const rc = recipeById(db, W(res), rid)!;
    res.json(recipeOut(res, rc, tiers(recipes(db, W(res))).get(rid) ?? 1, null));
  });

  r.put('/recipes/:rid', requireDM, (req, res) => {
    const cur = recipeById(db, W(res), String(req.params.rid));
    if (!cur) throw new HttpError(404, 'Recipe not found');
    const x = normalizeRecipe({ result: cur.resultId, prereqs: cur.prereqs, items: cur.items, stats: cur.stats, minLevel: cur.minLevel, manaCost: cur.manaCost, visibility: cur.visibility, dmNotes: cur.dmNotes, draft: cur.draft, ...(req.body ?? {}) }, resolver(res));
    run(db, 'UPDATE spells_recipes SET result_id = ?, prereqs = ?, items = ?, stats = ?, min_level = ?, mana_cost = ?, visibility = ?, dm_notes = ?, draft = ?, updated_at = ? WHERE world_id = ? AND id = ?',
      x.resultId, JSON.stringify(x.prereqs), JSON.stringify(x.items), JSON.stringify(x.stats), x.minLevel, x.manaCost, x.visibility, x.dmNotes, x.draft ? 1 : 0, now(), W(res), cur.id);
    audit(db, W(res), me(res), 'spells.recipe.edit', nameOf(res)(x.resultId));
    recipesChanged(res);
    res.json(recipeOut(res, recipeById(db, W(res), cur.id)!, tiers(recipes(db, W(res))).get(cur.id) ?? 1, null));
  });

  r.post('/recipes/:rid/approve', requireDM, (req, res) => {
    if (!run(db, 'UPDATE spells_recipes SET draft = 0, updated_at = ? WHERE world_id = ? AND id = ?', now(), W(res), String(req.params.rid))) throw new HttpError(404, 'Recipe not found');
    audit(db, W(res), me(res), 'spells.recipe.approve', String(req.params.rid));
    recipesChanged(res);
    res.json({ ok: true });
  });

  r.delete('/recipes/:rid', requireDM, (req, res) => {
    const rid = String(req.params.rid);
    if (!run(db, 'DELETE FROM spells_recipes WHERE world_id = ? AND id = ?', W(res), rid)) throw new HttpError(404, 'Recipe not found');
    run(db, "UPDATE spells_learn SET status = 'cancelled', reason = 'The recipe was removed', decided_at = ? WHERE world_id = ? AND recipe_id = ? AND status = 'pending'", now(), W(res), rid);
    audit(db, W(res), me(res), 'spells.recipe.delete', rid);
    recipesChanged(res);
    res.json({ ok: true });
  });

  /** Recipes by spell name, for moving them between worlds. */
  r.get('/recipes/export', requireDM, (_req, res) => {
    const n = nameOf(res);
    res.json({ format: 'alexandria-spell-recipes', version: 1, recipes: recipes(db, W(res)).map((x) => ({ result: n(x.resultId), prereqs: x.prereqs.map(n), items: x.items, stats: x.stats, minLevel: x.minLevel, manaCost: x.manaCost, visibility: x.visibility, dmNotes: x.dmNotes, draft: x.draft })) });
  });

  r.post('/recipes/import', requireDM, (req, res) => {
    const b = req.body ?? {};
    let list = b.recipes ?? b.json;
    if (typeof list === 'string') { try { list = JSON.parse(list); } catch { throw new HttpError(400, 'That is not valid JSON'); } }
    if (list && !Array.isArray(list) && Array.isArray(list.recipes)) list = list.recipes;
    if (!Array.isArray(list) || list.length > 2000) throw new HttpError(400, 'Send recipes: a list of up to 2000 recipes');
    const res2 = { added: 0, skipped: [] as string[] };
    const existing = recipes(db, W(res));
    const sig = (x: { resultId: string; prereqs: string[] }) => `${x.resultId}|${[...x.prereqs].sort().join(',')}`;
    const have = new Set(existing.map(sig));
    tx(db, () => {
      if (b.replace === true) { run(db, 'DELETE FROM spells_recipes WHERE world_id = ?', W(res)); have.clear(); }
      list.forEach((raw: any, i: number) => {
        let x;
        try { x = normalizeRecipe(raw, resolver(res)); } catch (e: any) { res2.skipped.push(`Recipe ${i + 1}: ${e.message}`); return; }
        if (have.has(sig(x))) { res2.skipped.push(`Recipe ${i + 1}: already there`); return; }
        have.add(sig(x));
        run(db, 'INSERT INTO spells_recipes (id, world_id, result_id, prereqs, items, stats, min_level, mana_cost, visibility, dm_notes, draft, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
          id('rcp_'), W(res), x.resultId, JSON.stringify(x.prereqs), JSON.stringify(x.items), JSON.stringify(x.stats), x.minLevel, x.manaCost, x.visibility, x.dmNotes, x.draft ? 1 : 0, me(res), now(), now());
        res2.added++;
      });
    });
    audit(db, W(res), me(res), 'spells.recipe.import', `${res2.added} added, ${res2.skipped.length} skipped`);
    recipesChanged(res);
    res.json(res2);
  });

  // ---- the codex of one character: learned, learnable now, and what is next ----
  function codexFor(res: Response, aid: string) {
    const s = S(res);
    const rules = R(res);
    const c = character(db, W(res), aid);
    const max = poolMax(c, rules);
    const manaNow = poolNow(c, max);
    const known = knownIds(db, W(res), aid);
    const list = catalog(db, W(res), publicSrd(s));
    const knownRowsList = knownRows(db, W(res), aid);
    const learned = list.filter((x) => known.has(x.id)).map((x) => ({ ...spellOut(x, isDM(res), rules, true), how: knownRowsList.find((k) => k.spellId === x.id)?.how ?? '' }));
    const on = craftOn(s);
    const dm = isDM(res);
    const all_ = recipes(db, W(res)).filter((x) => !x.draft);
    const t = tiers(all_);
    const pending = new Map(all<any>(db, "SELECT id, recipe_id FROM spells_learn WHERE world_id = ? AND account_id = ? AND status = 'pending'", W(res), aid).map((x) => [x.recipe_id, x.id]));
    const n = nameOf(res);
    const hold = (nm: string) => holding(db, W(res), aid, nm);
    const shown = all_.filter((x) => dm || x.visibility === 'visible');
    const rows = on || dm ? shown.map((x) => {
      const el = eligibility(db, W(res), x, c, known, n, { on: rules.on, now: manaNow });
      return { ...recipeOut(res, x, t.get(x.id) ?? 1, el, hold), pending: pending.get(x.id) ?? null };
    }) : [];
    const mystery = !on || dm || featureSetting<string>(s, 'spellCraftHidden') === 'hide' ? [] : all_.filter((x) => x.visibility === 'hidden' && !known.has(x.resultId)).map((x) => ({ mystery: true, buildsOnKnown: x.prereqs.some((p) => known.has(p)) }));
    const reqs = all<any>(db, 'SELECT * FROM spells_learn WHERE world_id = ? AND account_id = ? ORDER BY at DESC LIMIT 30', W(res), aid);
    return {
      crafting: { on, approval: featureSetting<string>(s, 'spellCraftApproval'), playerStats: featureSetting<boolean>(s, 'spellPlayerStats') !== false },
      character: charOut(db, W(res), c, rules),
      learned,
      ready: rows.filter((x) => x.status === 'ready'),
      next: rows.filter((x) => x.status === 'locked').sort((a, b) => (b.met ?? 0) / (b.total || 1) - (a.met ?? 0) / (a.total || 1) || a.tier - b.tier),
      learnedRecipes: rows.filter((x) => x.status === 'learned').map((x) => x.id),
      mystery,
      requests: reqs.map((x) => learnOut(res, x)),
    };
  }

  r.get('/codex', (req, res) => {
    if (ctx(res).viewer.role === 'guest') return res.json({ crafting: { on: false }, character: null, learned: [], ready: [], next: [], mystery: [], requests: [] });
    const aid = isDM(res) ? (req.query.account ? who(res, req.query.account) : null) : me(res);
    if (!aid) throw new HttpError(400, 'Choose a character: ?account=<id>');
    res.json(codexFor(res, aid));
  });

  // ---- learning: request, approve or reject ----
  function learnOut(res: Response, x: any) {
    const sp = spellById(db, W(res), x.spell_id);
    return { id: x.id, accountId: x.account_id, recipeId: x.recipe_id, spellId: x.spell_id, spell: sp?.name ?? 'Unknown spell', status: x.status, note: x.note, reason: x.reason, consumed: parseJson(x.consumed, []), at: x.at, decidedAt: x.decided_at };
  }
  const learnEvent = (res: Response, x: { id: string; account_id: string; status: string }) => d.hub.emit(W(res), 'spells-learn', { id: x.id, accountId: x.account_id, status: x.status }, dmAnd(x.account_id));

  /** Learn it now: check again, use up the items the recipe consumes, pay the mana, add the spell, log it. Inside a transaction. */
  function complete(res: Response, rc: Recipe, aid: string, by: string, force: boolean): { consumed: { name: string; qty: number }[] } {
    const rules = R(res);
    const c = character(db, W(res), aid);
    const known = knownIds(db, W(res), aid);
    const max = poolMax(c, rules);
    const manaNow = poolNow(c, max);
    const el = eligibility(db, W(res), rc, c, known, nameOf(res), { on: rules.on, now: manaNow });
    if (el.status === 'learned') throw new HttpError(409, 'Already known');
    // The DM may approve anyway (force): what is there is used up and mana does not go below zero.
    if (el.status !== 'ready' && !force) throw new HttpError(409, `Not ready: ${el.missing.map(missingText).join('; ')}`);
    const consumed: { name: string; qty: number }[] = [];
    for (const it of rc.items.filter((x) => x.consumed)) {
      let left = it.qty;
      const key = it.name.replace(/\s+/g, ' ').trim().toLowerCase();
      const rows = all<any>(db, "SELECT * FROM items WHERE world_id = ? AND owner = ? AND status = 'approved' ORDER BY qty, updated_at", W(res), aid).filter((x) => String(x.name).replace(/\s+/g, ' ').trim().toLowerCase() === key);
      for (const row of rows) {
        if (left <= 0) break;
        const take = Math.min(left, Number(row.qty) || 0);
        left -= take;
        const after = Number(row.qty) - take;
        const snap = (q: number) => JSON.stringify({ owner: row.owner, name: row.name, qty: q, weight: row.weight ?? null, note: row.note ?? '', dm_note: row.dm_note ?? '', link: row.link ?? null, image: row.image ?? null });
        if (after <= 0) run(db, 'DELETE FROM items WHERE id = ?', row.id);
        else run(db, 'UPDATE items SET qty = ?, updated_at = ?, updated_by = ? WHERE id = ?', after, now(), by, row.id);
        // The owner is told, as for any change the DM makes to their things.
        if (by !== aid) run(db, `INSERT INTO item_changes (id, world_id, item_id, owner, kind, before_json, after_json, reason, by_id, at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'alert')`,
          id('chg_'), W(res), row.id, aid, after <= 0 ? 'remove' : 'edit', snap(Number(row.qty)), after <= 0 ? null : snap(after), `Used up learning ${nameOf(res)(rc.resultId)}`, by, now());
        if (after <= 0) d.hub.emit(W(res), 'item-removed', { id: row.id }, dmAnd(aid));
        else d.hub.emit(W(res), 'item', { id: row.id, owner: aid, name: row.name, qty: after, note: row.note, link: row.link, image: row.image ?? null, status: 'approved' }, dmAnd(aid));
      }
      if (left > 0 && !force) throw new HttpError(409, `Not enough ${it.name}`);
      consumed.push({ name: it.name, qty: it.qty - left });
    }
    if (rc.manaCost && rules.on) {
      const cur = manaNow ?? 0;
      if (cur < rc.manaCost && !force) throw new HttpError(409, 'Not enough mana');
      saveCharacter(db, W(res), aid, { mana: force ? Math.max(0, cur - rc.manaCost) : cur - rc.manaCost });
    }
    addKnown(db, W(res), aid, rc.resultId, 'crafted');
    logEntry(db, W(res), aid, 'learn', by, { spellId: rc.resultId, amount: rc.manaCost && rules.on ? -rc.manaCost : null, note: `Learned ${nameOf(res)(rc.resultId)} from ${rc.prereqs.map(nameOf(res)).join(' + ')}${consumed.length ? `, using ${consumed.map((x) => `${x.qty} × ${x.name}`).join(', ')}` : ''}` });
    return { consumed };
  }

  r.post('/learn', requirePlayerOrDM, (req, res) => {
    const b = req.body ?? {};
    const aid = who(res, isDM(res) ? b.accountId : 'me');
    if (!isDM(res) && !craftOn(S(res))) throw new HttpError(403, 'Spell crafting is off in this world');
    const rc = recipeById(db, W(res), String(b.recipeId ?? ''));
    if (!rc || (!isDM(res) && (rc.draft || rc.visibility !== 'visible'))) throw new HttpError(404, 'Recipe not found');
    if (rc.draft) throw new HttpError(409, 'Approve the draft recipe first');
    if (one(db, "SELECT 1 FROM spells_learn WHERE world_id = ? AND account_id = ? AND recipe_id = ? AND status = 'pending'", W(res), aid, rc.id)) throw new HttpError(409, 'Already asked; waiting for the DM');
    const rules = R(res);
    const c = character(db, W(res), aid);
    const el = eligibility(db, W(res), rc, c, knownIds(db, W(res), aid), nameOf(res), { on: rules.on, now: poolNow(c, poolMax(c, rules)) });
    if (el.status === 'learned') throw new HttpError(409, 'Already known');
    if (el.status !== 'ready') throw new HttpError(409, `Not yet: ${el.missing.map(missingText).join('; ')}`);
    const lid = id('lrn_');
    const auto = isDM(res) || featureSetting<string>(S(res), 'spellCraftApproval') === 'auto';
    const row = tx(db, () => {
      run(db, 'INSERT INTO spells_learn (id, world_id, account_id, recipe_id, spell_id, status, note, at) VALUES (?,?,?,?,?,?,?,?)', lid, W(res), aid, rc.id, rc.resultId, 'pending', String(b.note ?? '').slice(0, 300), now());
      if (auto) {
        const done = complete(res, rc, aid, me(res), false);
        run(db, "UPDATE spells_learn SET status = 'approved', consumed = ?, decided_at = ?, decided_by = ? WHERE id = ?", JSON.stringify(done.consumed), now(), me(res), lid);
      }
      return one<any>(db, 'SELECT * FROM spells_learn WHERE id = ?', lid);
    });
    audit(db, W(res), me(res), auto ? 'spells.learn' : 'spells.learn.request', `${aid} ${nameOf(res)(rc.resultId)}`);
    learnEvent(res, row);
    if (auto) emitChar(d, W(res), aid);
    res.json(learnOut(res, row));
  });

  r.get('/learn', (req, res) => {
    if (ctx(res).viewer.role === 'guest') return res.json({ requests: [] });
    const rows = isDM(res)
      ? all<any>(db, `SELECT * FROM spells_learn WHERE world_id = ? ${req.query.status ? 'AND status = ?' : ''} ORDER BY (status = 'pending') DESC, at DESC LIMIT 200`, W(res), ...(req.query.status ? [String(req.query.status)] : []))
      : all<any>(db, 'SELECT * FROM spells_learn WHERE world_id = ? AND account_id = ? ORDER BY at DESC LIMIT 100', W(res), me(res));
    res.json({ requests: rows.map((x) => learnOut(res, x)) });
  });

  const pendingReq = (res: Response, lid: string) => {
    const x = one<any>(db, 'SELECT * FROM spells_learn WHERE world_id = ? AND id = ?', W(res), lid);
    if (!x || (!isDM(res) && x.account_id !== me(res))) throw new HttpError(404, 'Request not found');
    if (x.status !== 'pending') throw new HttpError(409, `This request is already ${x.status}`);
    return x;
  };

  r.post('/learn/:lid/approve', requireDM, (req, res) => {
    const x = pendingReq(res, String(req.params.lid));
    const rc = recipeById(db, W(res), x.recipe_id);
    if (!rc) throw new HttpError(409, 'The recipe was removed');
    const row = tx(db, () => {
      const done = complete(res, rc, x.account_id, me(res), req.body?.force === true);
      run(db, "UPDATE spells_learn SET status = 'approved', consumed = ?, reason = ?, decided_at = ?, decided_by = ? WHERE id = ?", JSON.stringify(done.consumed), String(req.body?.reason ?? '').slice(0, 300), now(), me(res), x.id);
      return one<any>(db, 'SELECT * FROM spells_learn WHERE id = ?', x.id);
    });
    audit(db, W(res), me(res), 'spells.learn.approve', `${x.account_id} ${nameOf(res)(rc.resultId)}`);
    learnEvent(res, row);
    emitChar(d, W(res), x.account_id);
    res.json(learnOut(res, row));
  });

  r.post('/learn/:lid/reject', requireDM, (req, res) => {
    const x = pendingReq(res, String(req.params.lid));
    run(db, "UPDATE spells_learn SET status = 'rejected', reason = ?, decided_at = ?, decided_by = ? WHERE id = ?", String(req.body?.reason ?? '').slice(0, 300), now(), me(res), x.id);
    const row = one<any>(db, 'SELECT * FROM spells_learn WHERE id = ?', x.id);
    learnEvent(res, row);
    res.json(learnOut(res, row));
  });

  r.post('/learn/:lid/cancel', requirePlayerOrDM, (req, res) => {
    const x = pendingReq(res, String(req.params.lid));
    run(db, "UPDATE spells_learn SET status = 'cancelled', decided_at = ? WHERE id = ?", now(), x.id);
    const row = one<any>(db, 'SELECT * FROM spells_learn WHERE id = ?', x.id);
    learnEvent(res, row);
    res.json(learnOut(res, row));
  });

  return r;
}

export function missingText(m: import('./craft.ts').Missing): string {
  switch (m.kind) {
    case 'spell': return `know ${m.name}`;
    case 'item': return `${m.need} × ${m.name} (have ${m.have})`;
    case 'stat': return `${ABILITY_NAMES[m.ability]} ${m.need} (${m.have ?? 'not set'})`;
    case 'level': return `level ${m.need} (${m.have ?? 'not set'})`;
    case 'mana': return `${m.need} mana (${m.have ?? 'none'})`;
  }
}

const enc = encodeURIComponent;
const qs = (a: Record<string, unknown>) => Object.entries(a).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${k}=${enc(String(v))}`).join('&');

const feature: Feature = {
  id: 'spells',
  schema: SCHEMA,
  settings: {
    spellMana: { type: 'boolean', default: false },
    spellManaCosts: { type: 'json', default: DEFAULT_COSTS, validate: checkCosts },
    spellManaPool: { type: 'json', default: DEFAULT_POOL, validate: checkPool },
    spellManaRest: { type: 'json', default: DEFAULT_REST, validate: checkRest },
    spellManaMaxLevel: { type: 'json', default: DEFAULT_MAX_LEVEL, validate: checkMaxLevel },
    spellManaOverdraw: { type: 'boolean', default: false },
    spellRules: { type: 'json', default: {}, validate: checkSpellRules },
    spellCrafting: { type: 'boolean', default: false },
    spellCraftApproval: { type: 'enum', values: ['dm', 'auto'], default: 'dm' },
    spellCraftHidden: { type: 'enum', values: ['mystery', 'hide'], default: 'mystery' },
    spellPlayerStats: { type: 'boolean', default: true },
    spellsPublicSrd: { type: 'boolean', default: false },
  },
  worldMount: 'spells',
  worldRoutes: routes,
  mcpTools: [
    {
      name: 'list_spells',
      description: "Search the world's spell list (the Codex: SRD 5.2.1 spells plus the DM's homebrew and imports) by name and filters. Returns each spell's id, level, school, casting time, range, components and mana cost. Players get only spells they know or the DM made public.",
      props: {
        query: { type: 'string', description: 'Words in the name' },
        level: { type: 'string', description: 'A level (0 for cantrips), a list like 1,2 or a range like 1-3' },
        school: { type: 'string' }, class: { type: 'string', description: 'A class whose list has the spell, e.g. Wizard' },
        concentration: { type: 'boolean' }, ritual: { type: 'boolean' },
        damage: { type: 'string', description: 'Damage type, e.g. Fire' }, save: { type: 'string', description: 'Saving throw ability, e.g. Dexterity' },
        castingTime: { type: 'string', description: 'action, bonus, reaction or words in the casting time' },
        limit: { type: 'number', description: 'At most this many (default 20)' },
      },
      call: (a) => ({ method: 'GET', path: `/spells/list?${qs({ q: a.query, level: a.level, school: a.school, class: a.class, concentration: a.concentration === undefined ? undefined : a.concentration ? 1 : 0, ritual: a.ritual === undefined ? undefined : a.ritual ? 1 : 0, damage: a.damage, save: a.save, castingTime: a.castingTime, limit: a.limit ?? 20 })}` }),
    },
    {
      name: 'read_spell',
      description: 'Read one spell from the Codex in full (description, components, duration, mana cost) by the id list_spells returned.',
      props: { id: { type: 'string', description: 'Spell id, like srd:fireball' } },
      required: ['id'],
      call: (a) => ({ method: 'GET', path: `/spells/s/${enc(a.id)}` }),
    },
    {
      name: 'list_spell_recipes', dmOnly: true,
      description: 'DM: the spell crafting recipes of this world (result spell, prerequisite spells, items, minimum ability scores and level, mana to learn, who sees it, drafts and DM notes), and their tier.',
      props: {},
      call: () => ({ method: 'GET', path: '/spells/recipes' }),
    },
    {
      name: 'draft_spell_recipe', write: true,
      description: 'DM: suggest a spell crafting recipe: combining 1 to 5 known spells (and optionally items, minimum ability scores, a minimum level, a mana cost) teaches the result spell, e.g. Fire Bolt + Burning Hands -> Scorching Ray. Spells by name or id from list_spells. It is saved as a draft that players never see until the DM approves it in the recipe editor.',
      props: {
        result: { type: 'string', description: 'The spell learned' },
        prereqs: { type: 'array', items: { type: 'string' }, description: '1 to 5 spells the character must know' },
        items: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, qty: { type: 'integer' }, consumed: { type: 'boolean' } } }, description: 'Items needed (by name), optionally used up' },
        stats: { type: 'object', description: 'Minimum ability scores, e.g. {"int": 13}' },
        minLevel: { type: 'integer' }, manaCost: { type: 'integer', description: 'Mana spent to learn it' },
        visibility: { type: 'string', enum: ['visible', 'hidden'], description: 'Players see the recipe, or only "???"' },
        dmNotes: { type: 'string', description: 'Why, for the DM only' },
      },
      required: ['result', 'prereqs'],
      call: (a) => ({ method: 'POST', path: '/spells/recipes', body: { result: a.result, prereqs: a.prereqs, items: a.items, stats: a.stats, minLevel: a.minLevel, manaCost: a.manaCost, visibility: a.visibility, dmNotes: a.dmNotes, draft: true, createdBy: 'assistant' } }),
    },
    {
      name: 'my_spell_codex', playerOnly: true,
      description: "The asking player's own spell codex: spells they know, mana, and the spell recipes they can learn now or what each still needs.",
      props: {},
      call: () => ({ method: 'GET', path: '/spells/codex' }),
    },
  ],
};
export default feature;

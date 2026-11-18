// Generators hub (DM only): NPCs, monsters, taverns, maps and names from tables
// and code, made to fit this world, with no model needed. A model, when set,
// only improves the text of a result. Players never reach any of it; a result
// reaches them only when the DM saves it at party level or sends it to the stage.
//
//   GET  /api/worlds/:world/generators/options            presets, flavours, kinds, the party level, whether a model is set
//   POST /api/worlds/:world/generators/generate           { kind, preset, seed, options, locks, enrich } -> a result
//   POST /api/worlds/:world/generators/save               the same spec + { level: dm|party, path } -> a library page (+ map files)
//   POST /api/worlds/:world/generators/stage              the same spec + { show, to } -> a stage card (public text, and the map picture)
//   GET  /api/worlds/:world/generators/library            "My generated": saved generator pages
//   GET  /api/worlds/:world/generators/bestiary           module monsters by CR and type
//   GET  /api/worlds/:world/generators/names              quick names (any kind)
//   MCP  generate, generate_map, save_generated (DM only)
import { Router } from 'express';
import type { Feature } from '../types.ts';
import { requireDM } from '../../core/auth.ts';
import { hasJob } from '../../core/ai.ts';
import { run } from '../../core/db.ts';
import { HttpError, now } from '../../core/util.ts';
import { ctx, me, settings } from '../../routes/_shared.ts';
import { statblockMarkdown } from '../agent/statblock.ts';
import { GENDERS, NAME_STYLES, RACES } from '../quickgen/api.ts';
import { worldModules } from '../modules/store.ts';
import { selfCall } from '../sculpt/outputs.ts';
import { firstLeak, makeCtx } from '../sculpt/ctx.ts';
import { crLabel, crRow } from './cr.ts';
import { generate, generateOffline, KINDS, poolOf, publicText, renderMd, type Ctx, type Spec } from './gen.ts';
import { DUNGEON_FLAVOUR_NAMES } from './maps/dungeon.ts';
import { BATTLE_THEME_NAMES } from './maps/battlemap.ts';
import { FOREST_THEMES } from './maps/forest.ts';
import { TAVERN_FLAVOURS } from './maps/tavern.ts';
import { MAP_KINDS, SIZES, toPng } from './maps/index.ts';
import { MONSTER_PRESETS, MONSTER_TYPES } from './monster.ts';
import { NPC_PRESETS } from './npc.ts';
import { PLACE_FLAVOURS, PLACE_KINDS } from './names.ts';
import { saveOut } from './save.ts';
import { TAVERN_PRESETS } from './tavern.ts';
import { loadWorld } from './world.ts';

const S = (description: string, extra: Record<string, unknown> = {}) => ({ type: 'string', description, ...extra });
const N = (description: string) => ({ type: 'integer', description });
const B = (description: string) => ({ type: 'boolean', description });

/** Turn bad-argument errors from a generator into 400s. */
function guard<T>(fn: () => T): T {
  try { return fn(); } catch (e) {
    if (e instanceof RangeError) throw new HttpError(400, e.message);
    throw e;
  }
}

const OPTION_KEYS = ['race', 'gender', 'cr', 'partyLevel', 'partySize', 'statblock', 'nameStyle', 'type', 'boss', 'concept', 'name', 'base', 'useParty', 'flavour', 'size', 'theme', 'nameKind', 'count', 'style', 'mapKind'];

/** A spec from a request body: only known keys, all plain values. */
function specOf(b: any): Spec {
  const kind = String(b?.kind ?? '').toLowerCase();
  if (!(KINDS as readonly string[]).includes(kind)) throw new HttpError(400, `kind must be one of ${KINDS.join(', ')}`);
  const options: Record<string, any> = {};
  const src = b?.options && typeof b.options === 'object' ? b.options : {};
  for (const k of OPTION_KEYS) { const v = src[k]; if (v !== undefined && v !== null && v !== '' && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) options[k] = typeof v === 'string' ? v.slice(0, 500) : v; }
  const locks: Record<string, string> = {};
  if (b?.locks && typeof b.locks === 'object' && !Array.isArray(b.locks)) for (const [k, v] of Object.entries(b.locks)) if (typeof v === 'string' && v.trim() && /^[a-z_]{1,24}$/.test(k)) locks[k] = v.slice(0, 4000);
  return { kind: kind as Spec['kind'], preset: typeof b?.preset === 'string' && b.preset ? b.preset.slice(0, 40) : undefined, seed: b?.seed === undefined || b?.seed === null || b?.seed === '' ? undefined : String(b.seed).slice(0, 64), options, locks, enrich: b?.enrich === true };
}

/** What a result looks like in a response: the map picture is left out of the compact form the agent gets. */
const view = (out: any, compact: boolean) => {
  const { map_result, _owner, ...rest } = out;
  void map_result; void _owner;
  if (compact && rest.map) { const { svg, ...m } = rest.map; void svg; rest.map = m; }
  return { ...rest, md: renderMd(out, 'dm'), publicText: publicText(out), ...(out.statblock ? { statblockMd: statblockMarkdown(out.statblock).replace(/\n*```statblock-json[\s\S]*?```\n*/g, '\n') } : {}) };
};

const feature: Feature = {
  id: 'generators',
  worldMount: 'generators',
  worldRoutes: (d) => {
    const r = Router({ mergeParams: true });
    r.use(requireDM);
    const W = (res: any): string => ctx(res).world.id;
    const context = async (res: any): Promise<Ctx> => {
      const world = await loadWorld(d, W(res), String(settings(res).coins ?? 'gsc'));
      return { d, world, pool: poolOf(d, W(res)), hasModel: hasJob(d, 'chat') };
    };

    r.get('/options', async (_req, res) => {
      const world = await loadWorld(d, W(res), String(settings(res).coins ?? 'gsc'));
      const monsters = poolOf(d, W(res)).length;
      res.json({
        kinds: KINDS,
        npc: { presets: NPC_PRESETS, races: RACES, genders: GENDERS, nameStyles: NAME_STYLES },
        monster: { presets: MONSTER_PRESETS, types: MONSTER_TYPES, crs: [0, 0.125, 0.25, 0.5, ...Array.from({ length: 30 }, (_x, i) => i + 1)].map((c) => ({ value: c, label: crLabel(c) })), bestiary: monsters },
        tavern: { flavours: TAVERN_PRESETS, sizes: SIZES },
        map: { kinds: MAP_KINDS, sizes: SIZES, dungeon: DUNGEON_FLAVOUR_NAMES, tavern: TAVERN_FLAVOURS, battlemap: BATTLE_THEME_NAMES, forest: FOREST_THEMES },
        names: { kinds: ['person', ...PLACE_KINDS], flavours: PLACE_FLAVOURS, styles: NAME_STYLES, races: RACES, genders: GENDERS },
        model: hasJob(d, 'chat'), coins: world.coins, partyLevel: world.partyLevel,
        world: { places: world.places.length, factions: world.factions.length },
      });
    });

    r.post('/generate', async (req, res) => {
      const spec = specOf(req.body);
      const c = await context(res);
      let out;
      try { out = await generate(c, spec); } catch (e) { if (e instanceof RangeError) throw new HttpError(400, e.message); throw e; }
      res.json(view(out, req.query.compact === '1'));
    });

    r.post('/save', async (req, res) => {
      const spec = specOf(req.body);
      const c = await context(res);
      const out = guard(() => generateOffline(c, spec));
      // Text the model improved is carried in the locks the page sends back, so the saved page matches what the DM saw.
      const saved = saveOut(d, W(res), me(res), out, { level: req.body?.level, path: typeof req.body?.path === 'string' ? req.body.path.slice(0, 300) : undefined });
      res.status(201).json({ ...saved, title: out.title, seed: out.seed });
    });

    r.post('/stage', async (req, res) => {
      const spec = specOf(req.body);
      const c = await context(res);
      const out = guard(() => generateOffline(c, spec));
      const text = publicText(out);
      const hit = firstLeak(makeCtx(d, W(res), false, {}), text);
      if (hit) throw new HttpError(409, 'Not sent: the text repeats words from DM-only notes.');
      const show = req.body?.show === true;
      const to = Array.isArray(req.body?.to) ? req.body.to : undefined;
      const done: Record<string, unknown> = {};
      if (out.map_result) {
        // The picture players get has none of the DM's marks.
        const png = toPng(out.map_result.canvas, { dm: false });
        const up = await selfCall(req, W(res), 'POST', '/stage/images', { dataBase64: png.toString('base64') });
        const card = await selfCall(req, W(res), 'POST', '/stage/cards', { kind: 'image', ref: up.id, caption: out.title, show, to });
        done.imageCardId = card.id;
      }
      if (!out.map_result || out.kind === 'tavern') {
        const card = await selfCall(req, W(res), 'POST', '/stage/cards', { kind: 'text', title: out.title, text, show, to });
        done.cardId = card.id;
      }
      run(d.db, 'INSERT INTO audit (world_id, account_id, action, detail, at) VALUES (?, ?, ?, ?, ?)', W(res), me(res), 'generators.stage', `${out.kind} ${out.title}`.slice(0, 500), now());
      res.status(201).json({ ok: true, shown: show, ...done });
    });

    r.get('/names', async (req, res) => {
      const c = await context(res);
      const o: Record<string, unknown> = {};
      for (const k of ['nameKind', 'race', 'gender', 'style', 'flavour', 'count']) if (typeof req.query[k] === 'string') o[k] = req.query[k];
      const out = guard(() => generateOffline(c, { kind: 'names', seed: typeof req.query.seed === 'string' ? req.query.seed : undefined, options: o as any }));
      res.json({ seed: out.seed, names: out.names, subtitle: out.subtitle });
    });

    r.get('/library', (req, res) => {
      const q = String(req.query.q ?? '').trim().toLowerCase();
      const kind = String(req.query.kind ?? '').trim().toLowerCase();
      const rows = (d.library.list(W(res), ctx(res).viewer) as any[]).filter((p) => (p.tags as string[]).includes('generated'))
        .filter((p) => !kind || (p.tags as string[]).includes(`gen-${kind}`))
        .filter((p) => !q || `${p.title} ${p.path} ${(p.tags as string[]).join(' ')}`.toLowerCase().includes(q));
      rows.sort((a, b) => String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? '')));
      res.json({
        pages: rows.slice(0, 300).map((p) => ({ id: p.id, path: p.path, title: p.title, kind: ((p.tags as string[]).find((t) => t.startsWith('gen-')) ?? 'gen-other').slice(4), preset: (p.tags as string[]).find((t) => !['generated'].includes(t) && !t.startsWith('gen-')) ?? '', level: p.visibility, updatedAt: p.updated_at })),
        total: rows.length,
      });
    });

    r.get('/bestiary', (req, res) => {
      const q = String(req.query.q ?? '').trim().toLowerCase().slice(0, 100);
      const type = String(req.query.type ?? '').trim().toLowerCase();
      const lo = req.query.crMin === undefined || req.query.crMin === '' ? 0 : Number(req.query.crMin);
      const hi = req.query.crMax === undefined || req.query.crMax === '' ? 30 : Number(req.query.crMax);
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) throw new HttpError(400, 'crMin and crMax must be numbers');
      const limit = Math.max(1, Math.min(200, Math.floor(Number(req.query.limit ?? 60)) || 60));
      const offset = Math.max(0, Math.floor(Number(req.query.offset ?? 0)) || 0);
      const wm = worldModules(d.db, W(res));
      const all: any[] = [];
      const types = new Set<string>();
      for (const t of wm.terms) {
        if (t.kind !== 'monster' || !t.data || typeof t.data !== 'object') continue;
        const x: any = t.data;
        const ty = String(x.type ?? '').toLowerCase();
        if (ty) types.add(ty);
        const cr = typeof x.cr === 'number' ? x.cr : Number(x.cr);
        if (!Number.isFinite(cr)) continue;
        if (type && !ty.startsWith(type)) continue;
        if (cr < lo || cr > hi) continue;
        if (q && !`${t.term} ${ty}`.toLowerCase().includes(q)) continue;
        all.push({ id: t.ref, name: t.term, cr, crLabel: crLabel(cr), type: ty, size: x.size ?? '', ac: x.ac ?? null, hp: x.hp ?? null, xp: x.xp ?? crRow(cr).xp, module: t.moduleName });
      }
      all.sort((a, b) => a.cr - b.cr || a.name.localeCompare(b.name));
      res.json({ total: all.length, monsters: all.slice(offset, offset + limit), types: [...types].sort(), modules: wm.enabled.map((m) => ({ id: m.id, name: m.name, attribution: m.attribution })) });
    });

    return r;
  },

  mcpTools: [
    {
      name: 'generate', dmOnly: true,
      description: 'Generate something for the table from tables and code (no model needed), made to fit this world: an NPC (preset tavern-keeper, villain, shopkeeper, noble, wizard, rogue, cleric, quest-giver, town-guard, dwarf, elf, random), a monster (preset dragon, undead, demon, aberration, beast, construct, elemental, fey, boss, low-cr, random, homebrew with a concept; a statblock the combat tracker can import), a tavern (preset common, dwarven, elven, pirate, haunted), a map (see generate_map) or names (name_kind person, tavern, inn, town, guild, magic shop...). A seed repeats the result. Nothing is saved; use save_generated for that.',
      props: { kind: S('npc, monster, tavern, map or names', { enum: ['npc', 'monster', 'tavern', 'map', 'names'] }), preset: S('The preset for that kind, e.g. villain, dragon, pirate'), seed: S('Optional seed for a repeatable result'), race: S('NPC or names: race'), gender: S('NPC or names: male, female or any'), cr: S('Monster or NPC statblock: challenge rating, e.g. 1/4 or 5'), level: N('Party level 1-20, to fit a monster or an NPC statblock to the party'), party_size: N('Number of players'), concept: S('Monster homebrew: a sentence describing the creature'), name_kind: S('Names: person, tavern, inn, town, guild, magic shop, smithy, temple, keep or dungeon'), flavour: S('Names or map flavour'), statblock: B('NPC: include a quick statblock'), enrich: B('Let the chat model improve the wording (slower)') },
      call: (a) => ({ method: 'POST', path: '/generators/generate?compact=1', body: { kind: a.kind ?? 'npc', preset: a.preset, seed: a.seed, enrich: a.enrich === true, options: { race: a.race, gender: a.gender, cr: a.cr, partyLevel: a.level, partySize: a.party_size, concept: a.concept, nameKind: a.name_kind, flavour: a.flavour, statblock: a.statblock } } }),
    },
    {
      name: 'generate_map', dmOnly: true,
      description: 'Generate a map procedurally (no model): kind dungeon, cave, castle, tavern, battlemap, city, region or forest. Returns the keyed list, a legend and counts (rooms, whether everything connects); the picture is made when you save it. Same seed, same map. Sizes small, medium, large. Flavour: dungeon ruin/crypt/mine/sewer/temple/lair, tavern common/dwarven/elven/pirate/haunted. Theme: battlemap forest/ruins/river/camp/swamp/cliff/crossroads, forest forest/wilderness/swamp.',
      props: { kind: S('Map kind', { enum: ['dungeon', 'cave', 'castle', 'tavern', 'battlemap', 'city', 'region', 'forest'] }), seed: S('Optional seed for a repeatable map'), size: S('small, medium or large'), flavour: S('Dungeon or tavern flavour'), theme: S('Battlemap or forest theme') },
      call: (a) => ({ method: 'POST', path: '/generators/generate?compact=1', body: { kind: 'map', preset: a.kind ?? 'dungeon', seed: a.seed, options: { size: a.size, flavour: a.flavour, theme: a.theme } } }),
    },
    {
      name: 'save_generated', dmOnly: true, write: true,
      description: 'Save a generated NPC, monster, tavern, map or list of names to the library as a DM-only page (a map also as a picture file the Map page can use). Pass the same kind, preset and seed you generated (with the seed, the result is identical). Always DM level; the DM can share it with the party later.',
      props: { kind: S('npc, monster, tavern, map or names', { enum: ['npc', 'monster', 'tavern', 'map', 'names'] }), preset: S('The preset used'), seed: S('The seed of the result to save'), race: S('NPC or names: race'), gender: S('male, female or any'), cr: S('Challenge rating'), level: N('Party level'), concept: S('Monster homebrew concept'), name_kind: S('Names kind'), flavour: S('Flavour'), size: S('Map size'), theme: S('Map theme'), map_kind: S('For kind map: dungeon, cave, castle, tavern, battlemap, city, region or forest'), statblock: B('NPC: include a statblock'), path: S('Optional page path') },
      call: (a) => ({ method: 'POST', path: '/generators/save', body: { kind: a.kind ?? 'npc', preset: a.preset ?? a.map_kind, seed: a.seed, level: 'dm', path: a.path, options: { race: a.race, gender: a.gender, cr: a.cr, partyLevel: a.level, concept: a.concept, nameKind: a.name_kind, flavour: a.flavour, size: a.size, theme: a.theme, statblock: a.statblock } } }),
    },
  ],
};
export default feature;

// Quick generators: names, items and coin amounts, instantly, from tables and
// code (no model). api.ts is what other features import. DM only, except that
// a world can let players roll names (setting quickgenPlayers).
import { Router } from 'express';
import type { Feature } from '../types.ts';
import { featureSetting } from '../../core/policy.ts';
import { chatJson } from '../../core/ai.ts';
import { HttpError } from '../../core/util.ts';
import { ctx, isDM, settings } from '../../routes/_shared.ts';
import { ALL_RARITIES, GENDERS, RACES, TYPES, genCoins, genItems, genNames } from './api.ts';

const S = (description: string) => ({ type: 'string', description });
const N = (description: string) => ({ type: 'integer', description });

const qs = (o: Record<string, unknown>) => {
  const p = Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);
  return p.length ? `?${p.join('&')}` : '';
};

/** Run a generator; its bad-argument errors become 400s. */
function guard<T>(fn: () => T): T {
  try { return fn(); } catch (e) {
    if (e instanceof RangeError) throw new HttpError(400, e.message);
    throw e;
  }
}
const q = (v: unknown) => (typeof v === 'string' ? v : undefined);

const feature: Feature = {
  id: 'quickgen',
  settings: { quickgenPlayers: { type: 'boolean', default: false } },
  worldMount: 'quickgen',
  worldRoutes: (d) => {
    const r = Router({ mergeParams: true });

    // DM only. With quickgenPlayers on, players may roll names (and read the option lists).
    r.use((req, res, next) => {
      if (isDM(res)) return next();
      const role = ctx(res).viewer.role;
      const namesOnly = req.method === 'GET' && (req.path === '/names' || req.path === '/options');
      if (role === 'player' && featureSetting<boolean>(settings(res), 'quickgenPlayers') === true && namesOnly) return next();
      throw new HttpError(403, role === 'player' ? 'Quick generators are for the DM' : 'Not allowed');
    });

    r.get('/options', (_req, res) => {
      const dm = isDM(res);
      res.json({
        races: ['any', ...RACES], genders: ['any', ...GENDERS], nameStyles: ['default', 'virtue'],
        rarities: dm ? ['any', ...ALL_RARITIES] : [], types: dm ? ['any', ...TYPES] : [],
        modes: dm ? ['individual', 'hoard'] : [], coins: settings(res).coins, dm,
      });
    });

    r.get('/names', (req, res) => {
      res.json(guard(() => genNames({ race: q(req.query.race), gender: q(req.query.gender), count: req.query.count === undefined ? undefined : Number(req.query.count), seed: q(req.query.seed), style: q(req.query.style) })));
    });

    r.get('/items', (req, res) => {
      res.json(guard(() => genItems(d.db, ctx(res).world.id, { rarity: q(req.query.rarity), type: q(req.query.type), count: req.query.count === undefined ? undefined : Number(req.query.count), seed: q(req.query.seed) })));
    });

    r.get('/coins', (req, res) => {
      res.json(guard(() => genCoins({ mode: q(req.query.mode), level: q(req.query.level), cr: q(req.query.cr), seed: q(req.query.seed), coins: settings(res).coins })));
    });

    // Optional one-line flavour for a roll. Falls back to null (the page says nothing) when no model is set.
    r.post('/flavour', async (req, res) => {
      const what = String(req.body?.kind) === 'item' ? 'magic item' : String(req.body?.kind) === 'coins' ? 'treasure' : 'character';
      const text = String(req.body?.text ?? '').slice(0, 200);
      if (!text.trim()) throw new HttpError(400, 'text is required');
      const out = await chatJson<{ flavour?: string }>(d, 'audit', [
        { role: 'system', content: 'You help a D&D dungeon master. Reply with JSON only: {"flavour": "<one short vivid sentence, at most 25 words>"}.' },
        { role: 'user', content: `Give one sentence of flavour for this ${what}: ${text}` },
      ]);
      const f = typeof out?.flavour === 'string' ? out.flavour.trim().slice(0, 300) : '';
      res.json({ flavour: f || null });
    });

    return r;
  },
  mcpTools: [
    { name: 'generate_names', description: 'Roll fantasy names instantly by race (human, elf, half-elf, dwarf, halfling, gnome, half-orc, orc, tiefling, dragonborn, goliath, aasimar or any) and gender (male, female, any). A seed repeats the roll.', props: { race: S('Race, or any'), gender: S('male, female or any'), count: N('How many (default 10)'), seed: S('Optional seed for a repeatable roll') }, call: (a) => ({ method: 'GET', path: `/quickgen/names${qs({ race: a.race, gender: a.gender, count: a.count, seed: a.seed })}` }) },
    { name: 'generate_items', description: "Draw items from the world's game modules and its pages tagged item, by rarity (common, uncommon, rare, very rare, legendary, artifact, mundane, any) and type (weapon, armor, potion, ring, rod, scroll, staff, wand, wondrous item, ammunition, gear, any). Each comes with a gp price and the module term id.", props: { rarity: S('Rarity, or any'), type: S('Item type, or any'), count: N('How many (default 5)'), seed: S('Optional seed') }, call: (a) => ({ method: 'GET', path: `/quickgen/items${qs({ rarity: a.rarity, type: a.type, count: a.count, seed: a.seed })}` }) },
    { name: 'generate_coins', description: "Roll a coin amount: 'individual' (a creature's pocket) or 'hoard', for a party level (1-20) or a challenge rating. Coins follow the world's coin setting; the total is also given in copper.", props: { mode: S('individual or hoard'), level: N('Party level 1-20'), cr: S('Challenge rating (used when no level)'), seed: S('Optional seed') }, call: (a) => ({ method: 'GET', path: `/quickgen/coins${qs({ mode: a.mode, level: a.level, cr: a.cr, seed: a.seed })}` }) },
  ],
};
export default feature;

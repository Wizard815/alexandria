// Downtime activities: the tiers (common to legendary, each with a default
// length), the shape of an activity, and the ones that come with Alexandria.
// A world adds its own (the DM, or a player when the world allows it), and
// the DM can change or hide any of these per world.
import { HttpError } from '../../core/util.ts';

export const TIERS = ['common', 'uncommon', 'rare', 'very-rare', 'legendary'] as const;
export type Tier = (typeof TIERS)[number];
export const TIER_LABEL: Record<Tier, string> = { common: 'Common', uncommon: 'Uncommon', rare: 'Rare', 'very-rare': 'Very rare', legendary: 'Legendary' };
/** Work days each tier takes unless an activity says otherwise. The DM changes them in World settings (downtimeTierDays). */
export const DEFAULT_TIER_DAYS: Record<Tier, number> = { common: 1, uncommon: 3, rare: 7, 'very-rare': 30, legendary: 90 };

/** What finishing gives. `hidden`: the player only learns there is a reward, not what it is, until it is given. */
export interface Reward { text: string; cp: number; item: string; qty: number; hidden: boolean }
export const NO_REWARD: Reward = { text: '', cp: 0, item: '', qty: 1, hidden: false };

/**
 * Something a character spends downtime on. `days` is work days (null: the tier's default); `hoursPerDay` is how much of
 * a downtime day it takes, so an 8-hour task fills a day and a 1-hour "daily" task fits beside others (a legendary
 * vigil of 1 hour a day for a week). `link` ties it to another feature (spell crafting in the Codex, MANA study).
 */
export interface Activity {
  id: string;
  name: string;
  summary: string;
  tier: Tier;
  days: number | null;
  hoursPerDay: number;
  repeatable: boolean;
  reward: Reward;
  link: Link | null;
  tags: string[];
  /** A group activity: the party works on one shared task and its progress is everyone's together. */
  group: boolean;
}
export interface Link { kind: string; ref?: string }

export const MAX_DAYS = 3650;

const bad = (m: string) => new HttpError(400, m);
const text = (v: unknown, what: string, max: number, need = false): string => {
  if (v === undefined || v === null) { if (need) throw bad(`${what} is needed`); return ''; }
  if (typeof v !== 'string') throw bad(`${what} must be text`);
  const s = v.trim();
  if (need && !s) throw bad(`${what} is needed`);
  if (s.length > max) throw bad(`${what} is longer than ${max} characters`);
  return s;
};
const whole = (v: unknown, what: string, lo: number, hi: number): number => {
  const n = typeof v === 'string' && /^-?\d+$/.test(v.trim()) ? Number(v) : v;
  if (!Number.isInteger(n) || (n as number) < lo || (n as number) > hi) throw bad(`${what} must be a whole number from ${lo} to ${hi}`);
  return n as number;
};

/** "very rare", "Very-Rare", "legendary" → a tier, or null. */
export function tierOf(v: unknown): Tier | null {
  if (typeof v !== 'string') return null;
  const k = v.trim().toLowerCase().replace(/[\s_]+/g, '-');
  return (TIERS as readonly string[]).includes(k) ? (k as Tier) : null;
}

export function checkReward(v: unknown, at = 'reward'): Reward {
  if (v === undefined || v === null) return { ...NO_REWARD };
  if (typeof v === 'string') return { ...NO_REWARD, text: text(v, at, 400) };
  if (typeof v !== 'object' || Array.isArray(v)) throw bad(`${at} must be text or { text, cp, item, qty, hidden }`);
  const o = v as any;
  return {
    text: text(o.text, `${at}.text`, 400),
    cp: o.cp === undefined || o.cp === null ? (o.gp === undefined ? 0 : whole(o.gp, `${at}.gp`, 0, 1_000_000) * 100) : whole(o.cp, `${at}.cp`, 0, 100_000_000),
    item: text(o.item, `${at}.item`, 120),
    qty: o.qty === undefined || o.qty === null ? 1 : whole(o.qty, `${at}.qty`, 1, 999),
    hidden: o.hidden === true,
  };
}
export const hasReward = (r: Reward) => !!(r.text || r.cp || r.item);

/** Check an activity from the DM, a player, an import or the assistant. */
export function checkActivity(raw: any, id: string): Activity {
  if (!raw || typeof raw !== 'object') throw bad('An activity must be an object');
  const tier = raw.tier === undefined || raw.tier === null || raw.tier === '' ? 'common' : tierOf(raw.tier);
  if (!tier) throw bad(`tier must be one of: ${TIERS.join(', ')}`);
  const link = raw.link && typeof raw.link === 'object' ? { kind: text(raw.link.kind, 'link.kind', 40, true), ...(raw.link.ref ? { ref: text(raw.link.ref, 'link.ref', 120) } : {}) } : null;
  const tags = Array.isArray(raw.tags) ? raw.tags.slice(0, 8).map((t: unknown, i: number) => text(t, `tags[${i}]`, 30)).filter(Boolean) : [];
  return {
    id,
    name: text(raw.name, 'name', 80, true),
    summary: text(raw.summary, 'summary', 600),
    tier,
    days: raw.days === undefined || raw.days === null || raw.days === '' ? null : whole(raw.days, 'days', 1, MAX_DAYS),
    hoursPerDay: raw.hoursPerDay === undefined || raw.hoursPerDay === null ? 8 : whole(raw.hoursPerDay, 'hoursPerDay', 1, 24),
    repeatable: raw.repeatable === true,
    group: raw.group === true || raw.scope === 'group',
    reward: checkReward(raw.reward),
    link,
    tags,
  };
}

/**
 * The ready-made activities. They are data in the rule file (mods/downtime.alxmod.json, presets.downtimePremade), so a
 * DM's own version of the rule can ship its own list. Ids start with "pre-". A bad entry is skipped.
 */
export function premadeFrom(v: unknown): Activity[] {
  const out: Activity[] = [];
  for (const raw of Array.isArray(v) ? v.slice(0, 200) : []) {
    const pid = typeof raw?.id === 'string' && /^pre-[a-z0-9-]{1,40}$/.test(raw.id) ? raw.id : null;
    if (!pid || out.some((x) => x.id === pid)) continue;
    try { out.push(checkActivity(raw, pid)); } catch { /* skipped */ }
  }
  return out;
}

export function checkPremade(v: unknown) {
  if (!Array.isArray(v)) throw bad('downtimePremade must be a list of activities');
  v.slice(0, 200).forEach((raw: any, i) => {
    if (typeof raw?.id !== 'string' || !/^pre-[a-z0-9-]{1,40}$/.test(raw.id)) throw bad(`downtimePremade[${i}].id must start with "pre-"`);
    checkActivity(raw, raw.id);
  });
}

/** Tier of a spell by its level, for spell activities. */
export const tierForSpellLevel = (lvl: number): Tier => (lvl <= 1 ? 'common' : lvl <= 3 ? 'uncommon' : lvl <= 5 ? 'rare' : lvl <= 7 ? 'very-rare' : 'legendary');

export function checkTierDays(v: unknown) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw bad('downtimeTierDays must be { common, uncommon, rare, very-rare, legendary } in days');
  for (const [k, n] of Object.entries(v as object)) {
    if (!tierOf(k)) throw bad(`downtimeTierDays: ${k} is not a tier`);
    whole(n, `downtimeTierDays.${k}`, 1, MAX_DAYS);
  }
}

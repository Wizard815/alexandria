// Copied from Wizard815/DND-Spell-Tree src/tree/types.ts by scripts/sync-alexandria.sh: change it there.
// The shapes the spell tree view works with. They match Alexandria's
// `/spells/tree` and `/spells/study` routes, so the same view runs on the
// app's own data (src/local) or on an Alexandria world (src/alexandria).
// This folder is copied into Alexandria's web app as is: keep it free of
// imports from the rest of this app.

export type StudySource = 'alone' | 'text' | 'mentor';
export const SOURCES: StudySource[] = ['alone', 'text', 'mentor'];
export const SOURCE_LABEL: Record<StudySource, string> = { alone: 'Alone', text: 'With a text', mentor: 'With a mentor' };

export type TreeStatus = 'known' | 'gift' | 'studying' | 'stopped' | 'learn' | 'locked' | 'hidden' | 'dark';

export interface TreeSpell {
  id: string;
  name: string;
  level: number;
  school: string;
  /** Spell lines (elements) the spell belongs to; two or more makes it a hybrid. */
  lines: string[];
  hybrid: boolean;
  status: TreeStatus;
  /** What is still missing before studying can start. */
  missing: string[];
  /** The spells that teach it (its recipe). */
  from: string[];
  study?: { id: string; banked: number; needed: number };
  /** The school bubble it sits in (see TreeData.bubbles). */
  bubble?: string;
}

/** A bubble of about four spells of one school and level; it opens once a spell in its parent bubble is known. */
export interface TreeBubble { id: string; school: string; level: number; name: string; parent: string | null; spells: string[] }

export interface TreeData {
  engine: boolean;
  schools: { name: string; spells: TreeSpell[] }[];
  /** Present when the tree is grouped in bubbles. */
  bubbles?: TreeBubble[];
  hybrids: TreeSpell[];
  counts: Record<string, number>;
}

export interface StudyPlan {
  spellId: string;
  name: string;
  level: number;
  recipe: { id: string; prereqs: string[] } | null;
  source: StudySource;
  lab: boolean;
  hybrid: boolean;
  missing: string[];
  canStart: boolean;
  /** Starting needs an Arcana check against this DC (null: no check). */
  arcanaDC: number | null;
  needed: number;
  perDay: number;
  days: Record<StudySource, number | null>;
  materials: number;
  mentorFee: number;
  /** Gold in all for each way to study (materials, plus the mentor's fee). */
  gold?: Record<StudySource, number>;
  finalDC: number;
  checkBonus: number;
  scrollPoints: number;
  /** Its school bubble, when bubbles teach it. */
  bubble?: { id: string; name: string; open: boolean; parent: string | null } | null;
}

export type StudyStatus = 'studying' | 'ready' | 'learned' | 'stopped';

export interface Study {
  id: string;
  spellId: string;
  name: string;
  source: StudySource;
  lab: boolean;
  needed: number;
  banked: number;
  pendingDays: number;
  days: number;
  materials: number;
  mentorFee: number;
  scrollHelp: boolean;
  status: StudyStatus;
  waitLongRest: boolean;
  attempts: number;
  lastCheck: string;
  perDay: number;
  daysLeft: number;
}

export interface CheckOut {
  outcome: 'great' | 'success' | 'fail' | 'setback';
  learned: boolean;
  total: number;
  dc: number;
  d20: number;
  bonus: number;
  refund: number;
  coinLost: number;
  fatigue: number;
  study: Study;
}

export interface SpellDetail {
  id: string;
  name: string;
  level: number;
  school: string;
  castingTime?: string;
  range?: string;
  componentsText?: string;
  duration?: string;
  concentration?: boolean;
  ritual?: boolean;
  classes?: string[];
  damageTypes?: string[];
  text?: string;
  source?: string;
  /** The book it is from, when the app has no text for it. */
  book?: string;
}

export interface StartOptions { source: StudySource; lab: boolean; scroll: boolean; arcana?: number; /** DM: start even though requirements are missing. */ anyway?: boolean }

/** Where the tree's data comes from. Every call may throw an Error with a message to show. */
export interface TreeBackend {
  tree(): Promise<TreeData>;
  spell(id: string): Promise<SpellDetail | null>;
  plan(spellId: string, source: StudySource, lab: boolean): Promise<StudyPlan>;
  studies(): Promise<Study[]>;
  start(spellId: string, o: StartOptions): Promise<Study>;
  days(sid: string, n: number): Promise<Study>;
  check(sid: string, d20?: number): Promise<CheckOut>;
  scrollCast(sid: string): Promise<Study>;
  stop(sid: string): Promise<Study>;
  /** DM tools: give the spell now (it shows as a gift). Left out when the viewer is not the DM. */
  give?(spellId: string): Promise<unknown>;
  /** DM tools: whether `start` takes `anyway` to skip missing requirements. */
  canOverride?: boolean;
}

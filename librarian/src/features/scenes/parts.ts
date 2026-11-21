// A scene's parts as saved, checked and trimmed. Every part is optional; one that is not set leaves its room alone.
// Only the shape is checked here: whether a track, light preset, picture or card still exists is found out when the
// scene is activated (and reported per part), because the things a scene points at can change after it was saved.
import { HttpError, int, oneOf, str } from '../../core/util.ts';

export const TARGETS = ['table', 'players', 'both'] as const;
export type Target = (typeof TARGETS)[number];

export interface MediaState { mode: 'off' | 'queue' | 'slideshow' | 'focus'; prevMode?: 'queue' | 'slideshow'; currentId?: string | null; focusId?: string | null; playing?: boolean; loop?: boolean; intervalSec?: number }

export type TvPart =
  | { mode: 'off' }
  | { mode: 'item'; itemId: string }
  | { mode: 'folder'; folder: string; intervalSec?: number }
  | { mode: 'card'; cardId: string; spotlight?: boolean }
  | { mode: 'state'; state: MediaState };

export interface SoundPart {
  musicTrackId?: string;
  /** A saved ambience scene (name or id) ... */
  ambience?: string;
  /** ... or the layers themselves (what "save the current room" captures). */
  ambienceLayers?: { kind: string; volume: number; file?: string }[];
  volume?: number;
  target?: Target;
  fadeMs?: number;
  /** Stop the channels (music, ambience) this scene does not set. */
  stopOthers?: boolean;
}

export type LightsPart = { scene: string } | { off: true };
export interface TablePart { mapId?: string; pic?: string | null; fog?: 'keep' | { enabled: boolean; base: string | null; ops: unknown[] } }

export interface Parts { tv?: TvPart; sound?: SoundPart; lights?: LightsPart; table?: TablePart }
export const PART_KEYS = ['tv', 'sound', 'lights', 'table'] as const;
export type PartKey = (typeof PART_KEYS)[number];

const bool = (v: unknown) => v === true;
const unit = (v: unknown, f: string) => { const n = Number(v); if (v === '' || typeof v === 'boolean' || !Number.isFinite(n) || n < 0 || n > 1) throw new HttpError(400, `${f} must be from 0 to 1`); return Math.round(n * 100) / 100; };
const id = (v: unknown, f: string) => str(v, f, { max: 200 }).trim() || (() => { throw new HttpError(400, `${f} is required`); })();

function media(raw: any): MediaState {
  const mode = oneOf(raw?.mode, 'tv.state.mode', ['off', 'queue', 'slideshow', 'focus'] as const);
  const out: MediaState = { mode };
  if (raw.prevMode !== undefined) out.prevMode = oneOf(raw.prevMode, 'tv.state.prevMode', ['queue', 'slideshow'] as const);
  if (raw.currentId !== undefined && raw.currentId !== null) out.currentId = id(raw.currentId, 'tv.state.currentId'); else if (raw.currentId === null) out.currentId = null;
  if (raw.focusId !== undefined && raw.focusId !== null) out.focusId = id(raw.focusId, 'tv.state.focusId'); else if (raw.focusId === null) out.focusId = null;
  if (raw.playing !== undefined) out.playing = bool(raw.playing);
  if (raw.loop !== undefined) out.loop = bool(raw.loop);
  if (raw.intervalSec !== undefined) out.intervalSec = int(raw.intervalSec, 'tv.state.intervalSec', { min: 2, max: 3600 })!;
  return out;
}

function tv(raw: any): TvPart {
  const mode = oneOf(raw?.mode, 'tv.mode', ['off', 'item', 'folder', 'card', 'state'] as const);
  switch (mode) {
    case 'off': return { mode };
    case 'item': return { mode, itemId: id(raw.itemId, 'tv.itemId') };
    case 'folder': return { mode, folder: str(raw.folder, 'tv.folder', { max: 300, optional: true }).trim(), ...(raw.intervalSec ? { intervalSec: int(raw.intervalSec, 'tv.intervalSec', { min: 2, max: 3600 })! } : {}) };
    case 'card': return { mode, cardId: id(raw.cardId, 'tv.cardId'), ...(raw.spotlight ? { spotlight: true } : {}) };
    default: return { mode, state: media(raw.state) };
  }
}

function sound(raw: any): SoundPart {
  const out: SoundPart = {};
  if (raw.musicTrackId) out.musicTrackId = id(raw.musicTrackId, 'sound.musicTrackId');
  if (raw.ambience) out.ambience = id(raw.ambience, 'sound.ambience');
  if (Array.isArray(raw.ambienceLayers)) {
    if (raw.ambienceLayers.length > 12) throw new HttpError(400, 'sound.ambienceLayers can have up to 12 layers');
    out.ambienceLayers = raw.ambienceLayers.map((l: any, i: number) => ({ kind: str(l?.kind, `sound.ambienceLayers[${i}].kind`, { max: 40 }).toLowerCase(), volume: l?.volume === undefined ? 0.5 : unit(l.volume, `sound.ambienceLayers[${i}].volume`), ...(l?.file ? { file: String(l.file).slice(0, 200) } : {}) }));
  }
  if (out.ambience && out.ambienceLayers?.length) throw new HttpError(400, 'Give an ambience scene or ambience layers, not both');
  if (raw.volume !== undefined && raw.volume !== null && raw.volume !== '') out.volume = unit(raw.volume, 'sound.volume');
  if (raw.target) out.target = oneOf(raw.target, 'sound.target', TARGETS);
  if (raw.fadeMs !== undefined && raw.fadeMs !== null && raw.fadeMs !== '') out.fadeMs = int(raw.fadeMs, 'sound.fadeMs', { min: 0, max: 20_000 })!;
  if (raw.stopOthers) out.stopOthers = true;
  return out;
}

function table(raw: any): TablePart {
  const out: TablePart = {};
  if (raw.mapId) out.mapId = str(raw.mapId, 'table.mapId', { max: 60 }).trim();
  if (raw.pic !== undefined && raw.pic !== null && raw.pic !== '') out.pic = str(raw.pic, 'table.pic', { max: 200 }).trim();
  if (raw.fog && raw.fog !== 'keep') {
    const f = raw.fog;
    if (!Array.isArray(f.ops) || f.ops.length > 400) throw new HttpError(400, 'table.fog.ops must be a list of up to 400 strokes');
    const base = f.base === null || f.base === undefined ? null : str(f.base, 'table.fog.base', { max: 4000 });
    out.fog = { enabled: !!f.enabled, base, ops: f.ops };
  } else out.fog = 'keep';
  if (out.fog !== 'keep' && !out.mapId) throw new HttpError(400, 'A saved fog state needs the table map (mapId and pic) it belongs to');
  if (out.fog !== 'keep' && out.pic === undefined) out.pic = 'none';
  return out;
}

/** The parts of a request, checked. A part that is missing, null or empty is not set. */
export function cleanParts(raw: unknown): Parts {
  const b: any = raw && typeof raw === 'object' ? raw : {};
  const out: Parts = {};
  if (b.tv && typeof b.tv === 'object' && b.tv.mode) out.tv = tv(b.tv);
  if (b.sound && typeof b.sound === 'object') { const s = sound(b.sound); if (Object.keys(s).length) out.sound = s; }
  if (b.lights && typeof b.lights === 'object') {
    if (b.lights.off) out.lights = { off: true };
    else if (b.lights.scene) out.lights = { scene: id(b.lights.scene, 'lights.scene') };
  }
  if (b.table && typeof b.table === 'object') { const t = table(b.table); if (t.mapId || t.pic !== undefined) out.table = t; }
  return out;
}

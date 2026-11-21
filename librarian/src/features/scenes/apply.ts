// Activating a scene, undoing it, and capturing the room as a scene. Each part is applied through the same world API the
// DM's own controls use (so every check and live event is the ordinary one), one after the other, each in its own
// try/catch: a part that fails (a track that was deleted, no lights set up) is reported and the rest still happen.
// Before a part changes anything, what it is about to change is read, so "undo scene" can put it back.
import type { MediaState, Parts, PartKey, SoundPart, TablePart, TvPart } from './parts.ts';
import { PART_KEYS } from './parts.ts';

export type Call = (method: string, path: string, body?: unknown) => Promise<any>;

export interface PartReport { status: 'ok' | 'failed' | 'skipped'; detail?: string; error?: string }
export type Report = Partial<Record<PartKey, PartReport>>;

const enc = encodeURIComponent;
const msg = (e: any) => String(e?.message ?? e).slice(0, 240);

// ---- reading the room (for undo, and for "save the current room as a scene") ---------------------------------------------

export interface Snapshot {
  tv?: { media: MediaState; cardShown?: boolean; layout?: string; spotlightId?: string | null };
  sound?: { music: { id: string; volume: number; target: string } | null; ambience: { layers: { kind: string; volume: number; id?: string }[]; target: string } | null };
  lights?: { sceneId: string | null };
  table?: { mapId: string | null; pic: string | null; fog?: { mapId: string; pic: string; enabled: boolean; base: string | null; ops: unknown[] } };
}

async function mediaNow(call: Call): Promise<MediaState> {
  const m = await call('GET', '/screen/media');
  return { mode: m.focusId ? 'focus' : m.mode, prevMode: m.prevMode, currentId: m.currentId ?? null, focusId: m.focusId ?? null, playing: !!m.playing, loop: !!m.loop, intervalSec: m.intervalSec };
}

async function soundNow(call: Call): Promise<NonNullable<Snapshot['sound']>> {
  const s = await call('GET', '/sound/now');
  return {
    music: s.music ? { id: s.music.id, volume: s.music.volume, target: s.music.target } : null,
    ambience: s.ambience?.layers?.length ? { layers: s.ambience.layers.map((l: any) => ({ kind: l.kind, volume: l.volume, id: l.id })), target: s.ambience.target } : null,
  };
}

async function lightsNow(call: Call): Promise<{ sceneId: string | null }> {
  const s = await call('GET', '/lights/status');
  return { sceneId: s.lastScene?.sceneId ?? null };
}

async function tableNow(call: Call, want?: { mapId: string; pic: string }): Promise<NonNullable<Snapshot['table']>> {
  const t = await call('GET', '/fog/table');
  const out: NonNullable<Snapshot['table']> = { mapId: t.mapId, pic: t.pic };
  if (want) {
    const f = await call('GET', `/fog/map/${enc(want.mapId)}?pic=${enc(want.pic)}`);
    out.fog = { mapId: want.mapId, pic: want.pic, enabled: f.enabled, base: f.base, ops: f.ops };
  }
  return out;
}

/** Read what the parts of a scene would change, before they are applied. A part that cannot be read is simply not undoable. */
export async function snapshotFor(call: Call, parts: Parts): Promise<Snapshot> {
  const snap: Snapshot = {};
  const grab = async <T,>(f: () => Promise<T>): Promise<T | undefined> => { try { return await f(); } catch { return undefined; } };
  if (parts.tv) {
    const media = await grab(() => mediaNow(call));
    const stage = parts.tv.mode === 'card' ? await grab(() => call('GET', '/stage')) : undefined;
    if (media) snap.tv = { media, ...(stage ? { cardShown: !!stage.cards?.find((c: any) => c.id === (parts.tv as any).cardId)?.shownAt, layout: stage.layout, spotlightId: stage.spotlightId } : {}) };
  }
  if (parts.sound) snap.sound = await grab(() => soundNow(call));
  if (parts.lights) snap.lights = await grab(() => lightsNow(call));
  if (parts.table) {
    const cur = await grab(() => call('GET', '/fog/table'));
    const mapId = parts.table.mapId ?? cur?.mapId ?? 'world';
    const pic = parts.table.pic ?? cur?.pic ?? 'none';
    snap.table = await grab(() => tableNow(call, parts.table!.fog && parts.table!.fog !== 'keep' ? { mapId, pic } : undefined));
  }
  return snap;
}

// ---- applying --------------------------------------------------------------------------------------------------------------

/** Put a media state (the TV's mode, item, play/pause, loop, interval) back or into place. */
async function applyMediaState(call: Call, s: MediaState) {
  if (s.mode === 'off') { await call('PUT', '/screen/media', { mode: 'off' }); return; }
  const base = s.mode === 'focus' ? s.prevMode ?? 'queue' : s.mode;
  await call('PUT', '/screen/media', { mode: base, ...(s.currentId ? { currentId: s.currentId } : {}), ...(s.intervalSec ? { intervalSec: s.intervalSec } : {}), loop: !!s.loop });
  if (s.mode === 'focus' && s.focusId) await call('POST', '/screen/media/focus', { id: s.focusId });
  else if (s.playing === false) await call('PUT', '/screen/media', { playing: false });
}

async function applyTv(call: Call, p: TvPart): Promise<string> {
  switch (p.mode) {
    case 'off': await call('PUT', '/screen/media', { mode: 'off' }); return 'TV media off';
    case 'item': {
      // A focused item would hide the new one: leave focus first.
      await call('POST', '/screen/media/focus', { id: null });
      await call('PUT', '/screen/media', { mode: 'queue', currentId: p.itemId, playing: true });
      return 'showing a media item';
    }
    case 'folder': {
      const r = await call('POST', '/screen/media/folder', { folder: p.folder, ...(p.intervalSec ? { intervalSec: p.intervalSec } : {}) });
      return `slideshow of ${r.loaded} file${r.loaded === 1 ? '' : 's'}${r.skipped ? ` (${r.skipped} skipped)` : ''}`;
    }
    case 'card': {
      await call('POST', `/stage/cards/${enc(p.cardId)}/show`, { to: 'all', spotlight: !!p.spotlight });
      return p.spotlight ? 'card in the spotlight' : 'card shown';
    }
    default: await applyMediaState(call, p.state); return 'TV media set';
  }
}

async function applySound(call: Call, p: SoundPart): Promise<string> {
  const target = p.target ?? 'table';
  const done: string[] = [];
  const errors: string[] = [];
  const attempt = async (what: string, f: () => Promise<string>) => { try { done.push(await f()); } catch (e) { errors.push(`${what}: ${msg(e)}`); } };
  const hasMusic = !!p.musicTrackId, hasAmb = !!(p.ambience || p.ambienceLayers?.length);
  if (p.musicTrackId) await attempt('music', async () => {
    const r = await call('POST', '/sound/music/play', { trackId: p.musicTrackId, ...(p.volume !== undefined ? { volume: p.volume } : {}), ...(p.fadeMs !== undefined ? { fadeMs: p.fadeMs } : {}), target });
    return `music: ${r.track?.title ?? p.musicTrackId}${r.note ? ` (${r.note})` : ''}`;
  });
  if (hasAmb) await attempt('ambience', async () => {
    let layers = p.ambienceLayers;
    if (p.ambience) {
      // A volume on the scene scales each of its layers.
      if (p.volume !== undefined) {
        const list: any[] = await call('GET', '/sound/scenes');
        const want = p.ambience.trim().toLowerCase();
        const sc = list.find((x) => x.id === p.ambience || String(x.name).toLowerCase() === want);
        if (!sc) throw new Error('Ambience scene not found');
        layers = sc.layers.map((l: any) => ({ kind: l.kind, volume: Math.min(1, Math.round(l.volume * p.volume! * 100) / 100), ...(l.file ? { file: l.file } : {}) }));
      }
    } else if (layers && p.volume !== undefined) layers = layers.map((l) => ({ ...l, volume: Math.min(1, Math.round(l.volume * p.volume! * 100) / 100) }));
    const r = await call('POST', '/sound/ambience/scene', { ...(layers ? { layers } : { scene: p.ambience }), ...(p.fadeMs !== undefined ? { fadeMs: p.fadeMs } : {}), target });
    if (r.missing?.length) throw new Error(`no ambience layer for ${r.missing.join(', ')}`);
    return `ambience: ${r.layers?.length ?? 0} layer${r.layers?.length === 1 ? '' : 's'}${r.note ? ` (${r.note})` : ''}`;
  });
  if (p.stopOthers) {
    if (!hasMusic) await attempt('stop music', async () => { await call('POST', '/sound/music/stop', { ...(p.fadeMs !== undefined ? { fadeMs: p.fadeMs } : {}) }); return 'music stopped'; });
    if (!hasAmb) await attempt('stop ambience', async () => { await call('POST', '/sound/ambience/stop', { ...(p.fadeMs !== undefined ? { fadeMs: p.fadeMs } : {}), target }); return 'ambience stopped'; });
  }
  if (errors.length) throw new Error(errors.join('; ') + (done.length ? ` (done: ${done.join(', ')})` : ''));
  return done.join(', ') || 'nothing to change';
}

async function applyLights(call: Call, p: NonNullable<Parts['lights']>): Promise<string> {
  if ('off' in p) { await call('POST', '/lights/off', {}); return 'lights off'; }
  const r = await call('POST', `/lights/scenes/${enc(p.scene)}/run`, {});
  // A light bridge that is down cannot be told from here (sending is fire and forget); an empty rig can.
  if (!r.queued) throw new Error('The lights scene ran but no light groups are set up to show it');
  return `lights: ${r.scene?.name ?? p.scene} (${r.queued} group${r.queued === 1 ? '' : 's'})`;
}

async function applyTable(call: Call, p: TablePart): Promise<string> {
  const cur = await call('GET', '/fog/table');
  const mapId = p.mapId ?? cur.mapId ?? 'world';
  const pic = p.pic ?? cur.pic ?? 'none';
  await call('PUT', '/fog/table', { mapId, pic });
  if (p.fog && p.fog !== 'keep') {
    await call('PUT', `/fog/map/${enc(mapId)}/state`, { pic, enabled: p.fog.enabled, base: p.fog.base, ops: p.fog.ops });
    return `table map ${mapId}, fog ${p.fog.enabled ? 'restored' : 'off'}`;
  }
  return `table map ${mapId}`;
}

const APPLY: Record<PartKey, (call: Call, p: any) => Promise<string>> = { tv: applyTv, table: applyTable, sound: applySound, lights: applyLights };

/** Apply every set part, each on its own. Returns what happened per part (parts not in the scene are left out). */
export async function applyParts(call: Call, parts: Parts): Promise<Report> {
  const report: Report = {};
  for (const k of PART_KEYS) {
    const p = parts[k];
    if (!p) continue;
    try { report[k] = { status: 'ok', detail: await APPLY[k](call, p) }; } catch (e) { report[k] = { status: 'failed', error: msg(e) }; }
  }
  return report;
}

// ---- undo ------------------------------------------------------------------------------------------------------------------

export interface UndoReport { status: 'ok' | 'failed' | 'skipped'; detail?: string; error?: string; notRestored?: string[] }

/** Put back what the parts that worked had changed, as far as it can be: what cannot be is listed. */
export async function undoParts(call: Call, parts: Parts, snap: Snapshot, report: Report): Promise<Partial<Record<PartKey, UndoReport>>> {
  const out: Partial<Record<PartKey, UndoReport>> = {};
  const todo = (k: PartKey) => parts[k] && report[k]?.status === 'ok';
  for (const k of PART_KEYS) {
    if (!parts[k]) continue;
    if (!todo(k)) { out[k] = { status: 'skipped', detail: report[k]?.status === 'failed' ? 'the part failed, so nothing changed' : undefined }; continue; }
    const notRestored: string[] = [];
    try {
      const s = snap[k];
      if (!s) { out[k] = { status: 'skipped', notRestored: ['its previous state could not be read'] }; continue; }
      if (k === 'tv') {
        const t = parts.tv!, sn = snap.tv!;
        if (t.mode === 'card') {
          if (!sn.cardShown) await call('POST', `/stage/cards/${enc(t.cardId)}/hide`, {});
          if (sn.layout) await call('PUT', '/stage/layout', { layout: sn.layout, spotlightId: sn.spotlightId ?? null });
        } else {
          if (t.mode === 'folder') notRestored.push('the media queue the folder replaced (the previous mode and item are restored, not the items)');
          await applyMediaState(call, sn.media);
        }
      } else if (k === 'sound') {
        const sn = snap.sound!, t = parts.sound!;
        if (t.musicTrackId || t.stopOthers) {
          if (sn.music) await call('POST', '/sound/music/play', { trackId: sn.music.id, volume: sn.music.volume, target: sn.music.target, fadeMs: t.fadeMs ?? 1500 });
          else await call('POST', '/sound/music/stop', { fadeMs: t.fadeMs ?? 1500 });
        }
        if (t.ambience || t.ambienceLayers?.length || t.stopOthers) {
          if (sn.ambience) await call('POST', '/sound/ambience/scene', { layers: sn.ambience.layers.map((l) => ({ kind: l.kind, volume: l.volume, ...(l.id ? { file: l.id } : {}) })), target: sn.ambience.target, fadeMs: t.fadeMs ?? 1500 });
          else await call('POST', '/sound/ambience/stop', { target: t.target ?? 'both', fadeMs: t.fadeMs ?? 1500 });
        }
      } else if (k === 'lights') {
        const sn = snap.lights!;
        if (sn.sceneId) await call('POST', `/lights/scenes/${enc(sn.sceneId)}/run`, {});
        else { notRestored.push('the lights (no earlier preset was recorded to go back to)'); }
      } else {
        const sn = snap.table!;
        await call('PUT', '/fog/table', { mapId: sn.mapId, pic: sn.pic });
        if (sn.fog) await call('PUT', `/fog/map/${enc(sn.fog.mapId)}/state`, { pic: sn.fog.pic, enabled: sn.fog.enabled, base: sn.fog.base, ops: sn.fog.ops });
      }
      out[k] = { status: 'ok', ...(notRestored.length ? { notRestored } : {}) };
    } catch (e) { out[k] = { status: 'failed', error: msg(e), ...(notRestored.length ? { notRestored } : {}) }; }
  }
  return out;
}

// ---- "save the current room as a scene" --------------------------------------------------------------------------------------

/** What is on now, as scene parts. A part that has nothing to capture (no lights preset ever run) is left out. */
export async function captureParts(call: Call, include: PartKey[]): Promise<{ parts: Parts; notes: string[] }> {
  const parts: Parts = {};
  const notes: string[] = [];
  const has = (k: PartKey) => include.includes(k);
  if (has('tv')) {
    try {
      const m = await mediaNow(call);
      parts.tv = m.mode === 'off' ? { mode: 'off' } : { mode: 'state', state: m };
    } catch (e) { notes.push(`TV: ${msg(e)}`); }
  }
  if (has('sound')) {
    try {
      const s = await soundNow(call);
      parts.sound = {
        ...(s.music ? { musicTrackId: s.music.id, volume: s.music.volume } : {}),
        ...(s.ambience ? { ambienceLayers: s.ambience.layers.map((l) => ({ kind: l.kind, volume: l.volume, ...(l.id ? { file: l.id } : {}) })) } : {}),
        target: ((s.music?.target ?? s.ambience?.target ?? 'table') as SoundPart['target']),
        ...(!s.music && !s.ambience ? { stopOthers: true } : {}),
      };
    } catch (e) { notes.push(`Sound: ${msg(e)}`); }
  }
  if (has('lights')) {
    try {
      const l = await lightsNow(call);
      if (l.sceneId) parts.lights = { scene: l.sceneId };
      else notes.push('Lights: no lights preset has been run, so there is nothing to capture');
    } catch (e) { notes.push(`Lights: ${msg(e)}`); }
  }
  if (has('table')) {
    try {
      const t = await call('GET', '/fog/table');
      if (t.mapId || t.pic) {
        const mapId = t.mapId ?? 'world', pic = t.pic ?? 'none';
        const f = await call('GET', `/fog/map/${enc(mapId)}?pic=${enc(pic)}`);
        parts.table = { mapId, pic, fog: f.enabled ? { enabled: true, base: f.base, ops: f.ops } : 'keep' };
      } else notes.push('Table: the DM has not chosen a table map yet');
    } catch (e) { notes.push(`Table: ${msg(e)}`); }
  }
  return { parts, notes };
}

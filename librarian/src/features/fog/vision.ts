// Map vision: a model that can see pictures reads a map picture and says where its rooms and areas are, on the
// same 0 to 100 grid as map marks, so the assistant can uncover fog in the right place ("open the crypt").
//
// The model is the 'vision' job (Admin → Models; unset: the DM assistant's model). Before a picture is sent the
// provider's own model list is asked whether that model takes images (Argos: capabilities.vision; OpenRouter and
// others: an "image" input modality). A model listed without image input is never sent one: the DM is told to
// attach a model that can see. A provider that does not describe its models is tried once and the answer says so.
//
// Only the DM uses this (a map picture can show what the fog still hides), and only map pictures are sent.
import fs from 'node:fs';
import path from 'node:path';
import type { Deps } from '../../app.ts';
import { chat, jobConfig, ModelUnavailable, type JobConfig } from '../../core/ai.ts';
import { one } from '../../core/db.ts';
import { HttpError } from '../../core/util.ts';
import { listModels } from '../models/argos.ts';

export type Sight = 'yes' | 'no' | 'unknown';
export interface VisionCheck { model: string | null; sees: Sight; why: string }

const CACHE_MS = 10 * 60_000;
const seen = new Map<string, { at: number; sees: Sight }>();

/** Whether the model attached to map vision can see pictures, from the provider's model list. */
export async function visionCheck(d: Deps): Promise<VisionCheck> {
  const c = jobConfig(d, 'vision');
  if (!c) return { model: null, sees: 'no', why: 'No model is attached for map vision or the DM assistant (Admin → Models).' };
  const key = `${c.baseUrl}|${c.model}`;
  const hit = seen.get(key);
  let sees: Sight;
  if (hit && Date.now() - hit.at < CACHE_MS) sees = hit.sees;
  else {
    sees = await lookUp(d, c);
    seen.set(key, { at: Date.now(), sees });
  }
  const why = sees === 'yes' ? `${c.model} can see pictures.`
    : sees === 'no' ? `${c.model} cannot see pictures. Attach a model that can (for example Hy4 Flash, Gemma 3 or Qwen VL) to Map vision in Admin → Models.`
    : `The provider does not say whether ${c.model} can see pictures; it is tried, and a model that cannot will answer badly.`;
  return { model: c.model, sees, why };
}

async function lookUp(d: Deps, c: JobConfig): Promise<Sight> {
  try {
    const models = await listModels(d, { baseUrl: c.baseUrl, apiKey: c.apiKey });
    const m = models.find((x) => x.id === c.model) ?? models.find((x) => x.id.toLowerCase() === c.model.toLowerCase());
    if (!m) return 'unknown';
    if (m.vision) return 'yes';
    // A model whose metadata says nothing about input is not proof it is blind.
    return m.inputModalities.length ? 'no' : 'unknown';
  } catch { return 'unknown'; }
}

/** For tests: forget what was looked up. */
export const forgetVision = () => seen.clear();

const MAX_BYTES = 8 * 1024 * 1024;
const IMAGE_MIME = /^image\/(png|jpe?g|webp|gif)$/i;

/** The bytes of a map picture key as the Map page uses it: lib:<library file id> or imp:<imported source picture id>. */
export function mapPicture(d: Deps, worldId: string, pic: string): { mime: string; data: Buffer; name: string } {
  if (pic.startsWith('lib:')) {
    const f = one<any>(d.db, 'SELECT * FROM libfiles_files WHERE id = ? AND world_id = ?', pic.slice(4), worldId);
    if (!f) throw new HttpError(404, 'That map picture is not in the library');
    if (!IMAGE_MIME.test(f.mime)) throw new HttpError(415, 'That map file is not a picture a model can read (PNG, JPEG, WebP or GIF)');
    if (f.size > MAX_BYTES) throw new HttpError(413, 'That map picture is over 8 MB; save a smaller copy to read it');
    const file = path.join(d.dataDir ?? '', 'libfiles', worldId, f.id);
    if (!fs.existsSync(file)) throw new HttpError(404, 'That map picture is not on this server (it may live only in a source)');
    return { mime: f.mime, data: fs.readFileSync(file), name: f.name };
  }
  if (pic.startsWith('imp:')) {
    const img = one<any>(d.db, 'SELECT * FROM intake_images WHERE id = ? AND world_id = ?', pic.slice(4), worldId);
    if (!img) throw new HttpError(404, 'That imported map picture is not here');
    if (!IMAGE_MIME.test(img.mime)) throw new HttpError(415, 'That map picture is not one a model can read');
    const data = Buffer.from(img.data);
    if (data.length > MAX_BYTES) throw new HttpError(413, 'That map picture is over 8 MB');
    return { mime: img.mime, data, name: img.name ?? 'map' };
  }
  throw new HttpError(400, "This map has no picture to look at (pic is 'none'). Pick a map picture on the Map page first.");
}

export interface Area { name: string; x: number; y: number; w: number; h: number; note?: string }
export interface Look { model: string; sees: Sight; areas: Area[]; summary: string; answer?: string }

const PROMPT = [
  'You read tabletop RPG battle maps and dungeon maps for a Dungeon Master.',
  'List every distinct room, area or landmark you can see (rooms, corridors, doors that matter, stairs, buildings, clearings), with a box around each.',
  'Coordinates are percent of the picture: x and y are the top-left corner from 0 to 100 (x across from the left, y down from the top), w and h the size from 0 to 100.',
  'Use labels written on the map when there are any (room numbers, names); otherwise a short plain name like "north hall".',
  'Answer only with JSON: {"summary":"one sentence about the map","areas":[{"name":"","x":0,"y":0,"w":0,"h":0,"note":""}],"answer":""}.',
  'If the DM asked something about the map, put the short answer in "answer".',
].join('\n');

const clamp = (v: unknown) => Math.max(0, Math.min(100, Math.round(Number(v) * 10) / 10 || 0));

/** Ask the vision model where the areas of one map picture are. */
export async function lookAtMap(d: Deps, worldId: string, pic: string, question = ''): Promise<Look> {
  const check = await visionCheck(d);
  if (!check.model) throw new HttpError(503, check.why);
  if (check.sees === 'no') throw new HttpError(409, check.why);
  const p = mapPicture(d, worldId, pic);
  const dataUrl = `data:${p.mime};base64,${p.data.toString('base64')}`;
  let content = '';
  try {
    const r = await chat(d, 'vision', {
      messages: [{ role: 'system', content: PROMPT }, { role: 'user', content: `Map picture: ${p.name}.${question ? ` The DM asks: ${question.slice(0, 400)}` : ''}`, images: [dataUrl] }],
      json: true, maxTokens: 1500, temperature: 0,
    });
    content = r.content;
  } catch (e) {
    if (e instanceof ModelUnavailable) throw new HttpError(503, `The map vision model did not answer: ${String(e.message).slice(0, 160)}`);
    throw e;
  }
  let j: any = null;
  try { j = JSON.parse(content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1)); } catch { /* not JSON */ }
  const areas: Area[] = (Array.isArray(j?.areas) ? j.areas : []).slice(0, 60).map((a: any) => {
    const x = clamp(a?.x), y = clamp(a?.y);
    return { name: String(a?.name ?? '').slice(0, 80) || 'area', x, y, w: Math.min(clamp(a?.w), 100 - x), h: Math.min(clamp(a?.h), 100 - y), ...(a?.note ? { note: String(a.note).slice(0, 200) } : {}) };
  }).filter((a: Area) => a.w > 0 && a.h > 0);
  return { model: check.model, sees: check.sees, areas, summary: String(j?.summary ?? (j ? '' : content)).slice(0, 400), ...(j?.answer ? { answer: String(j.answer).slice(0, 600) } : {}) };
}

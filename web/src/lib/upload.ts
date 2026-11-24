// Sending a picture to the server: the file itself (not text in JSON), and a photo over the limit is made smaller here instead of being refused.
import type { WorldClient } from '@alx/client';

export const PICTURE_MAX = 20 * 1024 * 1024;
const TYPES = /^image\/(png|jpeg|gif|webp)$/;

/** The same picture, at most 4096 px on its longer side, as JPEG. */
async function smaller(f: File): Promise<Blob> {
  const bmp = await createImageBitmap(f);
  const k = Math.min(1, 4096 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bmp.width * k)); c.height = Math.max(1, Math.round(bmp.height * k));
  c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  for (const q of [0.92, 0.85, 0.75]) {
    const b = await new Promise<Blob | null>((ok) => c.toBlob(ok, 'image/jpeg', q));
    if (b && b.size <= PICTURE_MAX) return b;
  }
  throw new Error('This picture is too big to send, even made smaller');
}

export async function uploadPicture<T = { id: string }>(w: WorldClient, path: string, f: File): Promise<T> {
  if (!TYPES.test(f.type)) throw new Error('Pick a PNG, JPEG, GIF or WebP picture');
  if (f.size > PICTURE_MAX && f.type === 'image/gif') throw new Error(`A GIF can be at most ${PICTURE_MAX / 1048576} MB`);
  const body = f.size > PICTURE_MAX ? await smaller(f) : f;
  const c = w.client;
  let r: Response;
  try { r = await fetch(`${c.baseUrl}${w.path(path)}`, { method: 'POST', headers: { 'Content-Type': body.type || f.type, ...(c.token ? { Authorization: `Bearer ${c.token}` } : {}) }, body }); }
  catch { throw new Error('The picture did not reach the server. Check the connection and try again.'); }
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(j?.error ?? (r.status === 413 ? 'That picture is too big' : `Upload failed (${r.status})`));
  return j as T;
}

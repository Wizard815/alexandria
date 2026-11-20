// Serving a file from disk with HTTP Range support (so a browser can seek in a
// video: 206 Partial Content, Accept-Ranges, Content-Range) and receiving an
// upload: pictures and documents are buffered, a video is streamed to disk.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import type { Request, Response } from 'express';
import { sniffFile, type Sniffed } from './sniff.ts';

/** The byte range a Range header asks for: a range, 'full' (no or unusable header, several ranges: send it all) or 'bad' (unsatisfiable). */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'full' | 'bad' {
  if (!header) return 'full';
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return 'full';
  let start: number;
  let end: number;
  if (m[1] === '') {
    const n = Number(m[2]);
    if (n === 0) return 'bad';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (!Number.isFinite(start) || start >= size || end < start) return 'bad';
  return { start, end };
}

/** Send a file (200, or 206 for a Range request). Content-Type and the other headers are set by the caller. */
export function sendRanged(req: Request, res: Response, file: string): void {
  let size: number;
  try { size = fs.statSync(file).size; } catch { res.status(404).json({ error: 'File not found' }); return; }
  res.setHeader('Accept-Ranges', 'bytes');
  const range = parseRange(req.headers.range, size);
  if (range === 'bad') {
    res.status(416);
    res.setHeader('Content-Range', `bytes */${size}`);
    res.removeHeader('Content-Length');
    res.end();
    return;
  }
  let opts: { start: number; end: number } | undefined;
  if (range !== 'full') {
    opts = range;
    res.status(206);
    res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
    res.setHeader('Content-Length', String(range.end - range.start + 1));
  } else res.setHeader('Content-Length', String(size));
  const stream = fs.createReadStream(file, opts);
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

export interface Received {
  /** Buffered body (pictures, documents); empty for a streamed video. */
  body: Buffer;
  /** Set for a video: the temp file it was streamed to (the caller moves or deletes it). */
  temp: string;
  sniffed?: Sniffed | { error: string };
  size: number;
  /** The limit that was exceeded, when the body was too big (nothing is kept then). */
  tooBig?: number;
}

const HEAD = 4096;
const DRAIN = 64 * 1024 * 1024;

/**
 * Read an upload. The first bytes decide: a video goes straight to a file in `tmpDir` (limit `videoMax`, never held in
 * memory); anything else is buffered up to `max`. An aborted request or a failed write removes the temp file.
 */
export async function receiveBody(req: Request, name: string, o: { max: number; videoMax: number; declared: number; tmpDir: string }): Promise<Received> {
  const chunks: Buffer[] = [];
  let have = 0;
  let total = 0;
  let mode: 'head' | 'buffer' | 'video' = 'head';
  let ws: fs.WriteStream | null = null;
  let temp = '';
  let sniffed: Received['sniffed'];
  let wsError: Error | null = null;
  const cleanup = () => { ws?.destroy(); if (temp) fs.rmSync(temp, { force: true }); };
  // Refused for size: the rest of the body is read and thrown away (so the client sees the 413, not a reset), up to a point.
  let refused = 0;
  const over = (limit: number): Received => { cleanup(); refused = limit; return { body: Buffer.alloc(0), temp: '', size: 0, tooBig: limit }; };
  /** Look at the first bytes and choose where the rest goes. Returns the limit when the declared length is already over it. */
  const decide = (): number | null => {
    const head = Buffer.concat(chunks);
    chunks.length = 0;
    const s = sniffFile(head, name);
    if (!('error' in s) && s.family === 'video') {
      if (o.declared > o.videoMax) return o.videoMax;
      mode = 'video';
      sniffed = s;
      fs.mkdirSync(o.tmpDir, { recursive: true });
      temp = path.join(o.tmpDir, `up_${randomBytes(9).toString('base64url')}`);
      ws = fs.createWriteStream(temp);
      ws.on('error', (e) => { wsError = e; });
      ws.write(head);
    } else {
      if (o.declared > o.max) return o.max;
      mode = 'buffer';
      chunks.push(head);
    }
    return null;
  };
  try {
    for await (const chunk of req as AsyncIterable<Buffer>) {
      total += chunk.length;
      if (refused) { if (total > refused + DRAIN) break; continue; }
      if (mode === 'head') {
        chunks.push(chunk);
        have += chunk.length;
        if (have >= HEAD) { const big = decide(); if (big) over(big); }
        continue;
      }
      if (mode === 'buffer') {
        if (total > o.max) { over(o.max); continue; }
        chunks.push(chunk);
        continue;
      }
      if (total > o.videoMax) { over(o.videoMax); continue; }
      if (wsError) throw wsError;
      if (!ws!.write(chunk)) await once(ws!, 'drain');
    }
    if (refused) return { body: Buffer.alloc(0), temp: '', size: 0, tooBig: refused };
    if (mode === 'head') { const big = decide(); if (big) return over(big); }
    if ((mode as string) === 'buffer') return { body: Buffer.concat(chunks), temp: '', size: total };
    const stream = ws as unknown as fs.WriteStream;
    await new Promise<void>((resolve, reject) => { stream.once('error', reject); stream.end(resolve); });
    if (wsError) throw wsError;
    return { body: Buffer.alloc(0), temp, sniffed, size: total };
  } catch (e) {
    cleanup();
    throw e;
  }
}

/** Move a finished file into place (a copy when the two folders are on different disks). */
export function moveFile(from: string, to: string) {
  try { fs.renameSync(from, to); } catch (e: any) {
    if (e?.code !== 'EXDEV') throw e;
    fs.copyFileSync(from, to);
    fs.rmSync(from, { force: true });
  }
}

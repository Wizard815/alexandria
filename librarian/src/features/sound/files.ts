// Audio files on the gateway: sniffing a file's type from its first bytes,
// reading a WAV or FLAC length, and streaming a file with Range support.
import fs from 'node:fs';
import type { Request, Response } from 'express';

export const MIME: Record<string, string> = {
  mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac', m4a: 'audio/mp4',
};
export const EXTS: Record<string, string> = {
  '.mp3': 'mp3', '.ogg': 'ogg', '.oga': 'ogg', '.opus': 'ogg', '.wav': 'wav', '.flac': 'flac', '.m4a': 'm4a', '.mp4': 'm4a',
};

/** The audio type of these bytes (by magic bytes, never the file name), or null. */
export function sniff(b: Uint8Array): 'mp3' | 'ogg' | 'wav' | 'flac' | 'm4a' | null {
  if (b.length < 12) return null;
  const s = (from: number, to: number) => String.fromCharCode(...b.slice(from, to));
  if (s(0, 4) === 'OggS') return 'ogg';
  if (s(0, 4) === 'fLaC') return 'flac';
  if (s(0, 4) === 'RIFF' && s(8, 12) === 'WAVE') return 'wav';
  if (s(4, 8) === 'ftyp') return 'm4a';
  if (s(0, 3) === 'ID3') return 'mp3';
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0 && (b[1] & 0x06) !== 0) return 'mp3';
  return null;
}

/** Length in seconds when it is cheap to know (WAV and FLAC headers), else null. */
export function durationOf(file: string): number | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const h = Buffer.alloc(64);
    const n = fs.readSync(fd, h, 0, 64, 0);
    if (n >= 44 && h.toString('latin1', 0, 4) === 'RIFF' && h.toString('latin1', 8, 12) === 'WAVE') {
      const size = fs.fstatSync(fd).size;
      let pos = 12;
      let byteRate = 0;
      const c = Buffer.alloc(8);
      while (pos + 8 <= size) {
        fs.readSync(fd, c, 0, 8, pos);
        const name = c.toString('latin1', 0, 4);
        const len = c.readUInt32LE(4);
        if (name === 'fmt ') { const f = Buffer.alloc(16); fs.readSync(fd, f, 0, 16, pos + 8); byteRate = f.readUInt32LE(8); }
        else if (name === 'data') return byteRate ? Math.round((Math.min(len, size - pos - 8) / byteRate) * 100) / 100 : null;
        pos += 8 + len + (len % 2);
      }
      return null;
    }
    if (n >= 26 && h.toString('latin1', 0, 4) === 'fLaC') {
      // STREAMINFO: 20 bits sample rate, 36 bits total samples.
      const rate = (h[18] << 12) | (h[19] << 4) | (h[20] >> 4);
      const total = (h[21] & 0x0f) * 2 ** 32 + h.readUInt32BE(22);
      return rate && total ? Math.round((total / rate) * 100) / 100 : null;
    }
    return null;
  } catch { return null; } finally { if (fd !== null) try { fs.closeSync(fd); } catch { /* ignore */ } }
}

/** Stream a file with Range support (so a browser can seek). */
export function serveFile(req: Request, res: Response, abs: string, mime: string) {
  let st: fs.Stats;
  try { st = fs.statSync(abs); } catch { return void res.status(404).json({ error: 'File not found' }); }
  res.setHeader('Content-Type', mime);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'private, max-age=300');
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
  if (m && (m[1] || m[2])) {
    const start = m[1] ? Number(m[1]) : Math.max(st.size - Number(m[2]), 0);
    const end = Math.min(m[1] && m[2] ? Number(m[2]) : st.size - 1, st.size - 1);
    if (start > end || start >= st.size) { res.setHeader('Content-Range', `bytes */${st.size}`); return void res.status(416).end(); }
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${st.size}`);
    res.setHeader('Content-Length', String(end - start + 1));
    if (req.method === 'HEAD') return void res.end();
    return void fs.createReadStream(abs, { start, end }).pipe(res);
  }
  res.setHeader('Content-Length', String(st.size));
  if (req.method === 'HEAD') return void res.end();
  fs.createReadStream(abs).pipe(res);
}

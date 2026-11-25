// A .zip written straight to a stream, one file at a time: nothing is held in memory but a read buffer, so a session of
// several GB of audio downloads without the server loading it. Files are stored, not compressed (MP3 and M4A do not
// shrink, and a stored entry streams at disk speed). ZIP64 is used for any entry, offset or count past the 32-bit
// limits, so a long night's recording still opens. CRC-32 and sizes follow each entry (a data descriptor), since the
// CRC is only known after reading the file.
import fs from 'node:fs';
import type { Writable } from 'node:stream';
import { crc32 } from 'node:zlib';

export interface ZipEntry {
  /** Path inside the archive, with forward slashes. */
  name: string;
  /** A file on disk (read up to `size` bytes, as it was when listed), or bytes in memory (a small text file). */
  file?: string;
  data?: Buffer;
  /** The bytes of `file` to read; for `data` its length is used. */
  size?: number;
  mtime?: Date;
}

const U32 = 0xffffffff;
const U16 = 0xffff;

function dosTime(d: Date) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = (Math.max(0, d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/** A name that is safe inside a zip: no leading slash, no "..", no backslashes, no control characters. */
export function zipName(name: string) {
  return name.replace(/\\/g, '/').split('/').map((p) => p.replace(/[\x00-\x1f\x7f]/g, '_').replace(/^\.+$/, '_').trim()).filter(Boolean).join('/') || 'file';
}

/**
 * Write the entries as one zip to `out`, waiting for the stream to drain (backpressure) as it goes. Resolves with the
 * bytes written; rejects (and stops reading) when the stream closes early, for example when the person cancels.
 */
export async function writeZip(out: Writable, entries: ZipEntry[]): Promise<number> {
  let offset = 0;
  let closed = false;
  const onClose = () => { closed = true; };
  out.once('close', onClose);
  const write = (b: Buffer) => new Promise<void>((resolve, reject) => {
    if (closed || out.destroyed) return reject(new Error('The download was closed'));
    offset += b.length;
    if (out.write(b)) return resolve();
    const done = () => { out.off('drain', done); out.off('close', fail); resolve(); };
    const fail = () => { out.off('drain', done); out.off('close', fail); reject(new Error('The download was closed')); };
    out.once('drain', done);
    out.once('close', fail);
  });
  const central: Buffer[] = [];
  try {
    for (const e of entries) {
      const name = Buffer.from(zipName(e.name), 'utf8');
      const expected = e.data ? e.data.length : Math.max(0, e.size ?? 0);
      const big = expected >= U32;
      const start = offset;
      const { time, date } = dosTime(e.mtime ?? new Date());
      const version = big || start >= U32 ? 45 : 20;
      // Local header: CRC and sizes come after the data (flag bit 3); bit 11: the name is UTF-8.
      const extra = big ? Buffer.alloc(20) : Buffer.alloc(0);
      if (big) { extra.writeUInt16LE(0x0001, 0); extra.writeUInt16LE(16, 2); }
      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(version, 4); lh.writeUInt16LE(0x0808, 6); lh.writeUInt16LE(0, 8);
      lh.writeUInt16LE(time, 10); lh.writeUInt16LE(date, 12); lh.writeUInt32LE(0, 14);
      lh.writeUInt32LE(big ? U32 : 0, 18); lh.writeUInt32LE(big ? U32 : 0, 22);
      lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(extra.length, 28);
      await write(Buffer.concat([lh, name, extra]));

      let crc = 0;
      let size = 0;
      if (e.data) {
        crc = crc32(e.data, 0);
        size = e.data.length;
        if (size) await write(e.data);
      } else if (e.file && expected > 0) {
        const rs = fs.createReadStream(e.file, { start: 0, end: expected - 1, highWaterMark: 256 * 1024 });
        try {
          for await (const chunk of rs as AsyncIterable<Buffer>) { crc = crc32(chunk, crc); size += chunk.length; await write(chunk); }
        } finally { rs.destroy(); }
      }
      // Data descriptor (64-bit sizes for a ZIP64 entry).
      const dd = Buffer.alloc(big ? 24 : 16);
      dd.writeUInt32LE(0x08074b50, 0); dd.writeUInt32LE(crc >>> 0, 4);
      if (big) { dd.writeBigUInt64LE(BigInt(size), 8); dd.writeBigUInt64LE(BigInt(size), 16); } else { dd.writeUInt32LE(size, 8); dd.writeUInt32LE(size, 12); }
      await write(dd);

      // Its central directory record, with a ZIP64 extra for whatever does not fit in 32 bits.
      const z64: Buffer[] = [];
      if (big) { const b = Buffer.alloc(16); b.writeBigUInt64LE(BigInt(size), 0); b.writeBigUInt64LE(BigInt(size), 8); z64.push(b); }
      if (start >= U32) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(start), 0); z64.push(b); }
      const zx = z64.length ? Buffer.concat([Buffer.from([0x01, 0x00, 0, 0]), ...z64]) : Buffer.alloc(0);
      if (zx.length) zx.writeUInt16LE(zx.length - 4, 2);
      const ch = Buffer.alloc(46);
      ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE((3 << 8) | 45, 4); ch.writeUInt16LE(version, 6); ch.writeUInt16LE(0x0808, 8); ch.writeUInt16LE(0, 10);
      ch.writeUInt16LE(time, 12); ch.writeUInt16LE(date, 14); ch.writeUInt32LE(crc >>> 0, 16);
      ch.writeUInt32LE(big ? U32 : size, 20); ch.writeUInt32LE(big ? U32 : size, 24);
      ch.writeUInt16LE(name.length, 28); ch.writeUInt16LE(zx.length, 30); ch.writeUInt16LE(0, 32); ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36);
      ch.writeUInt32LE((0o100644 << 16) >>> 0, 38); ch.writeUInt32LE(start >= U32 ? U32 : start, 42);
      central.push(Buffer.concat([ch, name, zx]));
    }

    const cdStart = offset;
    for (const c of central) await write(c);
    const cdSize = offset - cdStart;
    const n = central.length;
    if (n >= U16 || cdStart >= U32 || cdSize >= U32) {
      const z64Start = offset;
      const rec = Buffer.alloc(56);
      rec.writeUInt32LE(0x06064b50, 0); rec.writeBigUInt64LE(44n, 4); rec.writeUInt16LE((3 << 8) | 45, 12); rec.writeUInt16LE(45, 14);
      rec.writeUInt32LE(0, 16); rec.writeUInt32LE(0, 20); rec.writeBigUInt64LE(BigInt(n), 24); rec.writeBigUInt64LE(BigInt(n), 32);
      rec.writeBigUInt64LE(BigInt(cdSize), 40); rec.writeBigUInt64LE(BigInt(cdStart), 48);
      const loc = Buffer.alloc(20);
      loc.writeUInt32LE(0x07064b50, 0); loc.writeUInt32LE(0, 4); loc.writeBigUInt64LE(BigInt(z64Start), 8); loc.writeUInt32LE(1, 16);
      await write(Buffer.concat([rec, loc]));
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
    end.writeUInt16LE(Math.min(n, U16), 8); end.writeUInt16LE(Math.min(n, U16), 10);
    end.writeUInt32LE(Math.min(cdSize, U32), 12); end.writeUInt32LE(Math.min(cdStart, U32), 16); end.writeUInt16LE(0, 20);
    await write(end);
    return offset;
  } finally { out.off('close', onClose); }
}

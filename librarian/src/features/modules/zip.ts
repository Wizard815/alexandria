// A minimal, read-only zip reader (central directory + node:zlib), so module
// imports need no dependency. Handles stored and deflated entries; refuses
// encrypted and zip64 archives. Limits guard against zip bombs: the size an
// entry declares is checked, and inflating is capped to it.
import zlib from 'node:zlib';
import { HttpError } from '../../core/util.ts';

export interface ZipEntry { name: string; size: number; read(): Buffer }

export interface ZipLimits { entries: number; entryBytes: number; totalBytes: number }
export const ZIP_LIMITS: ZipLimits = { entries: 20_000, entryBytes: 2_000_000, totalBytes: 24_000_000 };

const bad = (m: string) => new HttpError(400, `Not a usable zip file: ${m}`);

export function readZip(buf: Buffer, limits: ZipLimits = ZIP_LIMITS, want: (name: string) => boolean = () => true): ZipEntry[] {
  // End of central directory: scan back for its signature.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw bad('no central directory');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) throw bad('zip64 is not supported');
  if (count > limits.entries) throw new HttpError(413, `The zip has more than ${limits.entries} files`);
  if (cdOffset + cdSize > buf.length) throw bad('the central directory is cut off');

  const out: ZipEntry[] = [];
  let total = 0;
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw bad('damaged central directory');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const utf8 = (flags & 0x800) !== 0;
    const name = buf.toString(utf8 ? 'utf8' : 'latin1', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue; // folder
    if (!want(name)) continue;
    if (flags & 1) throw bad('encrypted files are not supported');
    if (usize > limits.entryBytes) throw new HttpError(413, `${name} is larger than ${limits.entryBytes} bytes`);
    total += usize;
    if (total > limits.totalBytes) throw new HttpError(413, 'The zip is too large when unpacked');
    out.push({
      name,
      size: usize,
      read() {
        if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw bad(`damaged entry ${name}`);
        const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
        const data = buf.subarray(start, start + csize);
        if (data.length !== csize) throw bad(`${name} is cut off`);
        if (method === 0) return Buffer.from(data);
        if (method === 8) {
          try { return zlib.inflateRawSync(data, { maxOutputLength: usize + 1 }); } catch { throw bad(`${name} will not unpack`); }
        }
        throw bad(`${name} uses an unsupported compression method`);
      },
    });
  }
  return out;
}

// A minimal tar writer (ustar) for backups: no dependencies. Files are read
// one at a time, so memory stays small however much audio there is.
import fs from 'node:fs';
import path from 'node:path';

export interface TarEntry { name: string; data?: Buffer; file?: string; mtime?: number }

const octal = (n: number, len: number) => n.toString(8).padStart(len - 1, '0') + '\0';

function header(name: string, size: number, mtime: number): Buffer {
  const b = Buffer.alloc(512);
  let prefix = '';
  let nm = name;
  if (Buffer.byteLength(nm) > 100) {
    // ustar: split at a slash into prefix (<=155) and name (<=100)
    let at = -1;
    for (let i = nm.length - 1; i > 0; i--) if (nm[i] === '/' && i <= 155 && nm.length - i - 1 <= 100) { at = i; break; }
    if (at < 0) throw new Error(`tar: path too long: ${name}`);
    prefix = nm.slice(0, at);
    nm = nm.slice(at + 1);
  }
  b.write(nm, 0, 100);
  b.write(octal(0o644, 8), 100);
  b.write(octal(0, 8), 108);
  b.write(octal(0, 8), 116);
  b.write(octal(size, 12), 124);
  b.write(octal(Math.floor(mtime / 1000), 12), 136);
  b.write('        ', 148); // checksum placeholder: spaces
  b.write('0', 156);
  b.write('ustar\0', 257);
  b.write('00', 263);
  b.write(prefix, 345, 155);
  let sum = 0;
  for (const x of b) sum += x;
  b.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return b;
}

export async function* tar(entries: Iterable<TarEntry>): AsyncGenerator<Buffer> {
  for (const e of entries) {
    const data = e.data ?? (e.file ? fs.readFileSync(e.file) : Buffer.alloc(0));
    yield header(e.name, data.length, e.mtime ?? Date.now());
    yield data;
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) yield Buffer.alloc(pad);
  }
  yield Buffer.alloc(1024);
}

/** Every file under dir (recursive) as entries named <base>/<relative path>. */
export function* walk(dir: string, base: string): Generator<TarEntry> {
  if (!fs.existsSync(dir)) return;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) yield* walk(full, `${base}/${ent.name}`);
    else if (ent.isFile()) yield { name: `${base}/${ent.name}`, file: full, mtime: fs.statSync(full).mtimeMs };
  }
}

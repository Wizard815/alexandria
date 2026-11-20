// What a library file is, decided from its bytes (never the file name or the
// type the browser claimed). Allowed: pictures, PDF, plain text and Markdown,
// JSON and CSV. Refused: SVG, HTML, XML, scripts, executables, archives.

export type Family = 'image' | 'video' | 'pdf' | 'text' | 'json' | 'csv';
export interface Sniffed { mime: string; ext: string; family: Family }

export const KINDS = ['map', 'handout', 'item', 'rules', 'other'] as const;
export type FileKind = (typeof KINDS)[number];

const BAD_EXT = /\.(svg|svgz|html?|xhtml|xml|xsl|js|mjs|cjs|jsx|ts|php|py|sh|bash|bat|cmd|ps1|exe|dll|so|dylib|com|msi|jar|apk|app|scr|vbs|swf)$/i;
const TEXT_EXT: Record<string, Family> = { md: 'text', markdown: 'text', txt: 'text', text: 'text', json: 'json', csv: 'csv', tsv: 'csv' };
const MIME: Record<string, string> = { md: 'text/plain', markdown: 'text/plain', txt: 'text/plain', text: 'text/plain', json: 'application/json', csv: 'text/csv', tsv: 'text/csv' };

const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.slice(from, to));

const MP4_BRANDS = new Set(['isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'iso7', 'iso8', 'iso9', 'mp41', 'mp42', 'mp71', 'avc1', 'dash', 'M4V ', 'M4VH', 'M4VP', 'msnv', 'MSNV', 'f4v ', 'mmp4']);

/** MP4 / MOV (an ISO "ftyp" box) or WebM (EBML with the webm doc type), from the first bytes only. Null when it is neither. */
export function sniffVideo(b: Uint8Array): Sniffed | null {
  if (b.length >= 16 && ascii(b, 4, 8) === 'ftyp') {
    const size = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
    const end = Math.min(b.length, size >= 16 ? size : 16);
    const major = ascii(b, 8, 12);
    if (major === 'qt  ') return { mime: 'video/quicktime', ext: 'mov', family: 'video' };
    const brands = [major];
    for (let i = 16; i + 4 <= end; i += 4) brands.push(ascii(b, i, i + 4));
    if (brands.some((x) => MP4_BRANDS.has(x))) return { mime: 'video/mp4', ext: 'mp4', family: 'video' };
    return null;
  }
  if (b.length >= 12 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3 && ascii(b, 0, Math.min(b.length, 64)).includes('webm')) return { mime: 'video/webm', ext: 'webm', family: 'video' };
  return null;
}

/** The type of these bytes, or a reason it is refused. `name` only decides which kind of text it is. */
export function sniffFile(b: Uint8Array, name: string): Sniffed | { error: string } {
  if (!b.length) return { error: 'The file is empty' };
  if (BAD_EXT.test(name)) return { error: 'That kind of file (SVG, HTML, scripts, programs) cannot be uploaded' };
  if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 4) === 'PNG') return { mime: 'image/png', ext: 'png', family: 'image' };
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg', family: 'image' };
  if (b.length >= 6 && (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a')) return { mime: 'image/gif', ext: 'gif', family: 'image' };
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') return { mime: 'image/webp', ext: 'webp', family: 'image' };
  const video = sniffVideo(b);
  if (video) return video;
  if (b.length >= 5 && ascii(b, 0, 5) === '%PDF-') return { mime: 'application/pdf', ext: 'pdf', family: 'pdf' };
  // Programs and archives by their first bytes.
  const head4 = ascii(b, 0, 4);
  if (head4.startsWith('MZ') || head4 === '\x7fELF' || head4 === 'PK\x03\x04' || head4 === '\xca\xfe\xba\xbe' || head4 === '\xfe\xed\xfa\xce' || head4 === '\xfe\xed\xfa\xcf' || head4 === '\xcf\xfa\xed\xfe' || head4.startsWith('#!')) {
    return { error: 'Programs and archives cannot be uploaded' };
  }
  // Text: no NUL bytes, valid UTF-8, and the name says which kind.
  const sample = b.subarray(0, Math.min(b.length, 65536));
  if (sample.includes(0)) return { error: 'Not a picture, PDF or text file' };
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(b); } catch { return { error: 'Text files must be UTF-8' }; }
  const ext = /\.([A-Za-z0-9]{1,8})$/.exec(name)?.[1]?.toLowerCase() ?? '';
  const family = TEXT_EXT[ext];
  if (!family) return { error: 'Send a picture, PDF, text, Markdown, JSON or CSV file' };
  if (/^\s*<\s*(!doctype|html|svg|script|\?xml|\?php|body|head|iframe|object|embed|meta|link)/i.test(text.replace(/^﻿/, '').slice(0, 400))) return { error: 'HTML, SVG and XML cannot be uploaded' };
  if (family === 'json') {
    try { JSON.parse(text); } catch { return { error: 'That JSON file is not valid JSON' }; }
  }
  return { mime: MIME[ext], ext, family };
}

export const cleanName = (raw: unknown, fallback = 'file'): string => {
  const base = String(raw ?? '').split(/[\\/]/).pop() ?? '';
  const n = base.replace(/[\x00-\x1f"<>|:*?]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  return n && n !== '.' && n !== '..' ? n : fallback;
};

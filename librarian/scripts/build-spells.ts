// Builds the bundled spell list, src/features/spells/data/srd-5.2.1-spells.json,
// from the official System Reference Document 5.2.1 PDF (CC-BY-4.0).
//
//   NODE_USE_ENV_PROXY=1 node --experimental-strip-types librarian/scripts/build-spells.ts
//   node --experimental-strip-types librarian/scripts/build-spells.ts --pdf <SRD_CC_v5.2.1.pdf>
//
// Needs `pdftotext` (poppler-utils) on the PATH. It reads the "Spell
// Descriptions" chapter word by word with coordinates (-bbox-layout), puts the
// two columns of each page in reading order, and splits it into spells: a
// name line, a "Level N School (Classes)" line, Casting Time, Range,
// Components, Duration, then the description. Paragraphs come from the
// layout (an indented first line or extra space before a line), and a word
// broken over two lines is joined again. Only the SRD is read: nothing from
// any other book goes into the file.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normalizeSpell, slug, type Spell } from '../src/features/spells/format.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, '..', 'src', 'features', 'spells', 'data', 'srd-5.2.1-spells.json');
const PDF_URL = 'https://media.dndbeyond.com/compendium-images/srd/5.2/SRD_CC_v5.2.1.pdf';
const ATTRIBUTION = 'This work includes material from the System Reference Document 5.2.1 (“SRD 5.2.1”) by Wizards of the Coast LLC, available at https://www.dndbeyond.com/srd. The SRD 5.2.1 is licensed under the Creative Commons Attribution 4.0 International License, available at https://creativecommons.org/licenses/by/4.0/legalcode.';

const args = process.argv.slice(2);
const opt = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };

interface Word { x0: number; x1: number; t: string }
interface Line { page: number; col: number; x: number; y: number; x1: number; h: number; text: string; words: Word[]; cells?: { x: number; text: string }[] }

const unesc = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

function readLines(xhtml: string, firstPage: number): Line[] {
  const out: Line[] = [];
  const pages = xhtml.split(/<page [^>]*>/).slice(1);
  pages.forEach((p, i) => {
    const page = firstPage + i;
    const lines: Line[] = [];
    for (const m of p.matchAll(/<line xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([\s\S]*?)<\/line>/g)) {
      const words = [...m[5].matchAll(/<word xMin="([\d.]+)" yMin="[\d.]+" xMax="([\d.]+)" yMax="[\d.]+">([^<]*)<\/word>/g)].map((w) => ({ x0: +w[1], x1: +w[2], t: unesc(w[3]) }));
      const x = +m[1], y = +m[2];
      if (y > 738) continue; // footer: page number and "System Reference Document 5.2.1"
      lines.push({ page, col: x < 297 ? 0 : 1, x, y, x1: +m[3], h: +m[4] - y, text: words.map((w) => w.t).join(' '), words });
    }
    lines.sort((a, b) => a.col - b.col || a.y - b.y || a.x - b.x);
    // Table cells on one row come out as separate lines: put a row back together.
    for (const l of lines) {
      const prev = out[out.length - 1];
      if (prev && prev.page === page && prev.col === l.col && Math.abs(prev.y - l.y) < 2 && l.x > prev.x1) { prev.cells ??= [{ x: prev.x, text: prev.text }]; prev.cells.push({ x: l.x, text: l.text }); prev.text += ' | ' + l.text; prev.x1 = l.x1; prev.words.push(...l.words); continue; }
      out.push(l);
    }
  });
  return out;
}

/** A heading's letters can come out spaced ("A cid S plash"): join words that touch. */
function tightText(l: Line): string {
  let s = '';
  l.words.forEach((w, i) => { s += (i && w.x0 - l.words[i - 1].x1 > 1.6 ? ' ' : '') + w.t; });
  return s.trim();
}

const LEVEL_RE = /^(?:Level ([1-9]) (Abjuration|Conjuration|Divination|Enchantment|Evocation|Illusion|Necromancy|Transmutation)|(Abjuration|Conjuration|Divination|Enchantment|Evocation|Illusion|Necromancy|Transmutation) Cantrip) \(/;
const FIELD_RE = /^(Casting Time|Range|Components?|Duration):\s*/;
const isName = (l: Line) => l.h > 13.8 && l.h < 15.5;

function splitSpells(lines: Line[]) {
  const start = lines.findIndex((l, i) => isName(l) && LEVEL_RE.test(lines[i + 1]?.text ?? ''));
  const end = lines.findIndex((l, i) => i > start && l.h > 18 && /^Rules Glossary$/.test(l.text));
  const body = lines.slice(start, end < 0 ? undefined : end).filter((l) => !(l.h > 18 && /^Spell Descriptions$/.test(l.text)));
  const spells: { name: string; head: Line[]; fields: Record<string, string>; text: Line[] }[] = [];
  for (let i = 0; i < body.length; i++) {
    const l = body[i];
    if (isName(l) && LEVEL_RE.test(body[i + 1]?.text ?? '')) { spells.push({ name: tightText(l), head: [], fields: {}, text: [] }); continue; }
    const cur = spells[spells.length - 1];
    if (!cur) continue;
    if (!Object.keys(cur.fields).length && !cur.text.length && (LEVEL_RE.test(l.text) || (cur.head.length && !cur.head.map((x) => x.text).join(' ').includes(')')))) { cur.head.push(l); continue; }
    const f = l.text.match(FIELD_RE);
    if (f && !cur.text.length) { f[1] = f[1].replace(/^Component$/, 'Components'); cur.fields[f[1]] = l.text.slice(f[0].length); (cur as any).last = f[1]; continue; }
    if (!cur.text.length && (cur as any).last && (cur as any).last !== 'Duration' && l.h < 12.5) { cur.fields[(cur as any).last] += ' ' + l.text; continue; }
    cur.text.push(l);
  }
  return spells;
}

/** Words written with a hyphen somewhere in the chapter: a break at one of these keeps its hyphen. */
function hyphenWords(lines: Line[]): Set<string> {
  const s = new Set<string>();
  for (const l of lines) for (const m of l.text.matchAll(/\b([A-Za-z]+-[A-Za-z]+)\b/g)) if (!l.text.endsWith(m[0] + '-')) s.add(m[1].toLowerCase());
  return s;
}

type Para = { text: string; cells?: { x: number; text: string }[] };

const joinLine = (cur: string, next: string, hy: Set<string>): string => {
  if (!cur) return next;
  if (/[A-Za-z]-$/.test(cur) && /^[a-z]/.test(next)) {
    const tail = cur.match(/([A-Za-z]+)-$/)![1];
    const head = next.match(/^[a-z]+/)![0];
    return hy.has(`${tail}-${head}`.toLowerCase()) ? cur + next : cur.slice(0, -1) + next;
  }
  return `${cur} ${next}`;
};

function paragraphs(text: Line[], hy: Set<string>): string {
  const paras: Para[] = [];
  let cur: Para | null = null;
  let hang = false;
  text.forEach((l, i) => {
    const prev = text[i - 1];
    const indent = l.x - (l.col === 0 ? 63 : 313.5) > 4;
    const prevIndent = !!prev && prev.x - (prev.col === 0 ? 63 : 313.5) > 4;
    const sameCol = !!prev && prev.page === l.page && prev.col === l.col;
    // A table row, or a wrapped cell of the row above (it lines up under a cell that is not the first).
    if (l.cells) { cur = { text: '', cells: l.cells.map((c) => ({ ...c })) }; paras.push(cur); hang = false; return; }
    if (cur?.cells && sameCol) {
      const cell = cur.cells.slice(1).find((c) => Math.abs(c.x - l.x) < 3) ?? (Math.abs(cur.cells[0].x - l.x) < 3 && l.y - prev.y < 14.5 && /^[a-z(]/.test(l.text) ? cur.cells[0] : undefined);
      if (cell) { cell.text = joinLine(cell.text, l.text, hy); return; }
    }
    let fresh = i === 0 || !cur || !!cur.cells;
    // Extra space before a line starts an option ("Audible Alarm. ..."), whose later lines are indented.
    if (!fresh && sameCol && l.y - prev.y > 14.5) { fresh = true; hang = !indent; }
    // The next option of a list starts back at the margin.
    else if (!fresh && hang && !indent && prevIndent) fresh = true;
    // An indented first line starts an ordinary paragraph.
    else if (!fresh && indent && !hang) fresh = true;
    if (i === 0) hang = false;
    if (fresh) { cur = { text: '' }; paras.push(cur); }
    cur!.text = joinLine(cur!.text, l.text, hy);
  });
  // A short Title Case run-in ("Cantrip Upgrade.", "Audible Alarm.") is bold in the book.
  const runIn = (p: string) => p.replace(/^((?:[A-Z][\w’'-]*|of|a|an|the|and|or|to|in|on|with|for)(?: (?:[A-Z][\w’'-]*|of|a|an|the|and|or|to|in|on|with|for)){0,6}\.)\s/, (m, h) => (h.split(' ').length <= 7 && !/^(You|The|Each|If|When|Until|While|As|This|That|On|For|In|Choose|Make|A|An|It|Its|Any|One)\b/.test(h) ? `**${h}** ` : m));
  const out: string[] = [];
  for (let i = 0; i < paras.length; i++) {
    const p = paras[i];
    if (!p.cells) { out.push(runIn(p.text.trim()).replace(/^•\s*/, '- ')); continue; }
    // Consecutive rows make one Markdown table; a short line just above them is its heading.
    const rows: string[][] = [];
    while (i < paras.length && paras[i].cells) rows.push(paras[i++].cells!.map((c) => c.text.trim().replace(/\|/g, '/')));
    i--;
    const width = Math.max(...rows.map((r) => r.length));
    const before = out[out.length - 1] ?? '';
    let head: string[];
    if (rows[0].length === width && rows.length > 1 && rows[0].every((c) => c.length < 30 && !/\.$/.test(c))) head = rows.shift()!;
    else if (before && before.length < 60 && !/[.:]$/.test(before) && !before.startsWith('**')) { out.pop(); const w = before.split(' '); head = width === 2 ? [w[0], w.slice(1).join(' ')] : [before, ...Array(width - 1).fill('')]; }
    else head = Array(width).fill('');
    const fill = (r: string[]) => [...r, ...Array(width - r.length).fill('')];
    out.push([`| ${fill(head).join(' | ')} |`, `|${Array(width).fill('---').join('|')}|`, ...rows.map((r) => `| ${fill(r).join(' | ')} |`)].join('\n'));
  }
  return out.filter(Boolean).join('\n\n');
}

async function pdf(): Promise<string> {
  const p = opt('--pdf');
  if (p) return p;
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'alx-srd-')), 'SRD_CC_v5.2.1.pdf');
  const r = await fetch(PDF_URL);
  if (!r.ok) throw new Error(`${PDF_URL}: HTTP ${r.status}`);
  fs.writeFileSync(tmp, Buffer.from(await r.arrayBuffer()));
  return tmp;
}

async function main() {
  const file = await pdf();
  const first = Number(opt('--first') ?? 100), last = Number(opt('--last') ?? 180);
  const xhtml = execFileSync('pdftotext', ['-f', String(first), '-l', String(last), '-bbox-layout', file, '-'], { maxBuffer: 256 * 1024 * 1024 }).toString('utf8');
  const lines = readLines(xhtml, first);
  const hy = hyphenWords(lines);
  const raw = splitSpells(lines);
  const spells: Spell[] = [];
  const problems: string[] = [];
  for (const r of raw) {
    const head = r.head.map((x) => x.text).join(' ');
    const m = head.match(/^(?:Level ([1-9]) (\w+)|(\w+) Cantrip) \(([^)]*)\)/);
    if (!m) { problems.push(`${r.name}: no level line`); continue; }
    for (const f of ['Casting Time', 'Range', 'Components', 'Duration']) if (!r.fields[f]) problems.push(`${r.name}: no ${f}`);
    const text = paragraphs(r.text, hy);
    const s = normalizeSpell({
      name: r.name, level: m[1] ? Number(m[1]) : 0, school: m[2] ?? m[3], classes: m[4].split(',').map((x) => x.trim()),
      castingTime: r.fields['Casting Time'], range: r.fields.Range, components: r.fields.Components, duration: r.fields.Duration, text,
    }, 'SRD 5.2.1');
    spells.push({ id: `srd:${slug(s.name)}`, ...s });
  }
  const ids = new Set<string>();
  for (const s of spells) { if (ids.has(s.id)) problems.push(`duplicate ${s.id}`); ids.add(s.id); }
  if (problems.length) console.error(problems.join('\n'));
  if (spells.length < 300) throw new Error(`only ${spells.length} spells found; the PDF layout may have changed`);
  const doc = { id: 'srd-5.2.1', name: 'System Reference Document 5.2.1', version: '5.2.1', license: 'CC-BY-4.0', attribution: ATTRIBUTION, source: PDF_URL, spells };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(doc, null, 1) + '\n');
  console.log(`${spells.length} spells -> ${path.relative(process.cwd(), OUT)}${problems.length ? ` (${problems.length} warnings)` : ''}`);
}

await main();

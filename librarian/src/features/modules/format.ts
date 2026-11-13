// The module format (see docs/MODULES.md): a named set of game terms
// (spells, conditions, monsters, rules ...). This file validates and
// normalises one, whatever importer produced it.
import { HttpError } from '../../core/util.ts';

export const KINDS = ['spell', 'condition', 'monster', 'rule', 'item', 'action', 'class', 'other'] as const;
export type Kind = (typeof KINDS)[number];

export interface Term {
  id: string;
  term: string;
  aliases: string[];
  kind: Kind;
  summary: string;
  text: string;
  data?: unknown;
}

export interface ModuleDoc {
  id: string;
  name: string;
  version: string;
  license: string;
  attribution: string;
  terms: Term[];
}

export const LIMITS = {
  terms: 20_000,
  textChars: 60_000,
  totalChars: 24_000_000,
  summaryChars: 300,
  aliases: 30,
  dataChars: 40_000,
  nameChars: 120,
};

export const slug = (s: string): string =>
  s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);

export function asKind(v: unknown): Kind {
  const s = String(v ?? '').trim().toLowerCase();
  if ((KINDS as readonly string[]).includes(s)) return s as Kind;
  const alias: Record<string, Kind> = { spells: 'spell', conditions: 'condition', monsters: 'monster', creature: 'monster', creatures: 'monster', rules: 'rule', items: 'item', 'magic item': 'item', equipment: 'item', actions: 'action', classes: 'class', feature: 'class', 'class feature': 'class' };
  return alias[s] ?? 'other';
}

/** First sentence(s) of Markdown, as plain text, at most `max` characters. */
export function summarize(text: string, max = LIMITS.summaryChars): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^#{1,6}\s+.*$/gm, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, a, b) => b || a)
    .replace(/[*_`>|]/g, '')
    .replace(/^\s*[-+]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  return clip(plain, max);
}

export function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:]+$/, '') + '…';
}

function text(v: unknown, field: string, max: number): string {
  if (v === undefined || v === null) return '';
  if (Array.isArray(v)) return text(v.map(String).join('\n\n'), field, max);
  if (typeof v !== 'string' && typeof v !== 'number') throw new HttpError(400, `${field} must be text`);
  const s = String(v);
  return s.length > max ? s.slice(0, max) : s;
}

/** Validate and normalise a module. Bad terms are skipped with a warning, not fatal. */
export function normalizeModule(raw: any, defaults: Partial<ModuleDoc> = {}): { module: ModuleDoc; warnings: string[] } {
  if (!raw || typeof raw !== 'object') throw new HttpError(400, 'The module must be a JSON object');
  const warnings: string[] = [];
  const name = text(raw.name ?? defaults.name, 'name', LIMITS.nameChars).trim();
  if (!name) throw new HttpError(400, 'The module needs a name');
  const id = slug(text(raw.id ?? defaults.id ?? name, 'id', 120)) || slug(name);
  if (!id) throw new HttpError(400, 'The module needs an id');
  const list: unknown = raw.terms;
  if (!Array.isArray(list)) throw new HttpError(400, 'The module needs a terms list');
  if (list.length > LIMITS.terms) throw new HttpError(413, `A module can have at most ${LIMITS.terms} terms`);
  const terms: Term[] = [];
  const seen = new Set<string>();
  let total = 0;
  list.forEach((t: any, i: number) => {
    if (!t || typeof t !== 'object') { warnings.push(`Term ${i + 1} is not an object; skipped`); return; }
    const term = text(t.term ?? t.name, 'term', LIMITS.nameChars).trim();
    if (!term) { warnings.push(`Term ${i + 1} has no name; skipped`); return; }
    const kind = asKind(t.kind);
    let tid = slug(text(t.id, 'id', 120)) || `${kind}-${slug(term)}`;
    if (!tid) tid = `term-${i + 1}`;
    for (let n = 2; seen.has(tid); n++) tid = `${tid.replace(/-\d+$/, '')}-${n}`;
    seen.add(tid);
    const body = text(t.text, 'text', LIMITS.textChars);
    const summary = clip(text(t.summary, 'summary', 5000).trim(), LIMITS.summaryChars) || summarize(body);
    const aliases = (Array.isArray(t.aliases) ? t.aliases : typeof t.aliases === 'string' ? t.aliases.split(',') : [])
      .map((a: unknown) => String(a ?? '').trim()).filter((a: string) => a && a.length <= LIMITS.nameChars).slice(0, LIMITS.aliases);
    let data: unknown;
    if (t.data !== undefined && t.data !== null) {
      const j = JSON.stringify(t.data);
      if (j.length <= LIMITS.dataChars) data = t.data;
      else warnings.push(`${term}: data is too large and was dropped`);
    }
    total += body.length + summary.length + term.length + (data === undefined ? 0 : JSON.stringify(data).length);
    if (total > LIMITS.totalChars) throw new HttpError(413, 'The module is too large');
    terms.push({ id: tid, term, aliases, kind, summary, text: body, ...(data === undefined ? {} : { data }) });
  });
  if (!terms.length) throw new HttpError(400, 'The module has no usable terms');
  return {
    module: {
      id,
      name,
      version: text(raw.version ?? defaults.version ?? '', 'version', 40).trim(),
      license: text(raw.license ?? defaults.license ?? '', 'license', 200).trim(),
      attribution: text(raw.attribution ?? defaults.attribution ?? '', 'attribution', 2000).trim(),
      terms,
    },
    warnings,
  };
}

export function preview(m: ModuleDoc, warnings: string[]) {
  const counts: Record<string, number> = {};
  for (const t of m.terms) counts[t.kind] = (counts[t.kind] ?? 0) + 1;
  // Five samples spread over the kinds present, not five of the same.
  const byKind = new Map<string, Term[]>();
  for (const t of m.terms) { const a = byKind.get(t.kind) ?? []; a.push(t); byKind.set(t.kind, a); }
  const samples: Pick<Term, 'term' | 'kind' | 'summary'>[] = [];
  for (let round = 0; samples.length < 5 && round < 5; round++) {
    for (const a of byKind.values()) if (a[round] && samples.length < 5) samples.push({ term: a[round].term, kind: a[round].kind, summary: a[round].summary });
  }
  return {
    module: { id: m.id, name: m.name, version: m.version, license: m.license, attribution: m.attribution },
    total: m.terms.length,
    counts,
    samples,
    warnings: warnings.slice(0, 20),
  };
}

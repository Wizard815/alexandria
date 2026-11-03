// A small YAML-subset reader for Markdown frontmatter, the kind Obsidian,
// Lokus and Otterly vaults write: scalars, [inline, lists], "- item" lists,
// and nested maps by indentation. Anything fancier is kept as plain text.

export type FMValue = string | number | boolean | null | FMValue[] | { [k: string]: FMValue };
export type FM = { [k: string]: FMValue };

export function splitFrontmatter(md: string): { fm: FM; body: string } {
  const text = md.replace(/^﻿/, '');
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { fm: {}, body: text };
  return { fm: parseYaml(m[1]), body: text.slice(m[0].length) };
}

function scalar(raw: string): FMValue {
  const s = raw.trim();
  if (s === '' || s === '~' || s === 'null') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    if (!inner) return [];
    // split on commas that are not inside [[wikilinks]] or quotes
    const out: string[] = [];
    let depth = 0, q = '', cur = '';
    for (const ch of inner) {
      if (q) { if (ch === q) q = ''; cur += ch; continue; }
      if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
      if (ch === '[') depth++;
      if (ch === ']') depth--;
      if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
      cur += ch;
    }
    out.push(cur);
    return out.map((x) => scalar(x));
  }
  return s;
}

type Line = { indent: number; text: string };

export function parseYaml(src: string): FM {
  const lines: Line[] = src
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '' && !l.trim().startsWith('#'))
    .map((l) => ({ indent: l.length - l.trimStart().length, text: l.trim() }));
  let i = 0;

  function block(indent: number): FMValue {
    if (i < lines.length && (lines[i].text.startsWith('- ') || lines[i].text === '-')) {
      const arr: FMValue[] = [];
      while (i < lines.length && lines[i].indent === indent && (lines[i].text.startsWith('- ') || lines[i].text === '-')) {
        const rest = lines[i].text.slice(1).trim();
        i++;
        if (rest === '' && i < lines.length && lines[i].indent > indent) arr.push(block(lines[i].indent));
        else if (/^[^\s"'\[][^:]*:\s/.test(rest) || /^[^\s"'\[][^:]*:$/.test(rest)) {
          // "- key: value" starts a map item
          const obj: { [k: string]: FMValue } = {};
          const [k, v] = kv(rest);
          obj[k] = v;
          if (i < lines.length && lines[i].indent > indent) Object.assign(obj, block(lines[i].indent) as object);
          arr.push(obj);
        } else arr.push(scalar(rest));
      }
      return arr;
    }
    const obj: { [k: string]: FMValue } = {};
    while (i < lines.length && lines[i].indent === indent) {
      const line = lines[i].text;
      const idx = line.indexOf(':');
      if (idx <= 0) { i++; continue; }
      const key = line.slice(0, idx).trim().replace(/^["']|["']$/g, '');
      const rest = line.slice(idx + 1);
      i++;
      if (rest.trim() === '' && i < lines.length && (lines[i].indent > indent || lines[i].text.startsWith('- '))) {
        obj[key] = block(lines[i].indent);
      } else obj[key] = scalar(rest);
    }
    return obj;
  }

  function kv(text: string): [string, FMValue] {
    const idx = text.indexOf(':');
    return [text.slice(0, idx).trim(), scalar(text.slice(idx + 1))];
  }

  const out = lines.length ? block(lines[0].indent) : {};
  return out && typeof out === 'object' && !Array.isArray(out) ? (out as FM) : {};
}

function dumpScalar(v: FMValue): string {
  if (v === null) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = String(v);
  return /^[\w .,'()/-]*$/.test(s) && s.trim() === s && s !== '' && !/^(true|false|null|-?\d)/.test(s) ? s : JSON.stringify(s);
}

export function dumpYaml(v: FM, indent = 0): string {
  const pad = ' '.repeat(indent);
  return Object.entries(v)
    .map(([k, val]) => {
      if (Array.isArray(val)) {
        if (val.every((x) => x === null || typeof x !== 'object')) return `${pad}${k}: [${val.map(dumpScalar).join(', ')}]`;
        return `${pad}${k}:\n` + val.map((x) => (x && typeof x === 'object' && !Array.isArray(x) ? `${pad}  -\n${dumpYaml(x as FM, indent + 4)}` : `${pad}  - ${dumpScalar(x)}`)).join('\n');
      }
      if (val && typeof val === 'object') return `${pad}${k}:\n${dumpYaml(val as FM, indent + 2)}`;
      return `${pad}${k}: ${dumpScalar(val)}`;
    })
    .join('\n');
}

export function joinFrontmatter(fm: FM, body: string): string {
  if (!Object.keys(fm).length) return body;
  return `---\n${dumpYaml(fm)}\n---\n${body}`;
}
